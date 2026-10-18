import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  checkComplianceMatrix,
  writeComplianceMatrix,
} from '../../packages/golem-openapi/compliance/generate-matrix.js';

function currentPackageCopy(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-compliance-matrix-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'compliance'));
  writeComplianceMatrix(directory);
  return directory;
}

test('the compliance check passes when both generated files are current', (t) => {
  const directory = currentPackageCopy(t);
  assert.doesNotThrow(() => checkComplianceMatrix(directory));
});

test('the compliance check names each stale file and leaves the files unchanged', (t) => {
  const directory = currentPackageCopy(t);
  const matrix = path.join(directory, 'MATRIX.md');
  const capabilities = path.join(directory, 'compliance', 'capabilities.json');
  fs.writeFileSync(matrix, '# stale matrix\n');
  fs.writeFileSync(capabilities, '{}\n');

  assert.throws(
    () => checkComplianceMatrix(directory),
    (error: unknown) => error instanceof Error
      && error.message.startsWith(`The OpenAPI compliance files are stale: MATRIX.md, ${path.join('compliance', 'capabilities.json')}.`),
  );
  assert.equal(fs.readFileSync(matrix, 'utf8'), '# stale matrix\n');
  assert.equal(fs.readFileSync(capabilities, 'utf8'), '{}\n');
});
