import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const executable = process.platform === 'win32' ? 'go.exe' : 'go';

/** The Go toolchain ttsc builds the golem plugin with: TTSC_GO_BINARY when set, otherwise the Go bundled in @ttsc/<platform>-<arch>. */
export function goBinary(): string {
  const explicit = process.env.TTSC_GO_BINARY;
  if (explicit) return explicit;
  const fromTtsc = createRequire(path.join(root, 'node_modules/ttsc/package.json'));
  try {
    return fromTtsc.resolve(`@ttsc/${process.platform}-${process.arch}/bin/go/bin/${executable}`);
  } catch {
    throw new Error(`ttsc's bundled Go for ${process.platform}-${process.arch} is missing. Reinstall with optional dependencies or set TTSC_GO_BINARY.`);
  }
}
