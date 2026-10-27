import fs from 'node:fs';
import path from 'node:path';

/**
 * The record of one tier on one tree, kept so a run that the tier ceiling cut is finished by a rerun, and a tree that passed is
 * not run again. `entrypoint.sh` sets GOLEM_RUN_KEY (a hash of the tier, the source tree, the runner image, the Linux lockfile
 * slot and the denied-text rules) and GOLEM_RUN_STATE (the folder in the cache volume, beside `packed/`), so a new checkout or
 * worktree of the same tree finds the record too. A changed tree, image or lockfile is another key and starts from zero.
 */
export interface RunPart { readonly at: string; readonly result: 'cut' | 'passed' | 'failed'; readonly seconds: number }
/** `passed` holds the seconds of each file (by source path) that ended with every test passing; `ended` is true when the step ended with status 0. */
export interface StepRecord { passed: Record<string, number>; ended: boolean }
export interface RunRecord { steps: Record<string, StepRecord>; parts: RunPart[] }

export interface RunState {
  readonly recordFile: string;
  readonly passedFile: string;
  /** `--again`: ignore and replace the record. */
  readonly again: boolean;
  /** The first characters of the tree hash, for the lines the runner prints. */
  readonly tree: string;
}

/** Undefined for a run that keeps no record: no key (focused, docs, native) or no results folder. */
export function runStateFromEnv(env: NodeJS.ProcessEnv = process.env): RunState | undefined {
  const { GOLEM_RUN_KEY: key, GOLEM_RUN_STATE: dir, GOLEM_RUN_TREE: tree } = env;
  if (!key || !dir || !env.FE_DEPS_RESULTS_DIR) return undefined;
  return { recordFile: path.join(dir, `${key}.json`), passedFile: path.join(dir, `${key}.passed`), again: env.GOLEM_RUN_AGAIN === '1', tree: (tree ?? key).slice(0, 8) };
}

const emptyRecord = (): RunRecord => ({ steps: {}, parts: [] });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Throws a SyntaxError that names the first field that is not what a record holds. */
function assertRecord(record: unknown): asserts record is RunRecord {
  if (!isObject(record) || !isObject(record.steps) || !Array.isArray(record.parts)) throw new SyntaxError('not a run record: it needs steps and parts');
  for (const [label, step] of Object.entries(record.steps)) {
    if (!isObject(step) || typeof step.ended !== 'boolean' || !isObject(step.passed) || !Object.values(step.passed).every(seconds => typeof seconds === 'number')) {
      throw new SyntaxError(`step '${label}' needs ended (a boolean) and passed (the seconds of each file)`);
    }
  }
  for (const part of record.parts) {
    if (!isObject(part) || typeof part.at !== 'string' || typeof part.seconds !== 'number' || !['cut', 'passed', 'failed'].includes(part.result as string)) throw new SyntaxError('a part needs at, result and seconds');
  }
}

/** A missing record is normal. One that cannot be read or has the wrong shape is reported and ignored: the run starts from zero, never skips on a guess. */
export function readRecord(file: string): RunRecord | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const record: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertRecord(record);
    return record;
  } catch (error) {
    process.stderr.write(`Could not read the run record ${file} (${error instanceof Error ? error.message : String(error)}); the run starts from zero.\n`);
    return undefined;
  }
}

/** Written whole through a temporary file, so a kill never leaves half a record or marker. */
function writeWhole(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * Adds what the results folder holds to the record: the files that ended passed (`<step>.files.jsonl`) and the steps that
 * ended with status 0 (`<tier>-timings.json`). A step that the ceiling cut keeps its finished files. A line that a kill cut short is
 * skipped; that file runs again, so a lost line costs time and never a wrong pass.
 */
export function foldResults(record: RunRecord, resultsDir: string, tier: string): RunRecord {
  const steps = structuredClone(record.steps);
  const step = (label: string): StepRecord => (steps[label] ??= { passed: {}, ended: false });
  for (const name of fs.readdirSync(resultsDir).filter(entry => entry.endsWith('.files.jsonl'))) {
    const label = name.slice(0, -'.files.jsonl'.length);
    for (const line of fs.readFileSync(path.join(resultsDir, name), 'utf8').split('\n').filter(Boolean)) {
      try {
        const { file, seconds, passed } = JSON.parse(line) as { file: string; seconds?: number; passed?: boolean };
        if (passed === true && typeof seconds === 'number') step(label).passed[file] = seconds;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        process.stderr.write(`Skipped a malformed test file line at ${name}; that file runs again.\n`);
      }
    }
  }
  const timingsFile = path.join(resultsDir, `${tier}-timings.json`);
  if (fs.existsSync(timingsFile)) {
    // A timings file that cannot be read ends no step: the steps run again, which costs time and never gives a wrong pass.
    try {
      const { timings } = JSON.parse(fs.readFileSync(timingsFile, 'utf8')) as { timings?: unknown };
      if (!Array.isArray(timings)) throw new SyntaxError('no timings list');
      for (const entry of timings as { label: string; status: number }[]) if (entry.status === 0) step(entry.label).ended = true;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      process.stderr.write(`Could not read ${timingsFile} (${error.message}); no step of this run counts as ended.\n`);
    }
  }
  return { steps, parts: record.parts };
}

const describePart = ({ result, seconds, at }: RunPart): string => `${result} after ${seconds}s at ${at}`;

/** The first line of a resume: what the earlier cut run left done. Undefined when nothing finished. */
export function describeResume(record: RunRecord, state: RunState): string | undefined {
  const done = Object.entries(record.steps).filter(([, step]) => step.ended || Object.keys(step.passed).length);
  if (!done.length) return undefined;
  const parts = done.map(([label, step]) => step.ended ? `${label} (whole step)` : `${label} (${Object.keys(step.passed).length} files)`).join(', ');
  return `resuming the cut run on tree ${state.tree} from ${state.recordFile} (${record.parts.map(describePart).join('; ')}); done: ${parts}`;
}

/** Called by `entrypoint.sh` when the ceiling stopped the tier: keeps what the cut run finished for the rerun. */
export function recordCut(resultsDir: string, tier: string, seconds: number, env: NodeJS.ProcessEnv = process.env): string {
  const state = runStateFromEnv(env);
  if (!state) return `The ${tier} tier keeps no record of a cut run.`;
  const base = state.again ? emptyRecord() : readRecord(state.recordFile) ?? emptyRecord();
  const record = foldResults(base, resultsDir, tier);
  record.parts.push({ at: new Date().toISOString(), result: 'cut', seconds });
  writeWhole(state.recordFile, JSON.stringify(record) + '\n');
  const files = Object.values(record.steps).reduce((sum, step) => sum + Object.keys(step.passed).length, 0);
  return `Kept ${files} passed files and ${Object.values(record.steps).filter(step => step.ended).length} ended steps of the cut ${tier} run in ${state.recordFile}. Run the same command again to finish it.`;
}

/** What a step of the tier needs to count as having a result: its files (a step that runs test files) or its end. */
export interface PlannedStep { readonly label: string; readonly files: readonly string[] | undefined }

/**
 * Ends a run: adds its results to the record and returns the summary line. When no step failed and every file of every
 * step has a pass in the record, the line starts `<tier> complete`, the tree has passed (the marker file lets a rerun skip it)
 * and the record is dropped. A failed run drops the record too: a changed tree starts from zero, and a file that failed is
 * run again in a rerun on the same tree.
 */
export function finishRun(state: RunState, base: RunRecord | undefined, plan: readonly PlannedStep[], resultsDir: string, tier: string, failed: boolean, seconds: number): string {
  const folded = foldResults(state.again ? emptyRecord() : base ?? emptyRecord(), resultsDir, tier);
  const record = { ...folded, parts: [...(state.again ? [] : base?.parts ?? []), { at: new Date().toISOString(), result: failed ? 'failed' as const : 'passed' as const, seconds }] };
  const missing = plan.flatMap(({ label, files }) => {
    const step = record.steps[label];
    if (files === undefined) return step?.ended ? [] : [label];
    const passed = new Set(Object.keys(step?.passed ?? {}));
    const left = files.filter(file => !passed.has(file));
    return left.length ? [`${label} (${left.length} of ${files.length} files)`] : [];
  });
  const parts = record.parts.map(describePart).join('; ');
  if (failed) {
    fs.rmSync(state.recordFile, { force: true });
    return `${tier} incomplete: a step failed; parts: ${parts}`;
  }
  if (missing.length) {
    writeWhole(state.recordFile, JSON.stringify(record) + '\n');
    return `${tier} incomplete: no result yet for ${missing.join(', ')}; parts: ${parts}`;
  }
  const covered = plan.map(({ label, files }) => files === undefined ? label : `${label} ${files.length}/${files.length} files`).join(', ');
  // The result folder holds only the last part's timings; this file adds the seconds of every part, a file that two steps run counting both.
  const fileSeconds: Record<string, number> = {};
  for (const { passed } of Object.values(record.steps)) for (const [file, seconds] of Object.entries(passed)) fileSeconds[file] = Math.round(((fileSeconds[file] ?? 0) + seconds) * 10) / 10;
  writeWhole(path.join(resultsDir, `${tier}-complete.json`), JSON.stringify({ tier, parts: record.parts, file_seconds: fileSeconds }, null, 2) + '\n');
  const line = `${tier} complete: ${covered}; parts: ${parts}; the seconds of each file over all parts are in ${tier}-complete.json in the results folder`;
  writeWhole(state.passedFile, `${line}\n`);
  fs.rmSync(state.recordFile, { force: true });
  return line;
}
