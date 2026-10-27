import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcePath } from './test-file-timings.js';
import { describeResume, finishRun, isTierResult, readRecord, runStateFromEnv, stepResultFile, type PlannedStep, type RunRecord } from './test-runner/run-state.js';
import type { OrderedRun } from './test-run-ordered.js';

export type Tier = 'prepare' | 'focused' | 'full' | 'acceptance' | 'docs';
/** `fileTimings` is the JSON-lines file that the test-file reporter fills while the step runs. */
/** `always`: the step runs again in a resume, because its result lives outside the run record (see `pack`). */
export interface Step { readonly label: string; readonly run: () => Promise<number>; readonly fileTimings?: string; readonly always?: true }
/** The steps of a chain run one after another. The chains of a group run at the same time; groups run in order. */
export type Group = readonly (readonly Step[])[];
/** Each step is a group of its own: the steps run in order. */
const inOrder = (...steps: readonly Step[]): Group[] => steps.map(step => [[step]]);

// The public-source and release-version tests stay in this step: the Acceptance tier's "public source" step and the pack
// step (test-pack, verify-package) run those scripts as release gates, and these tests hold their rejection cases.
export const UNIT_FILES = ['.build/tests/*.test.js', '.build/tests/openapi/*.test.js', '.build/tests/golem-ts-openapi/*.test.js'] as const;
// The model-only smoke file runs in Full; Acceptance runs the others so it runs once.
export const PACKED_FILES = ['.build/tests/packed/consumers.test.js', '.build/tests/packed/nest-workflows.test.js'] as const;
const SMOKE_FILE = '.build/tests/packed/model-only.test.js';
// The TypeScript 6 lane runs the test files whose first line is `// lane: typescript6 <the shim place the file proves>`, with
// GOLEM_TYPESCRIPT_ROOT at the container's TypeScript 6 install. The identity test (typescript-identity.acceptance, acceptance unit step: it generates the corpus on both versions, so Full leaves it out) proves that
// TypeScript 6 and 7 write the same bytes for its corpus and compiles that corpus once on TypeScript 6, so the lane reruns only
// the tests that reach a place of the TypeScript 6 shim that the identity test does not (typescript-ts6.ts, build.ts). A test
// file that reaches such a place carries the tag, so the lane cannot miss it.
const LANE_TAG = /^\/\/ lane: typescript6 \S/;
/** The compiled files of the tagged test sources under tests/, in path order. */
export function typescript6Files(): readonly string[] {
  const tagged = (file: string): boolean => {
    const descriptor = fs.openSync(path.join(root, file), 'r');
    try {
      const head = Buffer.alloc(200);
      const first = head.toString('utf8', 0, fs.readSync(descriptor, head, 0, head.length, 0)).split(/\r?\n/, 1)[0]!;
      if (first.startsWith('// lane:') && !LANE_TAG.test(first)) throw new Error(`${file}: the first line starts with \`// lane:\` but is not \`// lane: typescript6 <the shim place the file proves>\`, so the TypeScript 6 lane would skip the file.`);
      return LANE_TAG.test(first);
    } finally { fs.closeSync(descriptor); }
  };
  const files = (fs.readdirSync(path.join(root, 'tests'), { recursive: true }) as string[])
    .map(file => `tests/${file.split(path.sep).join('/')}`)
    .filter(file => file.endsWith('.test.ts') && !file.includes('/fixtures/') && tagged(file))
    .sort()
    .map(file => `.build/${file.replace(/\.ts$/, '.js')}`);
  if (!files.length) throw new Error('No test file carries the `// lane: typescript6` tag on its first line, so the TypeScript 6 lane has nothing to run.');
  return files;
}
// The docs tier checks the documentation: its prose rules and its page inventory read the markdown, not golem.
export const DOCS_FILES = ['.build/tests/docs-voice.site-test.js', '.build/tests/docs-structure.site-test.js'] as const;
export const BROWSER_FILES = ['.build/tests/browser/*.test.js'] as const;
// Unit-level tests too slow for Full are named *.acceptance.ts and run only in Acceptance.
export const ACCEPTANCE_UNIT_FILES = ['.build/tests/*.acceptance.js', '.build/tests/openapi/*.acceptance.js'] as const;
// Unit: 8 files at once peaked at 3.5 of 7.7 GiB (measured with the files in path order) and halved the unit step (136 s to
// 69 s), so the machine's parallelism is the only limit up to 8. Packed: Acceptance has two packed
// files, so two at once is the most that helps.
const UNIT_CAP = 8;
const PACKED_CAP = 2;
// Beside: the TypeScript 6 lane in Acceptance runs beside packed and browser. The lane alone peaks at 5.4 GiB of a 7.7 GiB VM
// (measured) and, with eight files at once, the esbuild of packed was OOM-killed, so the lane runs two files fewer: the memory
// headroom for packed and browser beside it.
export const CONCURRENCY = {
  unit: Math.min(UNIT_CAP, os.availableParallelism()),
  beside: Math.max(1, Math.min(UNIT_CAP, os.availableParallelism()) - 2),
  packed: Math.max(1, Math.min(PACKED_CAP, Math.floor(os.availableParallelism() / 2))),
} as const;

const tiers: Readonly<Record<Tier, { readonly budget: string; readonly purpose: string }>> = {
  prepare: { budget: '≤5 min (plus a first-time image build), network', purpose: 'Fill the npm, packed and typia plugin caches so tiers run offline.' },
  focused: { budget: '≤1 min', purpose: 'Did my change break what I touched?' },
  full: { budget: '≤5 min', purpose: 'Did I break anything anywhere?' },
  acceptance: { budget: '≤10 min, needs a stated reason', purpose: 'Is this releasable?' },
  docs: { budget: 'about 2 min', purpose: 'Do the docs pass their prose and inventory checks, and does the site build and pass its checks?' },
};

const RUNNER_FLAGS = ['--test-shard', '--test-timeout', '--test-concurrency', '--test-reporter'] as const;

export function selectFocused(args: readonly string[], lane6 = false): { readonly files: readonly string[]; readonly passThrough: readonly string[]; readonly needsPack: boolean } {
  const files: string[] = [];
  const passThrough: string[] = [];
  // A flag's separate value is the next argument unless that is a test file.
  const testFile = (value: string): boolean => value.startsWith('tests/') || value.startsWith('.build/') || /\.[cm]?[jt]s$/.test(value);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value.startsWith('--')) {
      const name = value.split('=')[0];
      // These set up the run itself, which this runner owns; dropping one would make a run look different from what it did.
      if (RUNNER_FLAGS.some(flag => name.startsWith(flag))) throw new Error(`${name} is not supported: the runner sets the reporters, the concurrency and the files of a step, and the tier ceiling is the time limit.`);
      passThrough.push(value);
      const next = args[index + 1];
      if (!value.includes('=') && next !== undefined && !next.startsWith('--') && !testFile(next)) passThrough.push(args[++index]);
    } else {
      files.push(value.startsWith('tests/') ? `.build/${value.replace(/\.ts$/, '.js')}` : value);
    }
  }
  if (!lane6 && !files.length && !passThrough.some(flag => flag.startsWith('--test-name-pattern'))) {
    throw new Error('Select test files or --test-name-pattern, for example: npm run test -- tests/serde.test.ts');
  }
  const selected = files.length ? files : [...(lane6 ? typescript6Files() : UNIT_FILES)];
  return { files: selected, passThrough, needsPack: selected.some(file => /\/tests\/(?:packed|browser)\//.test(file)) };
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const resultsDir = process.env.FE_DEPS_RESULTS_DIR;

function run(executable: string, args: readonly string[], cwd: string = root, env: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', status => resolve(status ?? 1));
  });
}

/** The seconds of each test file in the last runs of this tier, by step label. */
const recordedFileSeconds = new Map<string, Readonly<Record<string, number>>>();

/** What an earlier run of this tier on this tree left done (see run-state.ts); undefined for a run from zero. */
let resumed: RunRecord | undefined;
/** The files of each test step, by step label, whether or not this run starts them: the summary line counts them all. */
const stepFiles = new Map<string, readonly string[]>();
/** Steps that start only the files the earlier run did not finish. */
const resumedSteps = new Set<string>();

/**
 * The record of a tier lives in the shared cache volume (beside the packed dir), not in the checkout's results, so the first
 * run in a fresh checkout starts its files in the same order. A record from another branch only changes the order.
 */
function fileSecondsRecord(tier: Tier): string | undefined {
  const packedDir = process.env.FE_DEPS_PACKED_DIR;
  return packedDir ? path.join(path.dirname(packedDir), 'test-order', `${tier}.json`) : undefined;
}

/** Order is an optimization: a missing record is normal, and one that cannot be read is reported and ignored. */
function loadFileSeconds(file: string | undefined): void {
  if (!file || !fs.existsSync(file)) return;
  try {
    const record: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new SyntaxError('not an object of steps');
    for (const [label, seconds] of Object.entries(record)) recordedFileSeconds.set(label, seconds as Record<string, number>);
  } catch (error) {
    process.stderr.write(`Could not read the test file seconds at ${file} (${error instanceof Error ? error.message : String(error)}); the files run in path order.\n`);
    recordedFileSeconds.clear();
  }
}

/** Written whole through a temporary file, so a kill never leaves half a record. A failed write is reported; the run goes on. */
function saveFileSeconds(file: string | undefined): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(recordedFileSeconds)) + '\n');
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    process.stderr.write(`Could not save the test file seconds at ${file} (${error instanceof Error ? error.message : String(error)}); the next run may start its files in path order.\n`);
  }
}

/** Files with no record first, in path order (one of them may be the new slow file), then the recorded files, longest first. */
function longestFirst(files: readonly string[], recorded: Readonly<Record<string, number>> | undefined): { readonly ordered: string[]; readonly recordedCount: number } {
  const seconds = (file: string): number | undefined => {
    const value: unknown = recorded?.[sourcePath(path.resolve(root, file), root)];
    return typeof value === 'number' ? value : undefined;
  };
  const byPath = [...new Set(files)].sort();
  const unrecorded = byPath.filter(file => seconds(file) === undefined);
  const known = byPath.filter(file => seconds(file) !== undefined).sort((a, b) => (seconds(b) ?? 0) - (seconds(a) ?? 0));
  return { ordered: [...unrecorded, ...known], recordedCount: known.length };
}

/**
 * Lists the files of the patterns: a path, or a directory with `*` in the file name (`.build/tests/*.test.js`), the only forms
 * that the tiers and focused runs use. `fs.globSync` would do the same, but it prints an experimental warning on Node 22.
 * A pattern with no file is a fault of the selection, as in `node --test`.
 */
function expandFiles(patterns: readonly string[]): string[] {
  return patterns.flatMap(pattern => {
    const directory = path.posix.dirname(pattern);
    if (directory.includes('*')) throw new Error(`Put * in the file name only: '${pattern}'`);
    const name = new RegExp(`^${path.posix.basename(pattern).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    if (pattern.includes('*') && !fs.existsSync(path.resolve(root, directory))) {
      throw new Error(`The folder '${directory}' does not exist. For a compiled test folder (.build/...) the test build is missing or failed: run npm run build:tests.`);
    }
    const matches = pattern.includes('*')
      ? fs.readdirSync(path.resolve(root, directory), { withFileTypes: true }).filter(entry => entry.isFile() && name.test(entry.name)).map(entry => path.posix.join(directory, entry.name))
      : fs.existsSync(path.resolve(root, pattern)) ? [pattern] : [];
    if (!matches.length) throw new Error(`Could not find '${pattern}'`);
    return matches;
  });
}

/**
 * Runs the files longest first by their seconds in the last run of this tier, so one slow file does not start last and set
 * the step's floor. The order changes no result.
 * No file or test limit is set here: on Node 22 `--test-timeout` also cancels a whole file, which a loaded host turns into a
 * false failure. The tier ceiling in `scripts/test-runner/entrypoint.sh` is the one hang catcher.
 */
function nodeTest(tier: Tier, label: string, patterns: readonly string[], concurrency: number, extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Step {
  const fileTimings = resultsDir ? stepResultFile(resultsDir, tier, label, 'files.jsonl') : undefined;
  return {
    label,
    fileTimings,
    run: () => {
      let files: string[];
      try {
        files = expandFiles(patterns);
      } catch (error) {
        // A selection that names no file is the caller's input: the step fails, and runStep records it.
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return Promise.resolve(STEP_FAULT);
      }
      const sources = new Map(files.map(file => [sourcePath(path.resolve(root, file), root), file]));
      stepFiles.set(label, [...sources.keys()].sort());
      const finished = new Set(Object.keys(resumed?.steps[label]?.passed ?? {}));
      const remaining = files.filter(file => !finished.has(sourcePath(path.resolve(root, file), root)));
      if (!remaining.length) {
        process.stdout.write(`${label}: all ${files.length} files passed in the earlier run\n`);
        return Promise.resolve(STEP_NOTHING_LEFT);
      }
      const { ordered, recordedCount } = longestFirst(remaining, recordedFileSeconds.get(label));
      const earlier = files.length - remaining.length;
      if (earlier) resumedSteps.add(label);
      process.stdout.write(`${label}: ${ordered.length} files, ${recordedCount} ordered by record, ${ordered.length - recordedCount} new first${earlier ? `; ${earlier} passed in the earlier run` : ''}\n`);
      const request: OrderedRun = { tier, label, concurrency, execArgv: extra, files: ordered };
      return run(process.execPath, [fileURLToPath(new URL('./test-run-ordered.js', import.meta.url)), JSON.stringify(request)], root, env);
    },
  };
}

/** The status of a step that failed before it ran a file (no files selected, or a fault of the runner itself). */
const STEP_FAULT = 2;
/** The status of a step whose every file passed in the earlier run: it started nothing and has no result of its own. */
const STEP_NOTHING_LEFT = -1;

/** Environment that points the compiler seam at the container's TypeScript 6 install. */
function typescript6Env(): NodeJS.ProcessEnv {
  const typescript6Root = process.env.GOLEM_TYPESCRIPT6_ROOT;
  if (!typescript6Root) throw new Error('GOLEM_TYPESCRIPT6_ROOT is not set; the TypeScript 6 lane runs in the test container (npm run test:prepare installs it).');
  return { GOLEM_TYPESCRIPT_ROOT: typescript6Root };
}

/** Takes `--typescript 6` (or `--typescript=6`) out of the focused arguments. */
function splitTypescriptLane(args: readonly string[]): { readonly lane6: boolean; readonly rest: readonly string[] } {
  const rest: string[] = [];
  let lane6 = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value !== '--typescript' && !value.startsWith('--typescript=')) { rest.push(value); continue; }
    const version = value.includes('=') ? value.slice(value.indexOf('=') + 1) : args[++index];
    if (version !== '6') throw new Error(`--typescript takes 6 (TypeScript 7 is the default), got ${version ?? 'nothing'}.`);
    lane6 = true;
  }
  return { lane6, rest };
}

const npmRun = (label: string, script: string): Step => ({ label, run: () => run('npm', ['run', script]) });
// The packed set lives in /cache/packed, which keeps only the newest set: another checkout can replace it, so a resume packs again (a present set is reused at once).
const pack: Step = { label: 'pack', always: true, run: () => run(process.execPath, ['.build/scripts/test-pack.js']) };
// Prepare only fills caches; it never runs a test.
const prepareSteps: Group[] = inOrder(
  pack,
  { label: 'warm', run: () => run(process.execPath, ['.build/scripts/test-warm.js']) },
);

function steps(tier: Tier, args: readonly string[], native: boolean): Group[] {
  if (tier === 'prepare') return prepareSteps;
  if (tier === 'focused') {
    const { lane6, rest } = splitTypescriptLane(args);
    // `--typescript 6` alone runs the lane's whole list; with files it runs those files on TypeScript 6.
    const selection = selectFocused(rest, lane6);
    const focused = nodeTest(tier, 'focused', selection.files, CONCURRENCY.unit, selection.passThrough, lane6 ? typescript6Env() : {});
    return selection.needsPack ? inOrder(pack, focused) : inOrder(focused);
  }
  if (tier === 'docs') {
    return inOrder(
      nodeTest(tier, 'docs prose and structure', DOCS_FILES, 1),
      npmRun('docs build', 'docs:build'),
      nodeTest(tier, 'docs site', ['.build/tests/docs-site.site-test.js'], 1),
      { label: 'docs public content', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'scan', 'docs/.vitepress/dist']) },
    );
  }
  const unit = nodeTest(tier, 'unit', UNIT_FILES, CONCURRENCY.unit);
  const typescript6 = (concurrency: number): Step => nodeTest(tier, 'typescript 6', typescript6Files(), concurrency, [], typescript6Env());
  const smoke = nodeTest(tier, 'packed smoke', [SMOKE_FILE], 1);
  if (tier === 'full') {
    if (native) return inOrder(unit);
    // Pack and the smoke test read the workspace and /cache/packed, never a file that the lane writes. The lane's last files
    // leave cores idle, so they run beside it and add no time of their own.
    return [...inOrder(unit), [[typescript6(CONCURRENCY.unit)], [pack, smoke]]];
  }
  // Acceptance: after unit, the side chain adds the steps that need nothing from the TypeScript 6 lane. Packed and browser read
  // /cache/packed after pack (this chain's own step); the lane reads /cache/typescript6 and the workspace. Each test file makes
  // its own temp folders and registry and server ports, so no step reads a file that another step writes. Acceptance unit
  // (the identity corpus peaks at 2.9 GiB) runs alone after both chains, so it never overlaps the lane's 5.4 GiB.
  return [
    ...inOrder(
      { label: 'public source', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'check']) },
      { label: 'OpenAPI compliance', run: () => run(process.execPath, ['.build/packages/golem-openapi/compliance/generate-matrix.js', '--check']) },
      unit,
    ),
    [[typescript6(CONCURRENCY.beside)], [
      pack,
      smoke,
      nodeTest(tier, 'packed', PACKED_FILES, CONCURRENCY.packed),
      nodeTest(tier, 'browser', BROWSER_FILES, CONCURRENCY.packed),
    ]],
    ...inOrder(nodeTest(tier, 'acceptance unit', ACCEPTANCE_UNIT_FILES, CONCURRENCY.unit)),
  ];
}

export interface ImageFacts { readonly node: string; readonly npm: string; readonly playwright: string | undefined; readonly browsers: string | undefined; readonly browsersPresent: boolean }

export function imageMismatches(actual: ImageFacts, expected: Pick<ImageFacts, 'node' | 'npm' | 'playwright'>): string[] {
  const mismatches: string[] = [];
  if (actual.node !== expected.node) mismatches.push(`node is ${actual.node}, expected ${expected.node}`);
  if (actual.npm !== expected.npm) mismatches.push(`npm is ${actual.npm}, expected ${expected.npm}`);
  if (actual.playwright !== expected.playwright) mismatches.push(`@playwright/test is ${actual.playwright ?? 'not installed'}, expected ${expected.playwright ?? 'a devDependency'}`);
  if (actual.browsers !== expected.playwright) mismatches.push(`playwright browsers ${actual.browsers ?? 'unrecorded'} vs package.json ${expected.playwright ?? 'no devDependency'}`);
  if (!actual.browsersPresent) mismatches.push('the Playwright browsers directory is missing');
  return mismatches;
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { return undefined; }
}

function assertContainer(tier: Tier, native: boolean): void {
  if (native) {
    if (tier !== 'full') throw new Error('--native runs only the full tier (the unit tests), without Docker.');
    return;
  }
  const command = { prepare: 'npm run test:prepare', focused: 'npm run test -- <files>', full: 'npm run test:full', acceptance: 'npm run test:acceptance', docs: 'npm run docs:check' }[tier];
  if (process.env.FE_DEPS_TEST_CONTAINER !== '1') throw new Error(`Run this tier through Docker: ${command}`);
  const manifest = readJson<{ devDependencies: Record<string, string> }>(path.join(root, 'package.json'));
  const installed = readJson<{ version: string }>(path.join(root, 'node_modules/@playwright/test/package.json'));
  const mismatches = imageMismatches({
    node: process.version,
    npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    playwright: installed?.version,
    browsers: process.env.FE_DEPS_PLAYWRIGHT_VERSION,
    browsersPresent: fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/ms-playwright'),
  }, { node: 'v22.15.0', npm: '10.9.8', playwright: manifest?.devDependencies['@playwright/test'] });
  if (mismatches.length) throw new Error(`The test image is stale: ${mismatches.join('; ')}. Run: npm run test:prepare`);
}

/** `load_start` and `load_end` are the 1, 5 and 15 minute load averages when the step began and ended. */
interface StepTiming { readonly label: string; readonly seconds: number; readonly status: number; readonly load_start: readonly number[]; readonly load_end: readonly number[]; file_seconds?: Record<string, number> }

/** The load averages of the kernel this process runs on: in the test container that is the kernel of the container's host or Docker VM, not the machine's own. */
const loadAverages = (): number[] => os.loadavg().map(value => Math.round(value * 100) / 100);
const formatLoad = (load: readonly number[]): string => load.map(value => value.toFixed(2)).join(' ');

/**
 * Reads the lines of the test-file reporter. A step with no lines is reported, never read as zero files.
 * A malformed line is skipped and reported with `onMalformed`: a kill can truncate the last line.
 */
function readFileSeconds(file: string, label: string, onMalformed: () => void): Record<string, number> | undefined {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  if (!lines.length) {
    process.stderr.write(`No test file timings for the ${label} step (${file}).\n`);
    return undefined;
  }
  const fileSeconds: Record<string, number> = {};
  lines.forEach((line, index) => {
    try {
      const { file: source, seconds } = JSON.parse(line) as { file: string; seconds?: number };
      // A line with no seconds says the file started; the ceiling report reads those lines.
      if (seconds !== undefined) fileSeconds[source] = seconds;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      process.stderr.write(`Skipped a malformed test file timing at ${file}:${index + 1}.\n`);
      onMalformed();
    }
  });
  return fileSeconds;
}

/** The seconds of each file over all steps; a file that two steps run counts both. */
function sumFileSeconds(timings: readonly StepTiming[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const { file_seconds } of timings) for (const [source, seconds] of Object.entries(file_seconds ?? {})) total[source] = Math.round(((total[source] ?? 0) + seconds) * 10) / 10;
  return total;
}

async function main(argv: readonly string[]): Promise<void> {
  const [tierArg, ...rest] = argv;
  const native = rest.includes('--native');
  const args = rest.filter(value => value !== '--native');
  if (!tierArg || !(tierArg in tiers)) throw new Error(`Usage: test-tier <${Object.keys(tiers).join('|')}> [args]`);
  const tier = tierArg as Tier;
  assertContainer(tier, native);
  const { budget, purpose } = tiers[tier];
  const loadLabel = native ? 'load (host)' : 'load (container kernel)';
  process.stdout.write(`golem ${tier} tier (${budget}): ${purpose}\n`);
  if (resultsDir) {
    fs.mkdirSync(resultsDir, { recursive: true });
    // A run's results never mix with an earlier run of its tier; the results of other tiers stay.
    for (const name of fs.readdirSync(resultsDir)) if (isTierResult(name, tier)) fs.rmSync(path.join(resultsDir, name));
  }
  const plan = steps(tier, args, native);
  const state = runStateFromEnv();
  if (state && !state.again) {
    resumed = readRecord(state.recordFile);
    for (const step of plan.flat(2)) if (step.always && resumed?.steps[step.label]) resumed.steps[step.label].ended = false;
    const line = resumed && describeResume(resumed, state);
    if (line) process.stdout.write(`${tier} ${line}\n`);
    else resumed = undefined;
  }
  const orderRecord = fileSecondsRecord(tier);
  loadFileSeconds(orderRecord);
  const timings: StepTiming[] = [];
  const running = new Set<string>();
  let timingsFault = false;
  const started = Date.now();
  // The ceiling can kill this process at any time, so the file is complete after every step. `running` names the
  // steps that were cut; the files those steps finished stay in their `.files.jsonl`.
  const writeTimings = (): void => {
    if (!resultsDir) return;
    const file = path.join(resultsDir, `${tier}-timings.json`);
    const total = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ tier, total, running: running.size ? [...running] : undefined, timings, file_seconds: sumFileSeconds(timings) }, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
  };
  const runStep = async (step: Step): Promise<void> => {
    if (!step.always && resumed?.steps[step.label]?.ended) {
      process.stdout.write(`${tier} ${step.label}: passed in the earlier run\n`);
      return;
    }
    running.add(step.label);
    writeTimings();
    const loadStart = loadAverages();
    process.stdout.write(`${tier} ${step.label}: started, ${loadLabel} ${formatLoad(loadStart)}\n`);
    const stepStarted = Date.now();
    let status: number;
    try {
      status = await step.run();
    } finally {
      running.delete(step.label);
    }
    if (status === STEP_NOTHING_LEFT) return;
    const seconds = Math.round((Date.now() - stepStarted) / 1000);
    // The verdict of the step is recorded before its file timings are read, so a bad timings file cannot lose it.
    const loadEnd = loadAverages();
    const entry: StepTiming = { label: step.label, seconds, status, load_start: loadStart, load_end: loadEnd };
    timings.push(entry);
    process.stdout.write(`${tier} ${step.label}: ${status === 0 ? 'passed' : 'FAILED'} in ${seconds}s, ${loadLabel} ${formatLoad(loadEnd)}\n`);
    writeTimings();
    const fileSeconds = step.fileTimings && status !== STEP_FAULT && readFileSeconds(step.fileTimings, step.label, () => { timingsFault = true; });
    if (fileSeconds) {
      entry.file_seconds = fileSeconds;
      writeTimings();
      // A failed step can hold cut or crashed files with short seconds, which would misplace them next time.
      if (status === 0) {
        // A resumed step timed only the files it ran; the record keeps the others.
        recordedFileSeconds.set(step.label, resumedSteps.has(step.label) ? { ...recordedFileSeconds.get(step.label), ...fileSeconds } : fileSeconds);
        saveFileSeconds(orderRecord);
      }
    }
  };
  for (const group of plan) {
    // A chain that fails to start a step leaves the other chains running; wait for all of them before the fault is reported.
    const chains = await Promise.allSettled(group.map(async chain => { for (const step of chain) await runStep(step); }));
    for (const chain of chains) if (chain.status === 'rejected') throw chain.reason;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`${tier} finished in ${seconds}s\n`);
  const failed = timings.some(entry => entry.status !== 0);
  if (failed) process.exitCode = 1;
  if (timingsFault) process.exitCode = 2;
  if (state && resultsDir) {
    // A test step that passed whole in the earlier run never expanded its files here; the record counts them.
    const planned: PlannedStep[] = plan.flat(2).map(step => ({ label: step.label, files: step.fileTimings && resumed?.steps[step.label]?.ended ? Object.keys(resumed.steps[step.label].passed) : stepFiles.get(step.label) }));
    process.stdout.write(`${finishRun(state, resumed, planned, resultsDir, tier, failed || timingsFault, seconds)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
