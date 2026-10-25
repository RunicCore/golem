import path from 'node:path';
import type { GolemConfig } from './config.js';
import { DEFAULT_CONTROLLER_SUFFIXES, DEFAULT_MODEL_SUFFIXES, errorMessage, isInsideDirectory, suffixPattern } from './generator-api.js';
import { changedPaths, InputScan, InputWatcher, outsideFolder, OwnedOutputIndex, realInputFiles, RunBaseline } from './input-watcher.js';
import type { InputFiles } from './input-watcher.js';
import { realOutputFiles } from './outputs.js';
import type { OutputFiles } from './outputs.js';
import { GeneratorSessionResources, jobFailedBeforeWriting, runPipeline, strongestInputKind } from './pipeline.js';
import type { InputKind, JobReport, PipelineState } from './pipeline.js';

/** The names a job reads as sources, and what they are: a path with one of these endings is a source whether or not a run has read it. */
function sourcePatterns(config: GolemConfig | undefined): readonly { readonly kind: 'models' | 'controllers'; readonly pattern: RegExp }[] {
  return (config?.jobs ?? []).flatMap(job => {
    // A job with a list of sources reads those and no others.
    if ((job.kind !== 'models' && job.kind !== 'controllers') || job.options.sources) return [];
    return [{ kind: job.kind, pattern: suffixPattern(job.options.suffixes ?? (job.kind === 'models' ? DEFAULT_MODEL_SUFFIXES : DEFAULT_CONTROLLER_SUFFIXES)) }];
  });
}

/** Records an input a run reads: its signature and the folders around it, as they are when the run first reads them. */
function observeInput(baseline: RunBaseline, root: string, input: string): void {
  baseline.observe(input);
  const folder = outsideFolder(root, input);
  if (folder !== undefined) baseline.observeFolder(folder);
}

/**
 * What a run that the caller makes before it starts the watch reads first. Pass `onInput` to that run and `baseline` to
 * `watchPipeline`: a source added during the run then starts the watch's first run.
 */
export function baselineBeforeRun(configFile: string): { readonly baseline: RunBaseline; readonly onInput: (input: string) => void } {
  const resolved = path.resolve(configFile);
  const root = path.dirname(resolved);
  const before = new InputScan([resolved], { root }).snapshot();
  const baseline = new RunBaseline(before, root);
  return { baseline, onInput: input => { observeInput(baseline, root, input); } };
}

/** What one watch looks at between two runs. */
interface Watched {
  readonly root: string;
  readonly sources: ReturnType<typeof sourcePatterns>;
  /** The inputs it reads, by what reads them. */
  readonly kinds: ReadonlyMap<string, InputKind>;
  readonly scan: InputScan;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

function describeReport(report: JobReport | undefined): string {
  const parts = [
    ...(report?.written.length ? [`${plural(report.written.length, 'file')} updated`] : []),
    ...(report?.removed.length ? [`${report.removed.length} removed`] : []),
  ];
  return parts.length ? parts.join(', ') : 'unchanged';
}

/** The line one good watch run prints: the result of each job, a job that did not run or wrote nothing as `unchanged`, then the time of the run. */
export function summarizeRun(state: PipelineState, ms: number): string {
  const jobs = state.config.jobs.map(job => `${job.id.replace(/:\.$/, '')}: ${describeReport(state.reports.get(job.id))}`);
  if (state.retired.length) jobs.push(`removed jobs: ${plural(state.retired.length, 'file')} removed`);
  return [...jobs, `${ms} ms`].join(' · ');
}

/** What a caller passes to `watchPipeline` besides the config and the error report; each field is optional. */
export interface WatchOptions {
  /** A `session` from the first run of the same command is kept; the watch closes it when it stops. Without one, the watch opens its own. */
  readonly session?: GeneratorSessionResources;
  /** The first comparison is with this, taken before the run that made the state (`baselineBeforeRun`), else with the disk as it is now. */
  readonly firstBaseline?: RunBaseline;
  /** Called once when not one folder can be watched: the watch has stopped. */
  readonly onUnwatchable?: () => void;
  /** Called with the line of each good run. */
  readonly onRun?: (line: string) => void;
  /** The file-system calls of the watch and of its runs' output writes: internal, for tests that fault or count them. */
  readonly files?: Partial<InputFiles> & Partial<OutputFiles>;
}

/**
 * Serialized runs on file-system events for specific inputs, including reads attempted by failed runs, and for the folders around
 * them, so a source added to one of them starts a run. An event only wakes the watch: it then compares the inputs with what the last
 * run left. A package manager's install starts a full run. With a `PipelineState`, the first comparison is with
 * `options.firstBaseline`. A failure to watch goes to `reportError` once; the watch goes on unless not one folder can be watched: then
 * it stops, and `options.onUnwatchable` is called. `options.onRun` gets the line of each good run (`summarizeRun`, with `Recovered: `
 * before it after a failed run) once the watch has recorded what the run read. The watch prints nothing about its runs; the caller
 * says it. An exception from `onRun` goes to `reportError`, and the watch goes on.
 */
export function watchPipeline(initial: PipelineState | string, reportError: (error: unknown) => void = error => { process.stderr.write(`${errorMessage(error)}\n`); }, options: WatchOptions = {}): () => void {
  const { session = new GeneratorSessionResources(), firstBaseline, onUnwatchable = () => {}, onRun = () => {} } = options;
  const inputFiles: InputFiles = { ...realInputFiles, ...options.files };
  const outputFiles: OutputFiles = { ...realOutputFiles, ...options.files };
  let state = typeof initial === 'string' ? undefined : initial;
  const filename = path.resolve(typeof initial === 'string' ? initial : initial.config.configFile);
  let config = state?.config;
  let attempted = new Map<string, InputKind>();
  const owned = new OwnedOutputIndex(state?.owned);
  let retryFull = !state;
  let first = !state;
  let busy = false;
  let stopped = false;
  const watcher = new InputWatcher({ root: () => watched.root, tick: installed => tick(installed), onError: reportError, files: inputFiles,
    onUnwatchable: () => {
      // It can come while the watch is built, before it can return its stop.
      stopped = true;
      watcher.close();
      if (!busy) closeSession();
      queueMicrotask(onUnwatchable);
    },
  });
  // The last run failed: the next good run says it recovered.
  let failed = false;
  // Compiler processes stay warm between runs and close with the watch.
  const closeSession = (): void => {
    try { session[Symbol.dispose](); } catch (error) { reportError(error); }
  };
  // The inputs and folders to scan change only when a run ends, so they are worked out then and not at every tick.
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
    // source beneath it is still seen: the scan lists the names around the inputs.
    const kinds = new Map([...inputs].filter(([input]) => !owned.covers(input)));
    // Generated outputs can contain model-named files; they are not model sources.
    const outputs = (config?.jobs ?? []).flatMap(job => job.kind === 'openapi' || job.kind === 'controllers' ? [job.options.output] : []);
    const scan = new InputScan(kinds.keys(), {
      root, descend,
      skipDescent: directory => outputs.some(output => isInsideDirectory(output, directory)),
    }, inputFiles);
    return { root, sources, kinds, scan };
  };
  let watched = watch();
  const firstSnapshot = watcher.snapshotWatching(watched.scan);
  let previous = firstBaseline?.settle(firstSnapshot) ?? firstSnapshot;
  /** What reads a changed path: an input, or else a source that was added or removed. A name that is no source is not a change. */
  const kindOf = (input: string): InputKind | undefined => watched.kinds.get(input) ?? watched.sources.find(source => source.pattern.test(path.basename(input)))?.kind;
  const tick = async (installed: boolean): Promise<void> => {
    if (stopped) return;
    busy = true;
    try {
      const before = watcher.snapshotWatching(watched.scan);
      const paths = changedPaths(previous, before, input => owned.covers(input));
      const changed = paths.filter(input => kindOf(input) !== undefined);
      // An install can change any package a job read: the run reads everything again.
      if (installed) retryFull = true;
      if (!first && !changed.length && !installed) {
        // Names that are no source are taken as seen, so they are not listed at every tick.
        if (paths.length) previous = before;
        return;
      }
      first = false;
      session.inputsChanged(changed);
      const modelOnly = !retryFull && changed.every(input => kindOf(input) === 'models');
      const baseline = new RunBaseline(before, watched.root);
      const latestAttempt = new Map<string, InputKind>();
      // The line of this run when it ended well, kept until the watch has recorded what the run read.
      let line: string | undefined;
      try {
        const started = performance.now();
        const next = await runPipeline(filename, {
          modelOnly, previous: state, session, files: outputFiles,
          ...(!retryFull ? { changedInputs: changed } : {}),
          onConfig: value => { config = value; },
          onInput: (input, kind) => {
            latestAttempt.set(input, strongestInputKind(latestAttempt.get(input), kind));
            observeInput(baseline, watched.root, input);
          },
          onOwned: filenames => { for (const filename of filenames) owned.add(filename); },
        });
        state = next;
        config = next.config;
        retryFull = false;
        line = `${failed ? 'Recovered: ' : ''}${summarizeRun(next, Math.round(performance.now() - started))}`;
        failed = false;
      } catch (error) {
        retryFull = true;
        failed = true;
        reportError(jobFailedBeforeWriting(error) ? new Error(`${errorMessage(error)}\nThe job that failed wrote no files; its last good output stays in place.`, { cause: error }) : error);
      }
      attempted = latestAttempt;
      // Keep pre-read signatures so edits during work trigger the next serialized run.
      watched = watch();
      previous = baseline.settle(watcher.snapshotWatching(watched.scan));
      if (line !== undefined) onRun(line);
    } catch (error) { reportError(error); }
    finally {
      busy = false;
      if (stopped) closeSession();
    }
  };
  // The first run, or the first look at what changed since the run that made the state.
  watcher.start();
  return () => {
    stopped = true;
    watcher.close();
    if (!busy) closeSession();
  };
}
