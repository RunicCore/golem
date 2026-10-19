import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcePath } from './test-file-timings.js';
import type { OrderedRun } from './test-run-ordered.js';

export type Tier = 'prepare' | 'focused' | 'full' | 'acceptance' | 'docs';
/** `fileTimings` is the JSON-lines file that the test-file reporter fills while the step runs. */
export interface Step { readonly label: string; readonly run: () => Promise<number>; readonly fileTimings?: string }
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
// The TypeScript 6 lane runs these files with GOLEM_TYPESCRIPT_ROOT at the container's TypeScript 6 install. A file is in the
// lane only when it runs a TypeScript-version path: it reaches the compiler seam (typescript-ns.ts) or the backend selection
// (GOLEM_TYPESCRIPT_ROOT, read in tooling/{cli,pipeline,build,typescript-selection}.ts). Each group below names that path.
// Left out on purpose: compiler-lifecycle (asserts TypeScript 7 server reports), model-generation-scale (patches
// `Checker.prototype` from typescript/unstable/sync, which TypeScript 6 has no equivalent of), typescript-identity (it
// compares both versions itself, so it runs once, in the unit step), and four files that run no TypeScript-version path:
// union-conversion (emitted runtime only), and openapi/operation-validators, openapi/discriminator-validation and
// resource-projection (the SDK generator loads no TypeScript, and tests/tsc-cli.mjs compiles with the workspace's own install).
export const TYPESCRIPT6_FILES = [
  ...[
    // Reach the compiler seam directly (typescript-ns.ts, @exprtlabs/golem/ts):
    'typescript-backends', 'typescript-ts6', 'model-companions', 'public-model-layout', 'public-sdk-layout',
    // `golem build` runs as a child process and reads GOLEM_TYPESCRIPT_ROOT (buildModelProject):
    'model-tags', 'model-tags-serde', 'model-composition', 'model-projections', 'model-job-graph', 'constraint-parity',
    'model-companion-build', 'model-union-tags', 'model-tuples', 'projection-integration', 'tag-alias-generics',
    'tag-model-boundaries', 'constraint-portability', 'constraint-callback-composition', 'wire-format', 'wire-format-sdk',
    // `generate` of the model or controller generator runs the checker in this process:
    'projection-names', 'model-generator', 'model-codec-location', 'model-field-names',
    // The pipeline, build, rewrite host or CLI selects the backend in this process or in `golem` child processes:
    'controllers-tooling', 'watch-recovery', 'pipeline', 'rewrite-scan', 'rewrite-loader', 'rewrite-bundlers', 'build-command',
    'build-command-config', 'build-command-configurations', 'build-command-watch',
  ].map(name => `.build/tests/${name}.test.js`),
  // `generate` of the controller generator, or the evaluation and rewrite code it uses, runs the checker in this process:
  '.build/tests/golem-ts-openapi/*.test.js',
] as const;
export const BROWSER_FILES = ['.build/tests/browser/*.test.js'] as const;
// Unit-level tests too slow for Full are named *.acceptance.ts and run only in Acceptance.
export const ACCEPTANCE_UNIT_FILES = ['.build/tests/*.acceptance.js', '.build/tests/openapi/*.acceptance.js'] as const;
// Unit: 8 files at once peaked at 3.5 of 7.7 GiB and halved the unit step (136 s to 69 s),
// so the machine's parallelism is the only limit up to 8. Packed: Acceptance has two packed
// files, so two at once is the most that helps.
const UNIT_CAP = 8;
const PACKED_CAP = 2;
export const CONCURRENCY = {
  unit: Math.min(UNIT_CAP, os.availableParallelism()),
  packed: Math.max(1, Math.min(PACKED_CAP, Math.floor(os.availableParallelism() / 2))),
} as const;

const tiers: Readonly<Record<Tier, { readonly budget: string; readonly purpose: string }>> = {
  prepare: { budget: '≤5 min (plus a first-time image build), network', purpose: 'Fill the npm, packed and typia plugin caches so tiers run offline.' },
  focused: { budget: '≤1 min', purpose: 'Did my change break what I touched?' },
  full: { budget: '≤5 min', purpose: 'Did I break anything anywhere?' },
  acceptance: { budget: '≤10 min, needs a stated reason', purpose: 'Is this releasable?' },
  docs: { budget: 'about 2 min', purpose: 'Does the documentation site build and pass its checks?' },
};

export function selectFocused(args: readonly string[], lane6 = false): { readonly files: readonly string[]; readonly passThrough: readonly string[]; readonly needsPack: boolean } {
  const files: string[] = [];
  const passThrough: string[] = [];
  // A flag's separate value is the next argument unless that is a test file.
  const testFile = (value: string): boolean => value.startsWith('tests/') || value.startsWith('.build/') || /\.[cm]?[jt]s$/.test(value);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value.startsWith('--')) {
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
  const selected = files.length ? files : [...(lane6 ? TYPESCRIPT6_FILES : UNIT_FILES)];
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
function longestFirst(files: readonly string[], recorded: Readonly<Record<string, number>> | undefined): string[] {
  const seconds = (file: string): number | undefined => {
    const value: unknown = recorded?.[sourcePath(path.resolve(root, file), root)];
    return typeof value === 'number' ? value : undefined;
  };
  const byPath = [...new Set(files)].sort();
  const unrecorded = byPath.filter(file => seconds(file) === undefined);
  const known = byPath.filter(file => seconds(file) !== undefined).sort((a, b) => (seconds(b) ?? 0) - (seconds(a) ?? 0));
  return [...unrecorded, ...known];
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
    const matches = pattern.includes('*')
      ? fs.readdirSync(path.join(root, directory), { withFileTypes: true }).filter(entry => entry.isFile() && name.test(entry.name)).map(entry => path.posix.join(directory, entry.name))
      : fs.existsSync(path.join(root, pattern)) ? [pattern] : [];
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
function nodeTest(label: string, patterns: readonly string[], concurrency: number, extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Step {
  const fileTimings = resultsDir ? path.join(resultsDir, `${label}.files.jsonl`) : undefined;
  return {
    label,
    fileTimings,
    run: () => {
      const request: OrderedRun = { label, concurrency, execArgv: extra, files: longestFirst(expandFiles(patterns), recordedFileSeconds.get(label)) };
      return run(process.execPath, [fileURLToPath(new URL('./test-run-ordered.js', import.meta.url)), JSON.stringify(request)], root, env);
    },
  };
}

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
const pack: Step = { label: 'pack', run: () => run(process.execPath, ['.build/scripts/test-pack.js']) };
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
    const focused = nodeTest('focused', selection.files, CONCURRENCY.unit, selection.passThrough, lane6 ? typescript6Env() : {});
    return selection.needsPack ? inOrder(pack, focused) : inOrder(focused);
  }
  if (tier === 'docs') {
    return inOrder(
      npmRun('docs build', 'docs:build'),
      nodeTest('docs site', ['.build/tests/docs-site.site-test.js'], 1),
      { label: 'docs public content', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'scan', 'docs/.vitepress/dist']) },
    );
  }
  const unit = nodeTest('unit', UNIT_FILES, CONCURRENCY.unit);
  if (tier === 'full') {
    if (native) return inOrder(unit);
    // Pack and the smoke test read the workspace and /cache/packed, never a file that the lane writes. The lane's last files
    // leave cores idle, so they run beside it and add no time of their own.
    return [...inOrder(unit), [[nodeTest('typescript 6', TYPESCRIPT6_FILES, CONCURRENCY.unit, [], typescript6Env())], [pack, nodeTest('packed smoke', [SMOKE_FILE], 1)]]];
  }
  return [
    ...inOrder(
      { label: 'public source', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'check']) },
      { label: 'OpenAPI compliance', run: () => run(process.execPath, ['.build/packages/golem-openapi/compliance/generate-matrix.js', '--check']) },
    ),
    ...steps('full', args, false),
    ...inOrder(
      nodeTest('acceptance unit', ACCEPTANCE_UNIT_FILES, CONCURRENCY.unit),
      nodeTest('packed', PACKED_FILES, CONCURRENCY.packed),
      nodeTest('browser', BROWSER_FILES, CONCURRENCY.packed),
    ),
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
    if (tier !== 'full') throw new Error('--native runs only the full tier (unit tests), for CI platform jobs.');
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

interface StepTiming { readonly label: string; readonly seconds: number; readonly status: number; file_seconds?: Record<string, number> }

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
  process.stdout.write(`golem ${tier} tier (${budget}): ${purpose}\n`);
  if (resultsDir) {
    fs.mkdirSync(resultsDir, { recursive: true });
    // A run's results never mix with an earlier run's.
    for (const name of fs.readdirSync(resultsDir)) if (name.endsWith('.tap') || name.endsWith('-timings.json') || name.endsWith('.files.jsonl')) fs.rmSync(path.join(resultsDir, name));
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
    running.add(step.label);
    writeTimings();
    const stepStarted = Date.now();
    let status: number;
    try {
      status = await step.run();
    } finally {
      running.delete(step.label);
    }
    const seconds = Math.round((Date.now() - stepStarted) / 1000);
    // The verdict of the step is recorded before its file timings are read, so a bad timings file cannot lose it.
    const entry: StepTiming = { label: step.label, seconds, status };
    timings.push(entry);
    process.stdout.write(`${tier} ${step.label}: ${status === 0 ? 'passed' : 'FAILED'} in ${seconds}s\n`);
    writeTimings();
    const fileSeconds = step.fileTimings && readFileSeconds(step.fileTimings, step.label, () => { timingsFault = true; });
    if (fileSeconds) {
      entry.file_seconds = fileSeconds;
      writeTimings();
      // A failed step can hold cut or crashed files with short seconds, which would misplace them next time.
      if (status === 0) {
        recordedFileSeconds.set(step.label, fileSeconds);
        saveFileSeconds(orderRecord);
      }
    }
  };
  for (const group of steps(tier, args, native)) {
    // A chain that fails to start a step leaves the other chains running; wait for all of them before the fault is reported.
    const chains = await Promise.allSettled(group.map(async chain => { for (const step of chain) await runStep(step); }));
    for (const chain of chains) if (chain.status === 'rejected') throw chain.reason;
  }
  process.stdout.write(`${tier} finished in ${Math.round((Date.now() - started) / 1000)}s\n`);
  if (timings.some(entry => entry.status !== 0)) process.exitCode = 1;
  if (timingsFault) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
