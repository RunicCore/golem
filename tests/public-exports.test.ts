import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUniquePublicExports } from '#codegen/names';

const entry = "export * from './types.js';\nexport * from './schemas.js';\n";

test('a named re-export colliding with an export * name is rejected', () => {
  const modules = new Map([
    ['index.ts', entry],
    ['types.ts', 'export interface ValidationResult { ok: boolean }\n'],
    ['schemas.ts', "export {\n  validateWith,\n  type ValidationResult,\n} from '@exprtlabs/codegen/validation';\n"],
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
