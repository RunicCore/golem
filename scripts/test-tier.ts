import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Tier = 'prepare' | 'focused' | 'full' | 'acceptance' | 'docs';
export interface Step { readonly label: string; readonly run: () => number }

export const UNIT_FILES = ['.build/tests/*.test.js', '.build/tests/openapi/*.test.js', '.build/tests/golem-ts-openapi/*.test.js'] as const;
// The model-only smoke file runs in Full; Acceptance runs the others so it runs once.
export const PACKED_FILES = ['.build/tests/packed/consumers.test.js', '.build/tests/packed/nest-workflows.test.js'] as const;
const SMOKE_FILE = '.build/tests/packed/model-only.test.js';
// The TypeScript 6 lane runs these files with GOLEM_TYPESCRIPT_ROOT at the container's TypeScript 6 install.
// Left out on purpose: compiler-lifecycle (asserts TypeScript 7 server reports), model-generation-scale (patches
// `Checker.prototype` from typescript/unstable/sync, which TypeScript 6 has no equivalent of), and
// typescript-identity (it compares both versions itself, so it runs once, in the unit step).
export const TYPESCRIPT6_FILES = [
  ...[
    'typescript-backends', 'typescript-ts6', 'model-tags', 'model-composition', 'projection-names', 'model-job-graph',
    'constraint-parity', 'model-companions', 'model-union-tags', 'union-conversion', 'model-tuples', 'projection-integration',
    'resource-projection', 'tag-alias-generics', 'tag-model-boundaries', 'model-generator', 'model-codec-location',
    'model-field-names', 'constraint-portability', 'constraint-callback-composition', 'public-model-layout', 'public-sdk-layout',
    'controllers-tooling', 'watch-recovery', 'pipeline', 'rewrite-scan', 'rewrite-loader', 'rewrite-bundlers', 'build-command',
    'build-command-config', 'build-command-configurations', 'build-command-watch',
  ].map(name => `.build/tests/${name}.test.js`),
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
  prepare: { budget: '≤5 min (plus a first-time image build), network', purpose: 'Fill the npm and packed caches so tiers run offline.' },
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
  if (resultsDir) reporters.push('--test-reporter=tap', `--test-reporter-destination=${path.join(resultsDir, `${label}.tap`)}`);
  return { label, run: () => run(process.execPath, ['--test', `--test-timeout=${timeout}`, `--test-concurrency=${concurrency}`, ...reporters, ...extra, ...files], root, env) };
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
    for (const name of fs.readdirSync(resultsDir)) if (name.endsWith('.tap') || name.endsWith('-timings.json')) fs.rmSync(path.join(resultsDir, name));
  }
  const timings: { label: string; seconds: number; status: number }[] = [];
  const started = Date.now();
  for (const step of steps(tier, args, native)) {
    const stepStarted = Date.now();
    const status = step.run();
    timings.push({ label: step.label, seconds: Math.round((Date.now() - stepStarted) / 1000), status });
  }
  const total = Math.round((Date.now() - started) / 1000);
  for (const entry of timings) process.stdout.write(`${tier} ${entry.label}: ${entry.status === 0 ? 'passed' : 'FAILED'} in ${entry.seconds}s\n`);
  process.stdout.write(`${tier} finished in ${total}s\n`);
  if (resultsDir) fs.writeFileSync(path.join(resultsDir, `${tier}-timings.json`), JSON.stringify({ tier, total, timings }, null, 2) + '\n');
  if (timings.some(entry => entry.status !== 0)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
}
