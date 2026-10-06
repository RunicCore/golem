import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparedPackages, registryNpmrc, startRegistry } from './packed-registry.js';
import { THIRD_PARTY_INSTALLS } from './third-party-installs.js';

// Fill the npm cache with what the packed and browser tests install, so those
// tiers run offline. Runs only in `test:prepare`, which has network access.
const root = fileURLToPath(new URL('../../', import.meta.url));
// The entrypoint ends `prepare` at 300 s, pack included. Every warm step ends by one deadline inside that, so a slow
// step reports its own timeout before the ceiling ends the run.
const WARM_BUDGET_MS = 240_000;
const deadline = Date.now() + WARM_BUDGET_MS;
/** The time left for a step; at least 1 ms, because a timeout of 0 means none. */
const remaining = (): number => Math.max(1, deadline - Date.now());
/** Fixture apps the packed and browser tests install from their own manifests, with `@exprtlabs/*` served by the local registry. */
const FIXTURE_APPS = ['tests/fixtures/packed/nest-app', 'tests/fixtures/browser/react-app'] as const;

interface WarmInstall { readonly label: string; readonly directory: string; readonly batches: readonly (readonly string[])[] }
interface WarmResult { readonly label: string; readonly seconds: number; readonly failure?: string }

function packageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Group specs so no batch names a package twice; npm rejects conflicting specs for one package in a single command. */
function installBatches(specs: readonly string[]): string[][] {
  const batches: { names: Set<string>; specs: string[] }[] = [];
  for (const spec of specs) {
    const name = packageName(spec);
    const batch = batches.find(candidate => !candidate.names.has(name));
    if (batch) { batch.names.add(name); batch.specs.push(spec); }
    else batches.push({ names: new Set([name]), specs: [spec] });
  }
  return batches.map(batch => batch.specs);
}

function npmInstall(directory: string, specs: readonly string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...(specs.length ? ['--include=optional', ...specs] : [])];
    const child = spawn('npm', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '';
    const collect = (value: Buffer): void => { output = (output + value).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      output += `\nTimed out: the warm steps have ${WARM_BUDGET_MS} ms in all`;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    }, remaining());
    child.once('error', error => { clearTimeout(timer); resolve(`${error.message}\n${output}`); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 && signal === null ? undefined : `npm ${args.join(' ')} failed (${code ?? signal}):\n${output}`);
    });
  });
}

async function warm(install: WarmInstall): Promise<WarmResult> {
  const started = Date.now();
  for (const specs of install.batches) {
    const failure = await npmInstall(install.directory, specs);
    if (failure) return { label: install.label, seconds: (Date.now() - started) / 1000, failure };
  }
  return { label: install.label, seconds: (Date.now() - started) / 1000 };
}

/**
 * The benchmark's typia adapter compiles with ttsc, which builds typia's Go plugin on first use: from source, with Go
 * modules fetched from the network. One compile of a tiny typia project fills the plugin and Go caches
 * (`TTSC_CACHE_DIR`, `GOMODCACHE`) that the entrypoint persists, so the benchmark runs offline.
 */
function warmTypiaPlugin(scratch: string): WarmResult {
  const started = Date.now();
  const label = 'typia ttsc plugin';
  const project = path.join(scratch, 'typia-plugin');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, rootDir: 'src', outDir: 'build', types: ['node'], plugins: [{ transform: 'typia/lib/transform' }] },
    include: ['src/**/*.ts'],
  }));
  fs.writeFileSync(path.join(project, 'src/check.ts'), "import typia from 'typia';\nexport const isNumber = (value: unknown): boolean => typia.is<number>(value);\n");
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/ttsc/lib/launcher/ttsc.js'), '-p', path.join(project, 'tsconfig.json')],
      { cwd: project, encoding: 'utf8', timeout: remaining(), maxBuffer: 16 * 1024 * 1024, stdio: 'pipe' });
    return { label, seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return { label, seconds: (Date.now() - started) / 1000, failure: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const registry = await startRegistry(preparedPackages(root));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-warm-')));
  try {
    const installs: WarmInstall[] = [];
    const thirdParty = path.join(scratch, 'third-party');
    fs.mkdirSync(thirdParty);
    fs.writeFileSync(path.join(thirdParty, 'package.json'), JSON.stringify({ name: 'warm-third-party', version: '1.0.0', private: true }));
    installs.push({ label: 'third-party installs', directory: thirdParty, batches: installBatches(THIRD_PARTY_INSTALLS) });
    for (const fixture of FIXTURE_APPS) {
      const directory = path.join(scratch, path.basename(fixture));
      fs.cpSync(path.join(root, fixture), directory, { recursive: true });
      fs.writeFileSync(path.join(directory, '.npmrc'), registryNpmrc(registry.url));
      installs.push({ label: `fixture ${fixture}`, directory, batches: [[]] });
    }
    const results: WarmResult[] = [];
    const queue = [...installs];
    await Promise.all(Array.from({ length: Math.min(os.availableParallelism(), installs.length) }, async () => {
      for (let install = queue.shift(); install; install = queue.shift()) {
        const result = await warm(install);
        results.push(result);
        process.stdout.write(`warm ${result.label}: ${result.failure ? 'FAILED' : 'ok'} in ${result.seconds.toFixed(1)}s\n`);
      }
    }));
    const typia = warmTypiaPlugin(scratch);
    results.push(typia);
    process.stdout.write(`warm ${typia.label}: ${typia.failure ? 'FAILED' : 'ok'} in ${typia.seconds.toFixed(1)}s\n`);
    process.stdout.write(`warm finished ${results.length} installs in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    const failed = results.filter(result => result.failure);
    for (const result of failed) process.stderr.write(`\n${result.label} failed:\n${result.failure}\n`);
    if (failed.length) process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    await registry.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
