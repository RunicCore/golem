import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_NAMES, copyMaintainedExample } from './maintained-examples.js';
import { preparedPackages, registryNpmrc, startRegistry } from './packed-registry.js';
import { THIRD_PARTY_INSTALLS } from './third-party-installs.js';

// Fill the npm cache with what the packed and browser tests install, so those
// tiers run offline. Runs only in `test:prepare`, which has network access.
const root = fileURLToPath(new URL('../../', import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

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
      output += `\nTimed out after ${INSTALL_TIMEOUT_MS} ms`;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    }, INSTALL_TIMEOUT_MS);
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

async function main(): Promise<void> {
  const started = Date.now();
  const registry = await startRegistry(preparedPackages(root));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fe-deps-warm-')));
  try {
    const installs: WarmInstall[] = [];
    const thirdParty = path.join(scratch, 'third-party');
    fs.mkdirSync(thirdParty);
    fs.writeFileSync(path.join(thirdParty, 'package.json'), JSON.stringify({ name: 'warm-third-party', version: '1.0.0', private: true }));
    installs.push({ label: 'third-party installs', directory: thirdParty, batches: installBatches(THIRD_PARTY_INSTALLS) });
    for (const name of EXAMPLE_NAMES) {
      const directory = path.join(scratch, name);
      fs.mkdirSync(directory);
      copyMaintainedExample(root, directory, name);
      fs.writeFileSync(path.join(directory, '.npmrc'), registryNpmrc(registry.url));
      installs.push({ label: `example ${name}`, directory, batches: [[]] });
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
