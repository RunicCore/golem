import fs from 'node:fs';
import path from 'node:path';
import { contains } from './config.js';
import type { GolemConfig } from './config.js';
import { DEFAULT_CONTROLLER_SUFFIXES, DEFAULT_MODEL_SUFFIXES, discoverSources, errorMessage, hasErrorCode, suffixPattern } from './generator-api.js';
import { sharedFolderOf } from './shared-folder.js';
import { IncompatibleSharedCompanionError } from './outputs.js';
import { GeneratorSessionResources, runPipeline, strongestInputKind } from './pipeline.js';
import type { InputKind, PipelineState } from './pipeline.js';

function sourceCandidates(config: GolemConfig, kind: 'models' | 'controllers', known: ReadonlyMap<string, InputKind>): Set<string> {
  const found = new Set<string>();
  // Generated outputs can contain model-named files; they are not model sources.
  const outputs = config.jobs.flatMap(job => job.kind === 'openapi' || job.kind === 'controllers' ? [job.options.output] : []);
  const skip = (directory: string): boolean => outputs.some(output => contains(output, directory));
  for (const job of config.jobs) {
    if (job.kind !== kind) continue;
    found.add(path.join(job.options.root, 'tsconfig.json'));
    const suffixes = job.options.suffixes ?? (kind === 'models' ? DEFAULT_MODEL_SUFFIXES : DEFAULT_CONTROLLER_SUFFIXES);
    const sources = job.options.sources ?? discoverSources(path.join(job.options.root, 'src'), { source: suffixPattern(suffixes), ...(kind === 'models' ? { skip } : {}) });
    for (const source of sources) found.add(source);
    if (kind !== 'models' || job.options.sources !== undefined) continue;
    // A models job also generates the model files its tsconfig includes outside its root, such as a shared folder. The
    // last run recorded the files it read as inputs; the shared folder of each local source outside the root is scanned
    // whole, so a model file added beside them or in a new subfolder is a candidate too. A "shared folder" that holds
    // the project itself is the repository: only the directory of the source is scanned then.
    const pattern = suffixPattern(suffixes);
    const sharedFolders = new Set<string>();
    const inputOfDirectory = new Map<string, string>();
    for (const [input, inputKind] of known) {
      if (inputKind === 'models' && /(?<!\.d)\.[cm]?ts$/.test(input) && !input.split(path.sep).includes('node_modules') && !contains(job.options.root, input)) {
        inputOfDirectory.set(path.dirname(input), input);
      }
    }
    for (const [directory, input] of inputOfDirectory) {
      const folder = sharedFolderOf(input);
      sharedFolders.add(contains(folder, job.options.root) ? directory : folder);
    }
    for (const folder of sharedFolders) {
      // A folder inside another is scanned with it.
      if ([...sharedFolders].some(other => other !== folder && contains(other, folder))) continue;
      for (const source of discoverSources(folder, { source: pattern, skip })) found.add(source);
    }
  }
  return found;
}

/** Content signature of a watched path: `missing`, `directory` (a directory's mtime also moves on output writes), or mtime, ctime and size. */
export function signature(filename: string): string {
  try {
    // Most watched paths are failed module-resolution probes; avoid an exception per missing path.
    const stat = fs.statSync(filename, { throwIfNoEntry: false });
    if (!stat) return 'missing';
    // Source discovery scans model names. Directory mtimes also change on output writes.
    return stat.isDirectory() ? 'directory' : `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return 'missing';
    throw error;
  }
}
interface Fingerprint { readonly kind: InputKind; readonly signature: string }

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

/**
 * Serialized polling of specific inputs, including reads attempted by failed runs. A `session` from the first run of the same
 * command is kept, with the locks it holds; the watch closes it when it stops. Without one, the watch opens its own.
 */
export function watchPipeline(initial: PipelineState | string, reportError: (error: unknown) => void = error => { process.stderr.write(`${errorMessage(error)}\n`); }, session: GeneratorSessionResources = new GeneratorSessionResources('process')): () => void {
  let state = typeof initial === 'string' ? undefined : initial;
  const filename = path.resolve(typeof initial === 'string' ? initial : initial.config.configFile);
  let config = state?.config;
  let attempted = new Map<string, InputKind>();
  // Shared companions that another process writes and this one found different: a change to one starts the next run, which compares again.
  let awaited = new Set<string>();
  const owned = new OwnedOutputIndex(state?.owned);
  let retryFull = !state;
  let first = !state;
  let busy = false;
  let stopped = false;
  // Compiler processes stay warm between runs and close with the watch.
  const closeSession = (): void => {
    try { session[Symbol.dispose](); } catch (error) { reportError(error); }
  };
  const fingerprints = (): Map<string, Fingerprint> => {
    const inputs = new Map<string, InputKind>(state?.inputs);
    for (const [input, kind] of attempted) inputs.set(input, strongestInputKind(inputs.get(input), kind));
    inputs.set(filename, 'config');
    if (config) {
      for (const job of config.jobs) {
        if (job.kind === 'controllers') {
          inputs.set(job.options.root, strongestInputKind(inputs.get(job.options.root), 'controllers'));
        } else if (job.kind === 'openapi') inputs.set(job.options.input, strongestInputKind(inputs.get(job.options.input), 'openapi'));
      }
      for (const source of sourceCandidates(config, 'controllers', inputs)) inputs.set(source, strongestInputKind(inputs.get(source), 'controllers'));
      for (const source of sourceCandidates(config, 'models', inputs)) inputs.set(source, strongestInputKind(inputs.get(source), 'models'));
    }
    // A new output directory can have been observed as missing during module
    // resolution. Its creation is output work, not a source edit. Discovery
    // still scans model filenames, so adding a source beneath it is visible.
    const watched = new Map([...inputs].filter(([input]) => !owned.covers(input))
      .map(([input, kind]) => [input, { kind, signature: signature(input) }]));
    for (const companion of awaited) watched.set(companion, { kind: 'models', signature: signature(companion) });
    return watched;
  };
  let previous = fingerprints();
  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const before = fingerprints();
      const changed = [...new Set([...previous.keys(), ...before.keys()])].filter(input => previous.get(input)?.signature !== before.get(input)?.signature);
      if (!first && !changed.length) return;
      first = false;
      session.inputsChanged(changed);
      const modelOnly = !retryFull && changed.every(input => (before.get(input) ?? previous.get(input))?.kind === 'models');
      const observed = new Map<string, Fingerprint>();
      const latestAttempt = new Map<string, InputKind>();
      try {
        const next = await runPipeline(filename, {
          modelOnly, previous: state, session,
          ...(!retryFull ? { changedInputs: changed } : {}),
          onConfig: value => { config = value; },
          onInput: (input, kind) => {
            latestAttempt.set(input, strongestInputKind(latestAttempt.get(input), kind));
            if (!observed.has(input)) observed.set(input, { kind, signature: signature(input) });
          },
          onOwned: filenames => { for (const filename of filenames) owned.add(filename); },
        });
        state = next;
        config = next.config;
        retryFull = false;
        awaited = new Set();
        process.stdout.write('Generated configured outputs.\n');
      } catch (error) {
        retryFull = true;
        if (error instanceof IncompatibleSharedCompanionError) awaited.add(error.filename);
        reportError(error);
      }
      attempted = latestAttempt;
      // Keep pre-read signatures so edits during work trigger the next serialized run.
      previous = new Map([...fingerprints()].map(([input, value]) => [input, before.get(input) ?? observed.get(input) ?? value]));
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
