import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileValidatorModule } from './support/compiled-validators.js';

// The structure check and the predicates-only pass of the validator compiler (`fastPath`): a root whose every path to
// a validation function is conjunctive gets both; a valid structure then costs the structure check and one call of each
// predicate, and the full validator runs only when the structure check fails.

const RULES = `
const calls = (globalThis.passCalls ??= []);
export const isEven = value => { calls.push('isEven'); return value % 2 === 0; };
export const isShort = value => { calls.push('isShort'); return value.length < 4 ? true : 'too long: ' + value; };
`;
const VALIDATIONS = {
  'rules.isEven': { importPath: './rules.mjs', exportName: 'isEven' },
  'rules.isShort': { importPath: './rules.mjs', exportName: 'isShort' },
};

const even = { exprtValidation: { schema: { type: 'integer' }, bindings: ['rules.isEven'] } };
const short = { exprtValidation: { schema: { type: 'string', minLength: 1 }, bindings: ['rules.isShort'] } };
// Predicates in a property, in array items, behind a `$ref` and in an `allOf` branch.
const ORDER = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer' },
    code: short,
    sizes: { type: 'array', items: even },
    nested: { $ref: '#/$defs/Nested' },
  },
  allOf: [{ properties: { extra: even } }],
  $defs: { Nested: { type: 'object', properties: { tag: short } } },
};
// The same rules under a union and under `contains`: today's path.
const UNION = { type: 'object', properties: { value: { anyOf: [even, { type: 'string' }] } } };
const CONTAINS = { type: 'array', contains: even };

function passCalls(): string[] {
  const calls: unknown = Reflect.get(globalThis, 'passCalls');
  return Array.isArray(calls) ? calls.map(String) : [];
}

async function compileOrder() {
  const module = await compileValidatorModule({ roots: { order: ORDER, union: UNION, contains: CONTAINS }, validations: VALIDATIONS, modules: { 'rules.mjs': RULES }, fastPath: true });
  return module;
}

test('the structure check accepts a valid structure and rejects a bad one without calling a predicate', async () => {
  // protects: T-468 structure check calls no predicate
  const module = await compileOrder();
  Reflect.set(globalThis, 'passCalls', []);
  const { structure } = module.passByRoot.order;
  assert.equal(structure({ id: 1, code: 'abcdef', sizes: [1, 3], nested: { tag: 'abcdef' }, extra: 5 }), true);
  assert.equal(structure({ id: 'x' }), false);
  assert.equal(structure({ id: 1, sizes: [2, 'x'] }), false);
  assert.equal(structure({ id: 1, nested: { tag: 7 } }), false);
  assert.deepEqual(passCalls(), []);
});

const VALID_STRUCTURE = [
  { id: 1, code: 'abcdef', sizes: [1, 2, 3, 4], nested: { tag: 'abcdef' }, extra: 5 },
  { id: 1, code: 'ab', sizes: [2, 3, 4, 5], nested: { tag: 'ab' }, extra: 6 },
  { id: 1, sizes: [3, 5, 7] },
  { id: 1, nested: { tag: 'toolong' }, extra: 3 },
  { id: 1 },
];

for (const all of [true, false]) {
  test(`the predicates-only pass reports the issues of the full validator for a valid structure, all-errors ${all}`, async () => {
    // protects: T-468 predicates-only pass same issues as the full validator
    const module = await compileOrder();
    const { predicates } = module.passByRoot.order;
    const results = VALID_STRUCTURE.map(value => {
      Reflect.set(globalThis, 'passCalls', []);
      const issues = predicates(value, all);
      const calls = passCalls();
      Reflect.set(globalThis, 'passCalls', []);
      assert.deepEqual(issues, module.byRoot.order(value, all));
      assert.deepEqual(calls, passCalls());
      return issues.length;
    });
    assert.deepEqual(results, all ? [5, 2, 3, 2, 0] : [1, 1, 1, 1, 0]);
  });
}

test('a root with a predicate under a union or contains gets no structure check and no predicates-only pass', async () => {
  // protects: T-468 non-conjunctive roots keep today's path
  const module = await compileOrder();
  assert.deepEqual(Object.keys(module.passByRoot), ['order']);
  assert.deepEqual(module.exportNames.filter(name => name.includes('union') || name.includes('contains')), ['validate_contains', 'validate_union']);
  assert.deepEqual(module.fastByRoot, {});
});
