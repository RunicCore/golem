import assert from 'node:assert/strict';
import { test } from 'node:test';
import { code, exportFrom, exportedName, exportedNames } from '#golem/code';
import { assertUniqueExportNames, assertUniquePublicExports } from '#golem/names';

const entry = "export * from './types.js';\nexport * from './schemas.js';\n";

test('a named re-export colliding with an export * name is rejected', () => {
  const modules = new Map([
    ['index.ts', entry],
    ['types.ts', 'export interface ValidationResult { ok: boolean }\n'],
    ['schemas.ts', "export {\n  validateWith,\n  type ValidationResult,\n} from '@exprtlabs/golem/validation';\n"],
  ]);
  assert.throws(() => assertUniquePublicExports(modules), /collision.*ValidationResult/);
});

test('a renamed named re-export claims the exported name, not the source name', () => {
  const collides = new Map([
    ['index.ts', entry],
    ['types.ts', 'export interface Money { amount: number }\n'],
    ['schemas.ts', "export type { Amount as Money } from './amount.js';\n"],
  ]);
  assert.throws(() => assertUniquePublicExports(collides), /collision.*Money/);
  const distinct = new Map([
    ['index.ts', entry],
    ['types.ts', 'export interface Amount { amount: number }\n'],
    ['schemas.ts', "export { Amount as Money } from './amount.js';\n"],
  ]);
  assert.doesNotThrow(() => assertUniquePublicExports(distinct));
});

test('distinct named re-exports and an index-level model re-export do not collide', () => {
  const modules = new Map([
    ['index.ts', "export * from './types.js';\nexport { TaskModel } from './models/Task.js';\nexport type { TaskFields } from './models/Task.js';\n"],
    ['types.ts', 'export interface Task { id: string }\n'],
  ]);
  assert.doesNotThrow(() => assertUniquePublicExports(modules));
});

test('the generator checks the exports of its modules from the names its Code holds', () => {
  // protects: T-330 assertUniqueExportNames reads export names from module values, not from emitted text
  const types = code`export interface ${exportedName('ValidationResult')} { ok: boolean }`;
  const schemas = exportFrom([['validate', 'validateWith'], 'ValidationResult'], '@exprtlabs/golem/validation', true);
  assert.deepEqual(exportedNames(schemas), ['validateWith', 'ValidationResult']);
  const modules = new Map([
    ['index.ts', { exports: [], stars: ['types.ts', 'schemas.ts'] }],
    ['types.ts', { exports: exportedNames(types), stars: [] }],
    ['schemas.ts', { exports: exportedNames(schemas), stars: [] }],
  ]);
  assert.throws(() => assertUniqueExportNames(modules), /collision.*ValidationResult/);
});
