import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Tier = 'prepare' | 'focused' | 'full' | 'acceptance' | 'docs';
export interface Step { readonly label: string; readonly run: () => number }

export const UNIT_FILES = ['.build/tests/*.test.js', '.build/tests/openapi/*.test.js', '.build/tests/ts-to-openapi/*.test.js'] as const;
export const PACKED_FILES = ['.build/tests/packed/*.test.js'] as const;
export const BROWSER_FILES = ['.build/tests/browser/*.test.js'] as const;
// Values from the Task 2 baseline replace these in Task 6.
export const TEST_TIMEOUT_MS = { focused: 60_000, full: 60_000, acceptance: 300_000, prepare: 900_000 } as const;
// Task 6 replaces these with min(measured cap, os.availableParallelism()-derived value).
export const CONCURRENCY = { unit: 2, packed: 1 } as const;

const tiers: Readonly<Record<Tier, { readonly budget: string; readonly purpose: string }>> = {
  prepare: { budget: 'about 10 min, network', purpose: 'Fill the npm, Go and packed caches so tiers run offline.' },
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

function run(executable: string, args: readonly string[]): number {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit' });
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

function steps(tier: Tier, args: readonly string[], native: boolean): Step[] {
  if (tier === 'focused') {
    const selection = selectFocused(args);
    return [nodeTest('focused', selection.files, TEST_TIMEOUT_MS.focused, CONCURRENCY.unit, selection.passThrough)];
  }
  if (tier === 'docs') {
    return [
      npmRun('docs build', 'docs:build'),
      nodeTest('docs site', ['.build/tests/docs-site.site-test.js'], TEST_TIMEOUT_MS.full, 1),
      { label: 'docs public content', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'scan', 'docs/.vitepress/dist']) },
    ];
  }
  const full: Step[] = [nodeTest('unit', UNIT_FILES, TEST_TIMEOUT_MS.full, CONCURRENCY.unit), goTests];
  if (tier === 'full') return native ? full : [...full];
  // `prepare` is an online Acceptance run with a cold-cache per-test limit.
  const timeout = tier === 'prepare' ? TEST_TIMEOUT_MS.prepare : TEST_TIMEOUT_MS.acceptance;
  return [
    { label: 'public source', run: () => run(process.execPath, ['.build/scripts/public-source.js', 'check']) },
    { label: 'OpenAPI compliance', run: () => run(process.execPath, ['.build/packages/openapi-to-ts/compliance/generate-matrix.js', '--check']) },
    ...full,
    nodeTest('packed', PACKED_FILES, timeout, CONCURRENCY.packed),
    nodeTest('browser', BROWSER_FILES, timeout, CONCURRENCY.packed),
    npmRun('react example', 'check:react'),
  ];
}

function assertContainer(tier: Tier, native: boolean): void {
  if (native) {
    if (tier !== 'full') throw new Error('--native runs only the full tier (unit and Go), for CI platform jobs.');
    return;
  }
  const command = { prepare: 'npm run test:prepare', focused: 'npm run test -- <files>', full: 'npm run test:full', acceptance: 'npm run test:acceptance', docs: 'npm run docs:check' }[tier];
  if (process.env.FE_DEPS_TEST_CONTAINER !== '1') throw new Error(`Run this tier through Docker: ${command}`);
  const manifest: { devDependencies: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const expected = { node: 'v22.12.0', npm: '10.9.8', playwright: manifest.devDependencies['@playwright/test'] };
  const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const playwright = fs.existsSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/ms-playwright'));
  if (process.version !== expected.node || npmVersion !== expected.npm || !playwright) {
    throw new Error(`The test image is stale (node ${process.version}, npm ${npmVersion}). Run: npm run test:prepare`);
  }
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
  if (resultsDir) fs.mkdirSync(resultsDir, { recursive: true });
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
