import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the codegen plugin's Go tests with the toolchain ttsc builds it with:
// TTSC_GO_BINARY when set, otherwise the Go bundled in @ttsc/<platform>-<arch>.
const root = fileURLToPath(new URL('../../', import.meta.url));
const executable = process.platform === 'win32' ? 'go.exe' : 'go';
function goBinary(): string {
  const explicit = process.env.TTSC_GO_BINARY;
  if (explicit) return explicit;
  const fromTtsc = createRequire(path.join(root, 'node_modules/ttsc/package.json'));
  try {
    return fromTtsc.resolve(`@ttsc/${process.platform}-${process.arch}/bin/go/bin/${executable}`);
  } catch {
    throw new Error(`ttsc's bundled Go for ${process.platform}-${process.arch} is missing. Reinstall with optional dependencies or set TTSC_GO_BINARY.`);
  }
}

const result = spawnSync(goBinary(), ['test', './...'], {
  cwd: path.join(root, 'packages/codegen/plugin'),
  env: { ...process.env, GOTOOLCHAIN: 'local' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
