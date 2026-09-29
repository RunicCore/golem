import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_NAMES } from '../scripts/maintained-examples.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'packages/codegen/dist/bin/runic-codegen.js');

for (const example of EXAMPLE_NAMES) {
  test(`examples/${example} committed output matches the generator`, () => {
    const result = spawnSync(process.execPath, [cli, 'check'], {
      cwd: path.join(root, 'examples', example),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
