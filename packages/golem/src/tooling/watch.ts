import path from 'node:path';
import type { GolemConfig } from './config.js';
import { DEFAULT_CONTROLLER_SUFFIXES, DEFAULT_MODEL_SUFFIXES, errorMessage, isInsideDirectory, suffixPattern } from './generator-api.js';
import { changedPaths, InputPoller, RunBaseline } from './input-poller.js';
import { GeneratorSessionResources, runPipeline, strongestInputKind } from './pipeline.js';
import type { InputKind, PipelineState } from './pipeline.js';

/** The names a job reads as sources, and what they are: a path with one of these endings is a source whether or not a run has read it. */
function sourcePatterns(config: GolemConfig | undefined): readonly { readonly kind: 'models' | 'controllers'; readonly pattern: RegExp }[] {
  return (config?.jobs ?? []).flatMap(job => {
    // A job with a list of sources reads those and no others.
    if ((job.kind !== 'models' && job.kind !== 'controllers') || job.options.sources) return [];
    return [{ kind: job.kind, pattern: suffixPattern(job.options.suffixes ?? (job.kind === 'models' ? DEFAULT_MODEL_SUFFIXES : DEFAULT_CONTROLLER_SUFFIXES)) }];
  });
}

function pathKey(filename: string): string {
  const resolved = path.resolve(filename);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Owned outputs and every directory above them, so an input that is an
 * output or contains one is recognized with one lookup per input.
 */
export class OwnedOutputIndex {
  private readonly covered = new Set<string>();

  constructor(filenames: Iterable<string> = []) {
    for (const filename of filenames) this.add(filename);
  }

  add(filename: string): void {
    let current = pathKey(filename);
    while (!this.covered.has(current)) {
      this.covered.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  /** Whether the input is an owned output or a directory containing one. */
  covers(input: string): boolean {
    return this.covered.has(pathKey(input));
  }
}

/** The folder of a source outside the root, which a source added beside it joins; undefined for any other input. */
function outsideSourceFolder(root: string, sources: ReturnType<typeof sourcePatterns>, input: string): string | undefined {
  if (isInsideDirectory(root, input) || input.split(path.sep).includes('node_modules')) return undefined;
  return sources.some(source => source.pattern.test(path.basename(input))) ? path.dirname(input) : undefined;
}

/** What one watch polls between two runs. */
interface Watched {
  readonly root: string;
  readonly sources: ReturnType<typeof sourcePatterns>;
  /** The inputs it stats, by what reads them. */
  readonly kinds: ReadonlyMap<string, InputKind>;
  readonly poller: InputPoller;
}

/**
 * Serialized polling of specific inputs, including reads attempted by failed runs, and of the folders around them, so a source
 * added to one of them starts a run. A `session` from the first run of the same command is kept; the watch closes it when it
 * stops. Without one, the watch opens its own.
 */
export function watchPipeline(initial: PipelineState | string, reportError: (error: unknown) => void = error => { process.stderr.write(`${errorMessage(error)}\n`); }, session: GeneratorSessionResources = new GeneratorSessionResources()): () => void {
  let state = typeof initial === 'string' ? undefined : initial;
  const filename = path.resolve(typeof initial === 'string' ? initial : initial.config.configFile);
  let config = state?.config;
  let attempted = new Map<string, InputKind>();
  const owned = new OwnedOutputIndex(state?.owned);
  let retryFull = !state;
  let first = !state;
  let busy = false;
  let stopped = false;
  // Compiler processes stay warm between runs and close with the watch.
  const closeSession = (): void => {
    try { session[Symbol.dispose](); } catch (error) { reportError(error); }
  };
  // The inputs and folders to poll change only when a run ends, so they are worked out then and not at every tick.
  const watch = (): Watched => {
    const inputs = new Map<string, InputKind>(state?.inputs);
    for (const [input, kind] of attempted) inputs.set(input, strongestInputKind(inputs.get(input), kind));
    inputs.set(filename, 'config');
    const sources = sourcePatterns(config);
    const root = config ? path.dirname(config.tsconfig) : path.dirname(filename);
    const descend: string[] = [];
    if (config) {
      for (const job of config.jobs) {
        if (job.kind === 'controllers') {
          inputs.set(job.options.root, strongestInputKind(inputs.get(job.options.root), 'controllers'));
        } else if (job.kind === 'openapi') inputs.set(job.options.input, strongestInputKind(inputs.get(job.options.input), 'openapi'));
        if (job.kind !== 'models' && job.kind !== 'controllers') continue;
        const tsconfig = path.join(job.options.root, 'tsconfig.json');
        inputs.set(tsconfig, strongestInputKind(inputs.get(tsconfig), job.kind));
        // A job reads every source of its root; a controllers job reads `src`.
        if (!job.options.sources) descend.push(job.kind === 'models' ? job.options.root : path.join(job.options.root, 'src'));
      }
    }
    // A new output directory can have been observed as missing during module
    // resolution. Its creation is output work, not a source edit. Adding a
    // source beneath it is still seen: the poll lists the names around the inputs.
    const kinds = new Map([...inputs].filter(([input]) => !owned.covers(input)));
    // Generated outputs can contain model-named files; they are not model sources.
    const outputs = (config?.jobs ?? []).flatMap(job => job.kind === 'openapi' || job.kind === 'controllers' ? [job.options.output] : []);
    const outsideDirectories = new Set<string>();
    for (const input of kinds.keys()) {
      const folder = outsideSourceFolder(root, sources, input);
      if (folder !== undefined) outsideDirectories.add(folder);
    }
    const poller = new InputPoller(kinds.keys(), {
      root, outsideDirectories, descend,
      skipDescent: directory => outputs.some(output => isInsideDirectory(output, directory)),
    });
    return { root, sources, kinds, poller };
  };
  let watched = watch();
  let previous = watched.poller.snapshot();
  /** What reads a changed path: a polled input, or else a source that was added or removed. A name that is no source is not a change. */
  const kindOf = (input: string): InputKind | undefined => watched.kinds.get(input) ?? watched.sources.find(source => source.pattern.test(path.basename(input)))?.kind;
  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const before = watched.poller.snapshot();
      const paths = changedPaths(previous, before, input => owned.covers(input));
      const changed = paths.filter(input => kindOf(input) !== undefined);
      if (!first && !changed.length) {
        // Names that are no source are taken as seen, so they are not listed at every tick.
        if (paths.length) previous = before;
        return;
      }
      first = false;
      session.inputsChanged(changed);
      const modelOnly = !retryFull && changed.every(input => kindOf(input) === 'models');
      const baseline = new RunBaseline(before, watched.root);
      const latestAttempt = new Map<string, InputKind>();
      try {
        const next = await runPipeline(filename, {
          modelOnly, previous: state, session,
          ...(!retryFull ? { changedInputs: changed } : {}),
          onConfig: value => { config = value; },
          onInput: (input, kind) => {
            latestAttempt.set(input, strongestInputKind(latestAttempt.get(input), kind));
            baseline.observe(input);
            const folder = outsideSourceFolder(watched.root, watched.sources, input);
            if (folder !== undefined) baseline.observeFolder(folder);
          },
          onOwned: filenames => { for (const filename of filenames) owned.add(filename); },
        });
        state = next;
        config = next.config;
        retryFull = false;
        process.stdout.write('Generated configured outputs.\n');
      } catch (error) {
        retryFull = true;
        reportError(error);
      }
      attempted = latestAttempt;
      // Keep pre-read signatures so edits during work trigger the next serialized run.
      watched = watch();
      previous = baseline.settle(watched.poller.snapshot());
    } catch (error) { reportError(error); }
    finally {
      busy = false;
      if (stopped) closeSession();
    }
  };
  const timer = setInterval(() => { void tick(); }, 200);
  if (first) void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (!busy) closeSession();
  };
}
