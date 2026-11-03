import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { EXAMPLE_NAMES } from './maintained-examples.js';

// Generate every maintained example's files with the workspace build, so the editor resolves them. The examples commit none of them.
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const example of EXAMPLE_NAMES) {
  const cwd = path.join(root, 'examples', example);
  const cli = path.join(root, 'packages/golem/dist/bin/golem.js');
  // An example with several configurations defines its own `generate` script.
  const result = existsSync(path.join(cwd, 'golem.yaml'))
    ? spawnSync(process.execPath, [cli, 'generate'], { cwd, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'generate'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
