import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EXAMPLE_NAMES } from './maintained-examples.js';

// Rewrite every maintained example's committed output with the workspace build.
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const example of EXAMPLE_NAMES) {
  const cwd = path.join(root, 'examples', example);
  const cli = path.join(root, 'packages/golem/dist/bin/golem.js');
  const result = spawnSync(process.execPath, [cli, 'generate'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
