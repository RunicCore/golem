import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Tier = 'prepare' | 'focused' | 'full' | 'acceptance' | 'docs';
/** `fileTimings` is the JSON-lines file that the test-file reporter fills while the step runs. */
export interface Step { readonly label: string; readonly run: () => number; readonly fileTimings?: string }

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
    'tag-model-boundaries', 'constraint-portability', 'constraint-callback-composition',
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
// On Node 22 --test-timeout also limits each whole file, so each tier allows twice
// its slowest file (2026-09-30, 694b437): serde about 44 s of tests in Full,
// packed/consumers 146 s in Acceptance. Focused keeps its 1-minute budget.
export const TEST_TIMEOUT_MS = { focused: 60_000, full: 90_000, acceptance: 300_000 } as const;
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

function run(executable: string, args: readonly string[], cwd: string = root, env: NodeJS.ProcessEnv = {}): number {
  const result = spawnSync(executable, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function nodeTest(label: string, files: readonly string[], timeout: number, concurrency: number, extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Step {
  const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout'];
  let fileTimings: string | undefined;
  if (resultsDir) {
    fileTimings = path.join(resultsDir, `${label}.files.jsonl`);
    reporters.push('--test-reporter=tap', `--test-reporter-destination=${path.join(resultsDir, `${label}.tap`)}`);
    reporters.push(`--test-reporter=${fileURLToPath(new URL('./test-file-timings.js', import.meta.url))}`, `--test-reporter-destination=${fileTimings}`);
  }
  return { label, fileTimings, run: () => run(process.execPath, ['--test', `--test-timeout=${timeout}`, `--test-concurrency=${concurrency}`, ...reporters, ...extra, ...files], root, env) };
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
const prepareSteps: Step[] = [
  pack,
  { label: 'warm', run: () => run(process.execPath, ['.build/scripts/test-warm.js']) },
];

function steps(tier: Tier, args: readonly string[], native: boolean): Step[] {
  if (tier === 'prepare') return prepareSteps;
  if (tier === 'focused') {
    const { lane6, rest } = splitTypescriptLane(args);
    // `--typescript 6` alone runs the lane's whole list; with files it runs those files on TypeScript 6.
    const selection = selectFocused(rest, lane6);
    const focused = nodeTest('focused', selection.files, TEST_TIMEOUT_MS.focused, CONCURRENCY.unit, selection.passThrough, lane6 ? typescript6Env() : {});
    return selection.needsPack ? [pack, focused] : [focused];
  }
  if (tier === 'docs') {
    return [
      npmRun('docs build', 'docs:build'),
      nodeTest('docs site', ['.build/tests/docs-site.site-test.js'], TEST_TIMEOUT_MS.full, 1),
      { label: 'docs public content', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'scan', 'docs/.vitepress/dist']) },
    ];
  }
  const full: Step[] = [nodeTest('unit', UNIT_FILES, TEST_TIMEOUT_MS.full, CONCURRENCY.unit)];
  if (tier === 'full') {
    if (native) return full;
    return [...full, nodeTest('typescript 6', TYPESCRIPT6_FILES, TEST_TIMEOUT_MS.full, CONCURRENCY.unit, [], typescript6Env()), pack, nodeTest('packed smoke', [SMOKE_FILE], TEST_TIMEOUT_MS.full, 1)];
  }
  return [
    { label: 'public source', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'check']) },
    { label: 'OpenAPI compliance', run: () => run(process.execPath, ['.build/packages/golem-openapi/compliance/generate-matrix.js', '--check']) },
    ...steps('full', args, false),
    nodeTest('acceptance unit', ACCEPTANCE_UNIT_FILES, TEST_TIMEOUT_MS.acceptance, CONCURRENCY.unit),
    nodeTest('packed', PACKED_FILES, TEST_TIMEOUT_MS.acceptance, CONCURRENCY.packed),
    nodeTest('browser', BROWSER_FILES, TEST_TIMEOUT_MS.acceptance, CONCURRENCY.packed),
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
      const { file: source, seconds } = JSON.parse(line) as { file: string; seconds: number };
      fileSeconds[source] = seconds;
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

function main(argv: readonly string[]): void {
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
  const timings: StepTiming[] = [];
  let timingsFault = false;
  const started = Date.now();
  // The ceiling can kill this process at any time, so the file is complete after every step. `running` names the
  // step that was cut; the files that step finished stay in its `.files.jsonl`.
  const writeTimings = (running?: string): void => {
    if (!resultsDir) return;
    const file = path.join(resultsDir, `${tier}-timings.json`);
    const total = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ tier, total, running, timings, file_seconds: sumFileSeconds(timings) }, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
  };
  for (const step of steps(tier, args, native)) {
    writeTimings(step.label);
    const stepStarted = Date.now();
    const status = step.run();
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
    }
  }
  process.stdout.write(`${tier} finished in ${Math.round((Date.now() - started) / 1000)}s\n`);
  if (timings.some(entry => entry.status !== 0)) process.exitCode = 1;
  if (timingsFault) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
}
