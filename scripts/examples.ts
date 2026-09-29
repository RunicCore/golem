import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EXAMPLE_NAMES } from './maintained-examples.js';

// `generate` rewrites every maintained example with the workspace build;
// `check` fails when committed output differs from it. Packed release output
// is verified by tests/packed/examples.test.ts.
const action = process.argv[2];
if (action !== 'generate' && action !== 'check') {
  process.stderr.write('Usage: node .build/scripts/examples.js <generate|check>\n');
  process.exit(2);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const example of EXAMPLE_NAMES) {
  const cwd = path.join(root, 'examples', example);
  const cli = path.join(root, 'packages/codegen/dist/bin/runic-codegen.js');
  const result = spawnSync(process.execPath, [cli, action], { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
