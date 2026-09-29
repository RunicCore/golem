import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `npm run release:check` builds packages, scripts and tests once; every step
// here runs on that output.
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const steps: readonly (readonly [string, readonly string[]])[] = [
  ['public source', [process.execPath, '.build/scripts/public-source.js', 'check']],
  ['OpenAPI compliance', [process.execPath, '.build/packages/openapi-to-ts/compliance/generate-matrix.js', '--check']],
  ['test suites', ['npm', 'run', 'test:all:run']],
];
const started = Date.now();
for (const [label, [executable, ...args]] of steps) {
  const stepStarted = Date.now();
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', shell: executable === 'npm' && process.platform === 'win32' });
  if (result.error) throw result.error;
  process.stdout.write(`release:check ${label}: ${result.status === 0 ? 'passed' : 'failed'} in ${Math.round((Date.now() - stepStarted) / 1000)}s\n`);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
process.stdout.write(`release:check finished in ${Math.round((Date.now() - started) / 1000)}s\n`);
