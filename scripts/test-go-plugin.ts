import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goBinary } from './go-binary.js';

// Run the codegen plugin's Go tests with the toolchain ttsc builds it with.
const root = fileURLToPath(new URL('../../', import.meta.url));

const result = spawnSync(goBinary(), ['test', './...'], {
  cwd: path.join(root, 'packages/golem/plugin'),
  env: { ...process.env, GOTOOLCHAIN: 'local' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
