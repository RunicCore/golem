import assert from 'node:assert/strict';
import { test } from 'node:test';
import { code, exportedName, exportedNames } from '#golem/code';
import { assertUniqueExportNames } from '#golem/names';

test('the generator checks the exports of its modules from the names its Code holds', () => {
  // protects: T-330 assertUniqueExportNames reads export names from module values, not from emitted text
  const types = code`export interface ${exportedName('ValidationResult')} { ok: boolean }`;
  const schemas = code`export type { ${exportedName('validateWith')}, ${exportedName('ValidationResult')} } from '@exprtlabs/golem/validation';`;
  assert.deepEqual(exportedNames(schemas), ['validateWith', 'ValidationResult']);
  const modules = new Map([
    ['index.ts', { exports: [], stars: ['types.ts', 'schemas.ts'] }],
    ['types.ts', { exports: exportedNames(types), stars: [] }],
    ['schemas.ts', { exports: exportedNames(schemas), stars: [] }],
  ]);
  assert.throws(() => assertUniqueExportNames(modules), /collision.*ValidationResult/);
});
