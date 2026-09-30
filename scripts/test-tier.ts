import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goBinary } from './go-binary.js';

export type Tier = 'prepare' | 'focused' | 'full' | 'acceptance' | 'docs';
export interface Step { readonly label: string; readonly run: () => number }

export const UNIT_FILES = ['.build/tests/*.test.js', '.build/tests/openapi/*.test.js', '.build/tests/ts-to-openapi/*.test.js'] as const;
// The model-only smoke file runs in Full; Acceptance runs the others so it runs once.
export const PACKED_FILES = ['.build/tests/packed/consumers.test.js', '.build/tests/packed/nest-workflows.test.js'] as const;
const SMOKE_FILE = '.build/tests/packed/model-only.test.js';
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
// The container's Go build cache (GOCACHE=/cache/go) grows with every plugin
// build. A fresh prepare fills 4.3 GiB (2026-09-30), so Full and Acceptance clear
// it past twice that; the next run then rebuilds the ttsc plugin from source.
const GO_CACHE_LIMIT_BYTES = 9 * 1024 ** 3;

export function trimGoCache(limitBytes: number): void {
  const directory = process.env.GOCACHE;
  if (!directory || !fs.existsSync(directory)) return;
  const size = Number(spawnSync('du', ['-sb', directory], { encoding: 'utf8' }).stdout.split('\t')[0]);
  if (size <= limitBytes) return;
  fs.rmSync(directory, { recursive: true, force: true });
  process.stdout.write(`Go build cache was ${(size / 1024 ** 3).toFixed(1)} GiB; cleared it. The next run rebuilds the ttsc plugin.\n`);
}

export const CONCURRENCY = {
  unit: Math.min(UNIT_CAP, os.availableParallelism()),
  packed: Math.max(1, Math.min(PACKED_CAP, Math.floor(os.availableParallelism() / 2))),
} as const;

const tiers: Readonly<Record<Tier, { readonly budget: string; readonly purpose: string }>> = {
  prepare: { budget: '≤5 min (plus a first-time image build), network', purpose: 'Fill the npm, Go and packed caches so tiers run offline.' },
  focused: { budget: '≤1 min', purpose: 'Did my change break what I touched?' },
  full: { budget: '≤5 min', purpose: 'Did I break anything anywhere?' },
  acceptance: { budget: '≤10 min, needs a stated reason', purpose: 'Is this releasable?' },
  docs: { budget: 'about 2 min', purpose: 'Does the documentation site build and pass its checks?' },
};

export function selectFocused(args: readonly string[]): { readonly files: readonly string[]; readonly passThrough: readonly string[]; readonly needsPack: boolean } {
  const files: string[] = [];
  const passThrough: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value.startsWith('--')) {
      passThrough.push(value);
      if (!value.includes('=') && index + 1 < args.length && !args[index + 1].startsWith('--')) passThrough.push(args[++index]);
    } else {
      files.push(value.startsWith('tests/') ? `.build/${value.replace(/\.ts$/, '.js')}` : value);
    }
  }
  if (!files.length && !passThrough.some(flag => flag.startsWith('--test-name-pattern'))) {
    throw new Error('Select test files or --test-name-pattern, for example: npm run test -- tests/serde.test.ts');
  }
  const selected = files.length ? files : [...UNIT_FILES];
  return { files: selected, passThrough, needsPack: selected.some(file => /\/tests\/(?:packed|browser)\//.test(file)) };
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const resultsDir = process.env.FE_DEPS_RESULTS_DIR;

function run(executable: string, args: readonly string[], cwd: string = root, env: NodeJS.ProcessEnv = {}): number {
  const result = spawnSync(executable, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function nodeTest(label: string, files: readonly string[], timeout: number, concurrency: number, extra: readonly string[] = []): Step {
  const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout'];
  if (resultsDir) reporters.push('--test-reporter=tap', `--test-reporter-destination=${path.join(resultsDir, `${label}.tap`)}`);
  return { label, run: () => run(process.execPath, ['--test', `--test-timeout=${timeout}`, `--test-concurrency=${concurrency}`, ...reporters, ...extra, ...files]) };
}

const npmRun = (label: string, script: string): Step => ({ label, run: () => run('npm', ['run', script]) });
const goTests: Step = { label: 'go', run: () => run(process.execPath, ['.build/scripts/test-go-plugin.js']) };
const pack: Step = { label: 'pack', run: () => run(process.execPath, ['.build/scripts/test-pack.js']) };
// Prepare only fills caches; it never runs a test.
const prepareSteps: Step[] = [
  pack,
  { label: 'warm', run: () => run(process.execPath, ['.build/scripts/test-warm.js']) },
  { label: 'goModules', run: () => run(goBinary(), ['mod', 'download'], path.join(root, 'packages/codegen/plugin'), { GOTOOLCHAIN: 'local' }) },
];

function steps(tier: Tier, args: readonly string[], native: boolean): Step[] {
  if (tier === 'prepare') return prepareSteps;
  if (tier === 'focused') {
    const selection = selectFocused(args);
    const focused = nodeTest('focused', selection.files, TEST_TIMEOUT_MS.focused, CONCURRENCY.unit, selection.passThrough);
    return selection.needsPack ? [pack, focused] : [focused];
  }
  if (tier === 'docs') {
    return [
      npmRun('docs build', 'docs:build'),
      nodeTest('docs site', ['.build/tests/docs-site.site-test.js'], TEST_TIMEOUT_MS.full, 1),
      { label: 'docs public content', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'scan', 'docs/.vitepress/dist']) },
    ];
  }
  const full: Step[] = [nodeTest('unit', UNIT_FILES, TEST_TIMEOUT_MS.full, CONCURRENCY.unit), goTests];
  if (tier === 'full') return native ? full : [...full, pack, nodeTest('packed smoke', [SMOKE_FILE], TEST_TIMEOUT_MS.full, 1)];
  return [
    { label: 'public source', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'check']) },
    { label: 'OpenAPI compliance', run: () => run(process.execPath, ['.build/packages/openapi-to-ts/compliance/generate-matrix.js', '--check']) },
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
    if (tier !== 'full') throw new Error('--native runs only the full tier (unit and Go), for CI platform jobs.');
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
  process.stdout.write(`fe-deps ${tier} tier (${budget}): ${purpose}\n`);
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
  // Only the container's cache: natively, GOCACHE may be the developer's own.
  if (!native && (tier === 'full' || tier === 'acceptance')) trimGoCache(GO_CACHE_LIMIT_BYTES);
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
