import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compile } from '@exprtlabs/golem/validator-compiler';

import { compileSchema, compileValidators } from './support/compiled-validators.js';

/** Asserts the all-errors result, then that fast-fail returns only the first of those issues. */
async function assertIssues(schema: unknown, value: unknown, expected: readonly object[]): Promise<void> {
  const validate = await compileSchema(schema);
  assert.deepEqual(validate(value, true), expected);
  assert.deepEqual(validate(value, false), expected.slice(0, 1));
}

test('type accepts one name or a list and reports the expected names', async () => {
  await assertIssues({ type: 'string' }, 5, [{ path: [], code: 'type', expected: ['string'] }]);
  await assertIssues({ type: ['string', 'null'] }, 5, [{ path: [], code: 'type', expected: ['string', 'null'] }]);
  await assertIssues({ type: ['string', 'null'] }, null, []);
  await assertIssues({ type: 'array' }, { length: 0 }, [{ path: [], code: 'type', expected: ['array'] }]);
  await assertIssues({ type: 'object' }, [], [{ path: [], code: 'type', expected: ['object'] }]);
  await assertIssues({ type: 'object' }, null, [{ path: [], code: 'type', expected: ['object'] }]);
});

test('type integer rejects 1.5 and accepts 1.0', async () => {
  await assertIssues({ type: 'integer' }, 1.5, [{ path: [], code: 'type', expected: ['integer'] }]);
  await assertIssues({ type: 'integer' }, 1.0, []);
  await assertIssues({ type: 'number' }, 1.5, []);
});

test('const and enum report the allowed values as a literal issue', async () => {
  await assertIssues({ const: { a: [1, 2] } }, { a: [1, 3] }, [{ path: [], code: 'literal', expected: [{ a: [1, 2] }] }]);
  await assertIssues({ const: { a: [1, 2] } }, { a: [1, 2] }, []);
  await assertIssues({ enum: [1, 'a', null] }, 'b', [{ path: [], code: 'literal', expected: [1, 'a', null] }]);
  await assertIssues({ enum: [1, 'a', null] }, null, []);
});

test('required reports each missing key with the path ending at the key', async () => {
  const schema = { type: 'object', required: ['a', 'b'] };
  await assertIssues(schema, { c: 1 }, [
    { path: ['a'], code: 'required', key: 'a' },
    { path: ['b'], code: 'required', key: 'b' },
  ]);
  await assertIssues(schema, { a: 1, b: 2 }, []);
  await assertIssues({ required: ['a'] }, 'text', []);
});

test('properties validate present keys at their own path', async () => {
  const schema = { properties: { a: { type: 'string' }, b: { properties: { c: { type: 'integer' } } } } };
  await assertIssues(schema, { a: 1, b: { c: 'x' } }, [
    { path: ['a'], code: 'type', expected: ['string'] },
    { path: ['b', 'c'], code: 'type', expected: ['integer'] },
  ]);
  await assertIssues(schema, {}, []);
});

test('additionalProperties false reports each unknown key with the path ending at the key; a schema checks each extra value', async () => {
  await assertIssues({ properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2, c: 3 }, [
    { path: ['b'], code: 'unknownKey', key: 'b' },
    { path: ['c'], code: 'unknownKey', key: 'c' },
  ]);
  await assertIssues({ properties: { a: {} }, additionalProperties: { type: 'integer' } }, { a: 'free', b: 'x', c: 3 }, [
    { path: ['b'], code: 'type', expected: ['integer'] },
  ]);
  await assertIssues({ properties: { a: {} }, additionalProperties: true }, { a: 1, b: 2 }, []);
});

test('prefixItems and items report the index in the path', async () => {
  const schema = { prefixItems: [{ type: 'string' }, { type: 'integer' }], items: { type: 'boolean' } };
  await assertIssues(schema, [1, 'x', 'y', true], [
    { path: [0], code: 'type', expected: ['string'] },
    { path: [1], code: 'type', expected: ['integer'] },
    { path: [2], code: 'type', expected: ['boolean'] },
  ]);
  await assertIssues(schema, ['a'], []);
});

test('items false reports one tooBig issue at the array with the prefix length as the limit', async () => {
  const tuple = { prefixItems: [{ type: 'string' }], items: false };
  await assertIssues(tuple, ['a', 1, 2], [{ path: [], code: 'tooBig', measure: 'items', limit: 1, inclusive: true }]);
  await assertIssues(tuple, ['a'], []);
  await assertIssues(tuple, [1, 2], [
    { path: [], code: 'tooBig', measure: 'items', limit: 1, inclusive: true },
    { path: [0], code: 'type', expected: ['string'] },
  ]);
  await assertIssues({ items: false }, [1, 2], [{ path: [], code: 'tooBig', measure: 'items', limit: 0, inclusive: true }]);
  await assertIssues({ items: false }, [], []);
});

test('if/then/else reports the issues of the branch that ran and none from if', async () => {
  const schema = { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['x'] }, else: { required: ['y'] } };
  await assertIssues(schema, { kind: 'a' }, [{ path: ['x'], code: 'required', key: 'x' }]);
  await assertIssues(schema, { kind: 'b' }, [{ path: ['y'], code: 'required', key: 'y' }]);
  await assertIssues(schema, { kind: 'a', x: 1 }, []);
  await assertIssues({ if: { type: 'string' }, then: { minLength: 3 } }, 'a', [{ path: [], code: 'tooSmall', measure: 'length', limit: 3, inclusive: true }]);
  await assertIssues({ if: { type: 'string' }, then: { minLength: 3 } }, 5, []);
  await assertIssues({ then: { type: 'string' }, else: { type: 'string' } }, 5, []);
});

test('dependentRequired reports each missing dependent key as required', async () => {
  const schema = { dependentRequired: { a: ['b', 'c'] } };
  await assertIssues(schema, { a: 1 }, [
    { path: ['b'], code: 'required', key: 'b' },
    { path: ['c'], code: 'required', key: 'c' },
  ]);
  await assertIssues(schema, { a: 1, b: 2, c: 3 }, []);
  await assertIssues(schema, { b: 2 }, []);
  await assertIssues(schema, 'text', []);
});

test('dependentSchemas applies the schema to the whole object when its trigger is present', async () => {
  const schema = { dependentSchemas: { card: { required: ['billing'], properties: { card: { type: 'integer' } } } } };
  await assertIssues(schema, { card: 'x' }, [
    { path: ['billing'], code: 'required', key: 'billing' },
    { path: ['card'], code: 'type', expected: ['integer'] },
  ]);
  await assertIssues(schema, { card: 1, billing: 'a' }, []);
  await assertIssues(schema, { other: 1 }, []);
});

test('patternProperties validate each matching key at its own path, and a matching key is not additional', async () => {
  const schema = { patternProperties: { '^x-': { type: 'integer' }, 'name$': { type: 'string' } }, additionalProperties: false };
  await assertIssues(schema, { 'x-a': 'no', fullname: 5, other: 1, 'x-name': true }, [
    { path: ['x-a'], code: 'type', expected: ['integer'] },
    { path: ['fullname'], code: 'type', expected: ['string'] },
    { path: ['x-name'], code: 'type', expected: ['integer'] },
    { path: ['x-name'], code: 'type', expected: ['string'] },
    { path: ['other'], code: 'unknownKey', key: 'other' },
  ]);
  await assertIssues(schema, { 'x-a': 1, fullname: 'n' }, []);
  await assertIssues({ patternProperties: { '^\\p{L}+$': { type: 'integer' } } }, { 'é': 'x', '1': 'y' }, [{ path: ['é'], code: 'type', expected: ['integer'] }]);
});

test('propertyNames reports invalidKey at the object for each key that fails', async () => {
  const schema = { propertyNames: { maxLength: 3 } };
  await assertIssues(schema, { abcd: 1, ok: 2, wxyz: 3 }, [
    { path: [], code: 'invalidKey', key: 'abcd' },
    { path: [], code: 'invalidKey', key: 'wxyz' },
  ]);
  await assertIssues(schema, { ok: 1 }, []);
  await assertIssues({ properties: { inner: { propertyNames: { pattern: '^a' } } } }, { inner: { b: 1 } }, [{ path: ['inner'], code: 'invalidKey', key: 'b' }]);
});

test('contains with minContains and maxContains reports the number of matches', async () => {
  const schema = { contains: { type: 'integer' }, minContains: 2, maxContains: 3 };
  await assertIssues(schema, ['a', 1], [{ path: [], code: 'tooSmall', measure: 'matches', limit: 2, inclusive: true }]);
  await assertIssues(schema, [1, 2, 3, 4], [{ path: [], code: 'tooBig', measure: 'matches', limit: 3, inclusive: true }]);
  await assertIssues(schema, [1, 'a', 2], []);
  await assertIssues({ contains: { type: 'string' } }, [1], [{ path: [], code: 'tooSmall', measure: 'matches', limit: 1, inclusive: true }]);
  await assertIssues({ contains: { type: 'string' } }, [], [{ path: [], code: 'tooSmall', measure: 'matches', limit: 1, inclusive: true }]);
  await assertIssues({ contains: { type: 'string' }, minContains: 0 }, [1], []);
  await assertIssues({ minContains: 2, maxContains: 1 }, [1, 2, 3], []);
  await assertIssues({ contains: { type: 'string' } }, 'text', []);
});

test('unevaluatedItems false reports one tooBig issue with the number of evaluated items as the limit', async () => {
  const tuple = { prefixItems: [{ type: 'string' }], unevaluatedItems: false };
  await assertIssues(tuple, ['a', 1, 2], [{ path: [], code: 'tooBig', measure: 'items', limit: 1, inclusive: true }]);
  await assertIssues(tuple, ['a'], []);
  await assertIssues({ contains: { const: 1 }, unevaluatedItems: false }, [1, 2, 1, 3], [{ path: [], code: 'tooBig', measure: 'items', limit: 2, inclusive: true }]);
  await assertIssues({ prefixItems: [{}], unevaluatedItems: { type: 'integer' } }, ['a', 'b', 3], [{ path: [1], code: 'type', expected: ['integer'] }]);
  await assertIssues({ items: true, unevaluatedItems: false }, [1, 2], []);
});

test('unevaluated keys count only branches that passed', async () => {
  const anyOf = {
    anyOf: [
      { properties: { a: { type: 'integer' } }, required: ['a'] },
      { properties: { b: { type: 'integer' } }, required: ['b'] },
    ],
    unevaluatedProperties: false,
  };
  await assertIssues(anyOf, { a: 1, b: 'x' }, [{ path: ['b'], code: 'unknownKey', key: 'b' }]);
  await assertIssues(anyOf, { a: 1, b: 2 }, []);
  const conditional = { if: { properties: { a: { const: 1 } }, required: ['a'] }, then: { properties: { b: {} } }, unevaluatedProperties: false };
  await assertIssues(conditional, { a: 2, b: 1 }, [
    { path: ['a'], code: 'unknownKey', key: 'a' },
    { path: ['b'], code: 'unknownKey', key: 'b' },
  ]);
  await assertIssues(conditional, { a: 1, b: 1 }, []);
  await assertIssues({ not: { properties: { a: { type: 'string' } } }, unevaluatedProperties: false }, { a: 1 }, [{ path: ['a'], code: 'unknownKey', key: 'a' }]);
  const oneOf = {
    oneOf: [
      { properties: { a: { type: 'integer' } }, required: ['a'] },
      { properties: { b: { type: 'integer' } }, required: ['b'] },
    ],
    unevaluatedProperties: false,
  };
  await assertIssues(oneOf, { a: 1 }, []);
  await assertIssues(oneOf, { b: 2 }, []);
  await assertIssues(oneOf, { a: 1, b: 'x' }, [{ path: ['b'], code: 'unknownKey', key: 'b' }]);
});

test('unevaluated keys see through $ref and in-place allOf, but not into cousins or other values', async () => {
  const viaRef = { $defs: { base: { properties: { a: {} } } }, $ref: '#/$defs/base', properties: { b: {} }, unevaluatedProperties: false };
  await assertIssues(viaRef, { a: 1, b: 2, c: 3 }, [{ path: ['c'], code: 'unknownKey', key: 'c' }]);
  const cousins = { allOf: [{ properties: { a: {} } }, { unevaluatedProperties: false }] };
  await assertIssues(cousins, { a: 1 }, [{ path: ['a'], code: 'unknownKey', key: 'a' }]);
  const nested = { properties: { a: { properties: { b: {} }, unevaluatedProperties: false } }, unevaluatedProperties: false };
  await assertIssues(nested, { a: { b: 1, c: 2 } }, [{ path: ['a', 'c'], code: 'unknownKey', key: 'c' }]);
});

test('a discriminator on a oneOf runs only the selected variant and reports an unknown tag as a literal', async () => {
  const schema = {
    oneOf: [
      { properties: { kind: { const: 'a' }, x: { type: 'integer' } }, required: ['kind'] },
      { properties: { kind: { enum: ['b', 'c'] }, y: { type: 'string' } }, required: ['kind'] },
    ],
    discriminator: { propertyName: 'kind' },
  };
  await assertIssues(schema, { kind: 'a', x: 'no' }, [{ path: ['x'], code: 'type', expected: ['integer'] }]);
  await assertIssues(schema, { kind: 'c', y: 1 }, [{ path: ['y'], code: 'type', expected: ['string'] }]);
  await assertIssues(schema, { kind: 'a', x: 1 }, []);
  await assertIssues(schema, { kind: 'z' }, [{ path: ['kind'], code: 'literal', expected: ['a', 'b', 'c'] }]);
  await assertIssues(schema, {}, [{ path: ['kind'], code: 'literal', expected: ['a', 'b', 'c'] }]);
  await assertIssues(schema, 'text', [{ path: ['kind'], code: 'literal', expected: ['a', 'b', 'c'] }]);
  // Without the discriminator the same data is an ordinary oneOf failure.
  await assertIssues({ oneOf: schema.oneOf }, { kind: 'a', x: 'no' }, [{ path: [], code: 'union', matched: 0 }]);
});

test('a discriminator follows $ref branches, in $defs or another resource, and an allOf that states the tag', async () => {
  const validators = await compileValidators({
    roots: {
      pet: {
        $defs: {
          cat: { properties: { kind: { const: 'cat' }, lives: { type: 'integer' } }, required: ['kind'] },
          dog: { allOf: [{ $ref: 'TDogBase' }, { properties: { kind: { enum: ['dog', 'hound'] } } }] },
        },
        oneOf: [{ $ref: '#/$defs/cat' }, { $ref: '#/$defs/dog' }, { $ref: 'TBird' }],
        discriminator: { propertyName: 'kind' },
      },
    },
    resources: {
      TDogBase: { properties: { barks: { type: 'boolean' } } },
      TBird: { $ref: '#/$defs/bird', $defs: { bird: { properties: { kind: { const: 'bird' }, wings: { type: 'integer' } } } } },
    },
  });
  assert.deepEqual(validators.pet({ kind: 'cat', lives: 'nine' }, true), [{ path: ['lives'], code: 'type', expected: ['integer'] }]);
  assert.deepEqual(validators.pet({ kind: 'hound', barks: 1 }, true), [{ path: ['barks'], code: 'type', expected: ['boolean'] }]);
  assert.deepEqual(validators.pet({ kind: 'bird', wings: 'two' }, true), [{ path: ['wings'], code: 'type', expected: ['integer'] }]);
  assert.deepEqual(validators.pet({ kind: 'cat', lives: 9 }, true), []);
  assert.deepEqual(validators.pet({ kind: 'fish' }, true), [{ path: ['kind'], code: 'literal', expected: ['cat', 'dog', 'hound', 'bird'] }]);
});

test('a discriminator over two $ref branches reports only the selected branch', async () => {
  const schema = {
    $defs: {
      a: { properties: { kind: { const: 'a' }, x: { type: 'integer' } } },
      b: { properties: { kind: { const: 'b' }, y: { type: 'string' } } },
    },
    oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }],
    discriminator: { propertyName: 'kind' },
  };
  await assertIssues(schema, { kind: 'a', x: 'no' }, [{ path: ['x'], code: 'type', expected: ['integer'] }]);
  await assertIssues(schema, { kind: 'z' }, [{ path: ['kind'], code: 'literal', expected: ['a', 'b'] }]);
  await assertIssues(schema, { kind: 'b', y: 'ok' }, []);
});

test('a discriminator is an annotation unless every branch states its own tag values', async () => {
  const annotated = { oneOf: [{ type: 'string' }, { type: 'integer' }], discriminator: { propertyName: 'kind' } };
  await assertIssues(annotated, true, [{ path: [], code: 'union', matched: 0 }]);
  const shared = { oneOf: [{ properties: { kind: { const: 'a' } } }, { properties: { kind: { const: 'a' } } }], discriminator: { propertyName: 'kind' } };
  await assertIssues(shared, { kind: 'a' }, [{ path: [], code: 'union', matched: 2 }]);
});

test('minLength and maxLength count code points', async () => {
  await assertIssues({ minLength: 2 }, '\u{1F600}', [{ path: [], code: 'tooSmall', measure: 'length', limit: 2, inclusive: true }]);
  await assertIssues({ maxLength: 2 }, '\u{1F600}'.repeat(3), [{ path: [], code: 'tooBig', measure: 'length', limit: 2, inclusive: true }]);
  await assertIssues({ maxLength: 2 }, '\u{1F600}'.repeat(2), []);
  await assertIssues({ minLength: 2 }, 1, []);
});

test('minimum and exclusiveMaximum report the value limit and whether it is inclusive', async () => {
  await assertIssues({ minimum: 5 }, 4, [{ path: [], code: 'tooSmall', measure: 'value', limit: 5, inclusive: true }]);
  await assertIssues({ minimum: 5 }, 5, []);
  await assertIssues({ exclusiveMaximum: 10 }, 10, [{ path: [], code: 'tooBig', measure: 'value', limit: 10, inclusive: false }]);
  await assertIssues({ exclusiveMinimum: 0 }, 0, [{ path: [], code: 'tooSmall', measure: 'value', limit: 0, inclusive: false }]);
  await assertIssues({ maximum: 3 }, 4, [{ path: [], code: 'tooBig', measure: 'value', limit: 3, inclusive: true }]);
  await assertIssues({ maximum: 3 }, 'big', []);
});

test('minItems, maxItems, minProperties and maxProperties report their measure', async () => {
  await assertIssues({ minItems: 2 }, [1], [{ path: [], code: 'tooSmall', measure: 'items', limit: 2, inclusive: true }]);
  await assertIssues({ maxItems: 1 }, [1, 2], [{ path: [], code: 'tooBig', measure: 'items', limit: 1, inclusive: true }]);
  await assertIssues({ minProperties: 1 }, {}, [{ path: [], code: 'tooSmall', measure: 'properties', limit: 1, inclusive: true }]);
  await assertIssues({ maxProperties: 1 }, { a: 1, b: 2 }, [{ path: [], code: 'tooBig', measure: 'properties', limit: 1, inclusive: true }]);
});

test('pattern reports the source and ignores non-strings', async () => {
  await assertIssues({ pattern: '^a+$' }, 'b', [{ path: [], code: 'pattern', pattern: '^a+$' }]);
  await assertIssues({ pattern: '^a+$' }, 'aa', []);
  await assertIssues({ pattern: '^a+$' }, 7, []);
  await assertIssues({ pattern: '^\\p{L}$' }, 'é', []);
});

test('format reports a known format that does not match', async () => {
  await assertIssues({ format: 'ipv4' }, '999.1.1.1', [{ path: [], code: 'format', format: 'ipv4' }]);
  await assertIssues({ format: 'ipv4' }, '10.0.0.1', []);
  await assertIssues({ format: 'int32' }, 2 ** 31, [{ path: [], code: 'format', format: 'int32' }]);
  await assertIssues({ format: 'ipv4' }, 7, []);
});

test('multipleOf tolerates binary rounding: 0.3 is a multiple of 0.1', async () => {
  await assertIssues({ multipleOf: 0.1 }, 0.3, []);
  await assertIssues({ multipleOf: 0.0001 }, 0.0075, []);
  await assertIssues({ multipleOf: 0.1 }, 0.35, [{ path: [], code: 'multipleOf', divisor: 0.1 }]);
  await assertIssues({ multipleOf: 2 }, 7, [{ path: [], code: 'multipleOf', divisor: 2 }]);
  await assertIssues({ multipleOf: 0.123456789 }, 1e308, [{ path: [], code: 'multipleOf', divisor: 0.123456789 }]);
});

test('uniqueItems reports the first duplicate pair by index', async () => {
  await assertIssues({ uniqueItems: true }, [1, { a: [1] }, 2, { a: [1] }], [{ path: [], code: 'unique', indexes: [1, 3] }]);
  await assertIssues({ uniqueItems: true }, [1, 2, 1, 2], [{ path: [], code: 'unique', indexes: [0, 2] }]);
  await assertIssues({ uniqueItems: true }, [1, '1', true, null], []);
  await assertIssues({ uniqueItems: false }, [1, 1], []);
});

test('allOf reports the issues of every failing branch', async () => {
  await assertIssues({ allOf: [{ minLength: 3 }, { pattern: '^b' }, { type: 'string' }] }, 'a', [
    { path: [], code: 'tooSmall', measure: 'length', limit: 3, inclusive: true },
    { path: [], code: 'pattern', pattern: '^b' },
  ]);
});

test('anyOf and oneOf without a discriminator report a union with the matched count', async () => {
  const anyOf = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  await assertIssues(anyOf, true, [{ path: [], code: 'union', matched: 0 }]);
  await assertIssues(anyOf, 'a', []);
  const oneOf = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  await assertIssues(oneOf, 1, [{ path: [], code: 'union', matched: 2 }]);
  await assertIssues(oneOf, 1.5, []);
  await assertIssues(oneOf, 'a', [{ path: [], code: 'union', matched: 0 }]);
});

test('a union reports its own path, not the paths inside its branches', async () => {
  await assertIssues({ properties: { a: { anyOf: [{ type: 'string' }, { required: ['x'] }] } } }, { a: {} }, [
    { path: ['a'], code: 'union', matched: 0 },
  ]);
});

test('not reports an issue when its schema matches', async () => {
  await assertIssues({ not: { type: 'string' } }, 'a', [{ path: [], code: 'not' }]);
  await assertIssues({ not: { type: 'string' } }, 1, []);
});

test('a false schema reports never and a true schema accepts anything', async () => {
  await assertIssues(false, 1, [{ path: [], code: 'never' }]);
  await assertIssues({ properties: { a: false } }, { a: 1 }, [{ path: ['a'], code: 'never' }]);
  await assertIssues({ properties: { a: false } }, {}, []);
  await assertIssues(true, { anything: [1, null] }, []);
  await assertIssues({}, 'x', []);
});

test('$ref to $defs resolves for every referrer', async () => {
  const schema = {
    $defs: { name: { type: 'string', minLength: 1 } },
    properties: { first: { $ref: '#/$defs/name' }, last: { $ref: '#/$defs/name' } },
  };
  await assertIssues(schema, { first: '', last: 3 }, [
    { path: ['first'], code: 'tooSmall', measure: 'length', limit: 1, inclusive: true },
    { path: ['last'], code: 'type', expected: ['string'] },
  ]);
});

test('$ref resolves to another root by absolute and relative $id', async () => {
  const validators = await compileValidators({
    roots: {
      item: { $id: 'https://example.com/schemas/item.json', type: 'integer' },
      list: {
        $id: 'https://example.com/schemas/list.json',
        properties: { absolute: { $ref: 'https://example.com/schemas/item.json' }, relative: { $ref: 'item.json' } },
      },
    },
  });
  assert.deepEqual(validators.list({ absolute: 'x', relative: 'y' }, true), [
    { path: ['absolute'], code: 'type', expected: ['integer'] },
    { path: ['relative'], code: 'type', expected: ['integer'] },
  ]);
  assert.deepEqual(validators.list({ absolute: 1, relative: 2 }, true), []);
});

test('$ref reaches a resource by its $id, its name and a $anchor', async () => {
  const validators = await compileValidators({
    roots: {
      root: {
        properties: {
          byId: { $ref: 'https://example.com/id.json' },
          byName: { $ref: 'TNamed' },
          byAnchor: { $ref: 'https://example.com/id.json#positive' },
        },
      },
    },
    resources: {
      'https://example.com/id.json': { $id: 'https://example.com/id.json', $defs: { positive: { $anchor: 'positive', minimum: 1 } }, type: 'string' },
      TNamed: { type: 'boolean' },
    },
  });
  assert.deepEqual(validators.root({ byId: 1, byName: 'x', byAnchor: 0 }, true), [
    { path: ['byId'], code: 'type', expected: ['string'] },
    { path: ['byName'], code: 'type', expected: ['boolean'] },
    { path: ['byAnchor'], code: 'tooSmall', measure: 'value', limit: 1, inclusive: true },
  ]);
});

test('$ref by JSON pointer decodes ~0, ~1 and percent escapes', async () => {
  const schema = {
    $defs: { 'a/b': { type: 'string' }, 'm~n': { type: 'integer' }, 'p q': { type: 'boolean' } },
    properties: { slash: { $ref: '#/$defs/a~1b' }, tilde: { $ref: '#/$defs/m~0n' }, space: { $ref: '#/$defs/p%20q' } },
  };
  await assertIssues(schema, { slash: 1, tilde: 'x', space: 'y' }, [
    { path: ['slash'], code: 'type', expected: ['string'] },
    { path: ['tilde'], code: 'type', expected: ['integer'] },
    { path: ['space'], code: 'type', expected: ['boolean'] },
  ]);
});

test('a nested $id changes the base a relative $ref inside it resolves against', async () => {
  const validators = await compileValidators({
    roots: {
      root: {
        $id: 'https://e.com/a/root.json',
        properties: {
          outer: { $ref: 'sibling.json' },
          inner: { $id: 'https://e.com/b/sub.json', properties: { value: { $ref: 'sibling.json' } } },
        },
      },
    },
    resources: {
      'https://e.com/a/sibling.json': { type: 'string' },
      'https://e.com/b/sibling.json': { type: 'integer' },
    },
  });
  assert.deepEqual(validators.root({ outer: 1, inner: { value: 'x' } }, true), [
    { path: ['outer'], code: 'type', expected: ['string'] },
    { path: ['inner', 'value'], code: 'type', expected: ['integer'] },
  ]);
  assert.deepEqual(validators.root({ outer: 'x', inner: { value: 1 } }, true), []);
});

test('$ref reaches a root or resource whose name contains #', async () => {
  const validators = await compileValidators({
    roots: {
      'TPayment_1234abcd#wire': { type: 'integer' },
      holder: { properties: { payment: { $ref: 'TPayment_1234abcd#wire' }, other: { $ref: 'TOther_9f9f#model-only' }, self: { $ref: '#/$defs/n' } }, $defs: { n: { type: 'boolean' } } },
    },
    resources: { 'TOther_9f9f#model-only': { type: 'string' } },
  });
  assert.deepEqual(validators.holder({ payment: 'x', other: 1, self: 2 }, true), [
    { path: ['payment'], code: 'type', expected: ['integer'] },
    { path: ['other'], code: 'type', expected: ['string'] },
    { path: ['self'], code: 'type', expected: ['boolean'] },
  ]);
});

test('quotes, backslashes, backticks, template syntax and U+2028 in names, keys, patterns and values stay data', async () => {
  const awkward = 'a"b\\c`d${1}e\u2028f';
  // The same text as a regular expression: the backslash and the template braces need escapes.
  const awkwardPattern = '^a"b\\\\c`d\\$\\{1\\}e\u2028f$';
  const validators = await compileValidators({
    roots: {
      [awkward]: { properties: { [awkward]: { enum: [awkward, 1] } }, required: [awkward] },
      pattern: { pattern: awkwardPattern },
    },
  });
  assert.deepEqual(validators[awkward]({ [awkward]: awkward }, true), []);
  assert.deepEqual(validators[awkward]({ [awkward]: 'other' }, true), [{ path: [awkward], code: 'literal', expected: [awkward, 1] }]);
  assert.deepEqual(validators[awkward]({}, true), [{ path: [awkward], code: 'required', key: awkward }]);
  assert.deepEqual(validators.pattern(awkward, true), []);
  assert.deepEqual(validators.pattern('a"b', true), [{ path: [], code: 'pattern', pattern: awkwardPattern }]);
});

test('recursive $ref validates a three-level tree and reports the deepest path', async () => {
  const schema = {
    type: 'object',
    required: ['value'],
    properties: { value: { type: 'integer' }, children: { type: 'array', items: { $ref: '#' } } },
  };
  const tree = { value: 1, children: [{ value: 2 }, { value: 3, children: [{ value: 4 }, { value: 'deep' }] }] };
  await assertIssues(schema, tree, [{ path: ['children', 1, 'children', 1, 'value'], code: 'type', expected: ['integer'] }]);
  await assertIssues(schema, { value: 1, children: [{ value: 2, children: [{ value: 3, children: [{}] }] }] }, [
    { path: ['children', 0, 'children', 0, 'children', 0, 'value'], code: 'required', key: 'value' },
  ]);
});

test('own-property checks hold for __proto__ and constructor keys', async () => {
  const schema = JSON.parse('{"properties":{"__proto__":{"type":"integer"},"constructor":{"type":"integer"},"toString":{}},"required":["__proto__","constructor","toString"],"additionalProperties":false}') as unknown;
  const validate = await compileSchema(schema);
  assert.deepEqual(validate({}, true), [
    { path: ['__proto__'], code: 'required', key: '__proto__' },
    { path: ['constructor'], code: 'required', key: 'constructor' },
    { path: ['toString'], code: 'required', key: 'toString' },
  ]);
  assert.deepEqual(validate(JSON.parse('{"__proto__":1,"constructor":2,"toString":3}'), true), []);
  assert.deepEqual(validate(JSON.parse('{"__proto__":"x","constructor":2,"toString":3}'), true), [
    { path: ['__proto__'], code: 'type', expected: ['integer'] },
  ]);
  const undeclared = await compileSchema({ additionalProperties: false });
  assert.deepEqual(undeclared(JSON.parse('{"__proto__":1,"constructor":2}'), true), [
    { path: ['__proto__'], code: 'unknownKey', key: '__proto__' },
    { path: ['constructor'], code: 'unknownKey', key: 'constructor' },
  ]);
});

test('root names with # and - become valid function names and verbatim keys', async () => {
  const names = ['TPayment_1234abcd#wire', 'list-items', '#', '__proto__'];
  const validators = await compileValidators({ roots: Object.fromEntries(names.map(name => [name, { type: 'integer' }])) });
  assert.deepEqual(Object.keys(validators).sort(), [...names].sort());
  for (const name of names) {
    assert.match(Object.getOwnPropertyDescriptor(validators, name)?.value.name, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(validators, name)?.value('x', true), [{ path: [], code: 'type', expected: ['integer'] }]);
  }
});

test('$dynamicRef is an unsupported keyword error at its JSON pointer and leaves no source', () => {
  const result = compile(
    { roots: new Map([['root', { properties: { a: { $dynamicRef: '#node' } } }]]) },
    { unknownFormats: 'warn', documentName: 'orders.yaml' },
  );
  assert.equal(result.source, '');
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic.code, 'VALIDATE_UNSUPPORTED_KEYWORD');
  assert.equal(diagnostic.severity, GolemDiagnosticSeverity.Error);
  assert.equal(diagnostic.file, 'orders.yaml');
  assert.equal(diagnostic.path, '/properties/a/$dynamicRef');
  assert.match(diagnostic.message, /orders\.yaml/);
  assert.match(diagnostic.message, /\/properties\/a\/\$dynamicRef/);
});

test('a $ref chain that returns to itself without reading the value is an error at its first $ref', () => {
  const chain = compile(
    { roots: new Map([['a', { $ref: 'b' }]]), resources: new Map([['b', { $ref: 'c' }], ['c', { $ref: 'b' }]]) },
    { unknownFormats: 'warn' },
  );
  assert.equal(chain.source, '');
  assert.deepEqual(chain.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
    ['VALIDATE_REF_CYCLE', GolemDiagnosticSeverity.Error, '/$ref'],
  ]);
  assert.match(chain.diagnostics[0].message, /schema "b"/);
  const self = compile({ roots: new Map([['root', { type: 'object', $ref: '#' }]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(self.diagnostics.map(entry => [entry.code, entry.path]), [['VALIDATE_REF_CYCLE', '/$ref']]);
  const branch = compile({ roots: new Map([['root', { anyOf: [{ type: 'string' }, { $ref: '#' }] }]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(branch.diagnostics.map(entry => [entry.code, entry.path]), [['VALIDATE_REF_CYCLE', '/anyOf/1/$ref']]);
});

test('a same-value cycle through if/then or dependentSchemas is an error at its $ref', () => {
  const conditional = compile({ roots: new Map([['root', { if: { type: 'object' }, then: { $ref: '#' } }]]) }, { unknownFormats: 'warn' });
  assert.equal(conditional.source, '');
  assert.deepEqual(conditional.diagnostics.map(entry => [entry.code, entry.path]), [['VALIDATE_REF_CYCLE', '/then/$ref']]);
  const dependent = compile({ roots: new Map([['root', { dependentSchemas: { a: { $ref: '#' } } }]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(dependent.diagnostics.map(entry => [entry.code, entry.path]), [['VALIDATE_REF_CYCLE', '/dependentSchemas/a/$ref']]);
});

test('a schema that contains itself compiles and validates, or reports a cycle, without overflowing the stack', async () => {
  const tree: Record<string, unknown> = { type: 'object', properties: {}, unevaluatedProperties: false };
  (tree.properties as Record<string, unknown>).self = tree;
  await assertIssues(tree, { self: { self: 1 } }, [{ path: ['self', 'self'], code: 'type', expected: ['object'] }]);
  await assertIssues(tree, { self: { other: 1 } }, [{ path: ['self', 'other'], code: 'unknownKey', key: 'other' }]);
  const loop: Record<string, unknown> = { type: 'object' };
  loop.allOf = [loop];
  const result = compile({ roots: new Map([['root', loop]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(result.diagnostics.map(entry => entry.code), ['VALIDATE_REF_CYCLE']);
});

test('$dynamicAnchor is an unsupported keyword error', () => {
  const result = compile({ roots: new Map([['root', { $ref: '#/$defs/node', $defs: { node: { $dynamicAnchor: 'node' } } }]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(result.diagnostics.map(entry => [entry.code, entry.path]), [['VALIDATE_UNSUPPORTED_KEYWORD', '/$defs/node/$dynamicAnchor']]);
});

test('a $ref that does not resolve is an error naming the reference', () => {
  const result = compile(
    { roots: new Map([['root', { properties: { a: { $ref: '#/$defs/missing' } } }]]) },
    { unknownFormats: 'warn', documentName: 'orders.yaml' },
  );
  assert.equal(result.source, '');
  assert.deepEqual(result.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
    ['VALIDATE_UNRESOLVED_REF', GolemDiagnosticSeverity.Error, '/properties/a/$ref'],
  ]);
  assert.match(result.diagnostics[0].message, /#\/\$defs\/missing/);
  assert.match(result.diagnostics[0].message, /orders\.yaml/);
});

test('a pattern that is not a valid unicode regular expression is an error', () => {
  const result = compile({ roots: new Map([['root', { properties: { a: { pattern: '[' } } }]]) }, { unknownFormats: 'warn' });
  assert.equal(result.source, '');
  assert.deepEqual(result.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
    ['VALIDATE_INVALID_PATTERN', GolemDiagnosticSeverity.Error, '/properties/a/pattern'],
  ]);
});

test('an unknown format warns and accepts any string, or fails with unknownFormats error', async () => {
  const schema = { type: 'string', format: 'color' };
  const warned = compile({ roots: new Map([['root', schema]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(warned.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
    ['VALIDATE_UNKNOWN_FORMAT', GolemDiagnosticSeverity.Warning, '/format'],
  ]);
  assert.notEqual(warned.source, '');
  await assertIssues(schema, 'not a color', []);
  const failed = compile({ roots: new Map([['root', schema]]) }, { unknownFormats: 'error' });
  assert.equal(failed.source, '');
  assert.deepEqual(failed.diagnostics.map(entry => [entry.code, entry.severity]), [['VALIDATE_UNKNOWN_FORMAT', GolemDiagnosticSeverity.Error]]);
});

test('a patternProperties key that is not a valid unicode regular expression is an error at that key', () => {
  const result = compile({ roots: new Map([['root', { patternProperties: { '[': { type: 'string' } } }]]) }, { unknownFormats: 'warn' });
  assert.equal(result.source, '');
  assert.deepEqual(result.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
    ['VALIDATE_INVALID_PATTERN', GolemDiagnosticSeverity.Error, '/patternProperties/['],
  ]);
});

test('diagnostics from every root are collected before the source is withheld', () => {
  const result = compile(
    { roots: new Map<string, unknown>([['a', { pattern: '(' }], ['b', { $ref: '#/missing' }]]) },
    { unknownFormats: 'warn' },
  );
  assert.equal(result.source, '');
  assert.deepEqual(result.diagnostics.map(entry => entry.code), ['VALIDATE_INVALID_PATTERN', 'VALIDATE_UNRESOLVED_REF']);
});

// golem's own keywords

const MODEL_CODEC_IDS = Symbol.for('@exprtlabs/golem:modelCodecIds');

/** A class whose prototype lists `ids` the way a registered model does. */
function modelClass(...ids: string[]): new () => object {
  const model = class {};
  Object.defineProperty(model.prototype, MODEL_CODEC_IDS, { value: ids });
  return model;
}

test('golemModelInstance accepts an instance of the selected class and reports another or none', async () => {
  const Cat = modelClass('Cat');
  const Dog = modelClass('Dog');
  const schema = { golemModelInstance: { of: 'Cat', among: ['Cat', 'Dog'], required: true } };
  await assertIssues(schema, new Cat(), []);
  await assertIssues(schema, new Dog(), [{ path: [], code: 'instance', model: 'Cat' }]);
  await assertIssues(schema, { name: 'plain' }, [{ path: [], code: 'instance', model: 'Cat' }]);
  await assertIssues(schema, 'text', [{ path: [], code: 'instance', model: 'Cat' }]);
  await assertIssues(schema, null, [{ path: [], code: 'instance', model: 'Cat' }]);
});

test('golemModelInstance follows the prototype chain to the most derived registered class', async () => {
  const Base = modelClass('Base');
  class Plain extends Base {}
  class Derived extends Base {}
  Object.defineProperty(Derived.prototype, MODEL_CODEC_IDS, { value: ['Derived'] });
  const schema = { golemModelInstance: { of: 'Base', among: ['Base', 'Derived'], required: true } };
  await assertIssues(schema, new Plain(), []);
  await assertIssues(schema, new Derived(), [{ path: [], code: 'instance', model: 'Base' }]);
  await assertIssues({ golemModelInstance: { of: 'Derived', among: ['Base', 'Derived'], required: true } }, new Derived(), []);
});

test('golemModelInstance without required lets a plain object through when it names a class, and without a class rejects any instance', async () => {
  const Cat = modelClass('Cat');
  const named = { golemModelInstance: { of: 'Cat', among: ['Cat', 'Dog'], required: false } };
  await assertIssues(named, { name: 'plain' }, []);
  await assertIssues(named, new Cat(), []);
  const anonymous = { golemModelInstance: { among: ['Cat', 'Dog'], required: false } };
  await assertIssues(anonymous, { name: 'plain' }, []);
  await assertIssues(anonymous, new Cat(), [{ path: [], code: 'instance', model: 'Cat' }]);
  const Dog = modelClass('Dog');
  await assertIssues({ golemModelInstance: { among: ['Dog', 'Cat'], required: false } }, new Dog(), [{ path: [], code: 'instance', model: 'Dog' }]);
});

test('golemModelInstance matches a hashed codec id exactly and an unhashed name against its hashed ids', async () => {
  const Order = modelClass('Order_1a2b3c4d');
  await assertIssues({ golemModelInstance: { of: 'Order_1a2b3c4d', among: ['Order_1a2b3c4d'], required: true } }, new Order(), []);
  await assertIssues({ golemModelInstance: { of: 'Order', among: ['Order'], required: true } }, new Order(), []);
  await assertIssues({ golemModelInstance: { of: 'Order_ffffffff', among: ['Order_ffffffff'], required: true } }, new Order(), [
    { path: [], code: 'instance', model: 'Order_ffffffff' },
  ]);
  await assertIssues({ golemModelInstance: { of: 'Ord', among: ['Ord'], required: true } }, new Order(), [{ path: [], code: 'instance', model: 'Ord' }]);
});

test('golemModelInstance reports at the path of the value it checks', async () => {
  const Cat = modelClass('Cat');
  const schema = { properties: { pet: { golemModelInstance: { of: 'Cat', among: ['Cat'], required: true } } } };
  await assertIssues(schema, { pet: new Cat() }, []);
  await assertIssues(schema, { pet: {} }, [{ path: ['pet'], code: 'instance', model: 'Cat' }]);
});

test('golemModelDate accepts a valid Date and reports a Date type issue for anything else', async () => {
  const schema = { golemModelDate: true };
  await assertIssues(schema, new Date(0), []);
  await assertIssues(schema, '2024-01-01T00:00:00Z', [{ path: [], code: 'type', expected: ['Date'] }]);
  await assertIssues(schema, 0, [{ path: [], code: 'type', expected: ['Date'] }]);
  await assertIssues(schema, new Date(Number.NaN), [{ path: [], code: 'type', expected: ['Date'] }]);
  await assertIssues({ golemModelDate: false }, 'anything', []);
});

const RULES_PATH = './rules.mjs';
const RULES_MODULE = `
const calls = (globalThis.ruleCalls ??= []);
export const isEven = value => { calls.push('isEven'); return value % 2 === 0; };
export const isSmall = value => { calls.push('isSmall'); return value < 10 ? true : 'must be below 10'; };
export const blank = () => { calls.push('blank'); return ''; };
export const always = () => { calls.push('always'); return true; };
export const count = () => { calls.push('count'); return 1; };
`;

function ruleCalls(): string[] {
  const calls: unknown = Reflect.get(globalThis, 'ruleCalls');
  return Array.isArray(calls) ? calls.map(String) : [];
}

async function compileRules(schema: unknown, ids: readonly string[]): Promise<Validator> {
  Reflect.set(globalThis, 'ruleCalls', []);
  const validations = Object.fromEntries(ids.map(id => [id, { importPath: RULES_PATH, exportName: id.replace(/^rules\./, '') }]));
  return (await compileValidators({ roots: { root: schema }, validations, modules: { 'rules.mjs': RULES_MODULE } })).root;
}

test('exprtValidation imports each bound function and calls it inline', async () => {
  const result = compile(
    { roots: new Map([['root', { exprtValidation: { schema: true, bindings: ['rules.isEven', 'rules.isSmall'] } }]]), validations: new Map([
      ['rules.isEven', { importPath: RULES_PATH, exportName: 'isEven' }],
      ['rules.isSmall', { importPath: RULES_PATH, exportName: 'isSmall' }],
    ]) },
    { unknownFormats: 'warn' },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.source, /^import \{ isEven as v0 \} from "\.\/rules\.mjs";$/m);
  assert.match(result.source, /^import \{ isSmall as v1 \} from "\.\/rules\.mjs";$/m);
  assert.match(result.source, /v0\(v\)/);
});

test('a validation function that returns false is one custom issue, and a string is its reason', async () => {
  const validate = await compileRules({ exprtValidation: { schema: { type: 'integer' }, bindings: ['rules.isEven'] } }, ['rules.isEven']);
  assert.deepEqual(validate(4, true), []);
  assert.deepEqual(validate(3, true), [{ path: [], code: 'custom' }]);
  const small = await compileRules({ exprtValidation: { schema: { type: 'integer' }, bindings: ['rules.isSmall'] } }, ['rules.isSmall']);
  assert.deepEqual(small(5, true), []);
  assert.deepEqual(small(50, true), [{ path: [], code: 'custom', reason: 'must be below 10' }]);
  const blank = await compileRules({ exprtValidation: { bindings: ['rules.blank'] } }, ['rules.blank']);
  assert.deepEqual(blank(1, true), [{ path: [], code: 'custom' }]);
});

test('a validation function reports at the path of the value its schema describes', async () => {
  const validate = await compileRules({ properties: { n: { exprtValidation: { schema: true, bindings: ['rules.isEven'] } } } }, ['rules.isEven']);
  assert.deepEqual(validate({ n: 3 }, true), [{ path: ['n'], code: 'custom' }]);
  assert.deepEqual(validate({ n: 2 }, true), []);
});

test('a validation function that returns neither a boolean nor a string throws a TypeError', async () => {
  const validate = await compileRules({ exprtValidation: { schema: true, bindings: ['rules.count'] } }, ['rules.count']);
  assert.throws(() => validate(1, true), new TypeError('Validation functions must return boolean or string.'));
  assert.throws(() => validate(1, false), new TypeError('Validation functions must return boolean or string.'));
});

test('validation functions run only when the structural schema passes', async () => {
  const validate = await compileRules({ exprtValidation: { schema: { type: 'integer' }, bindings: ['rules.isEven'] } }, ['rules.isEven']);
  assert.deepEqual(validate('text', true), [{ path: [], code: 'type', expected: ['integer'] }]);
  assert.deepEqual(ruleCalls(), []);
});

test('all errors reports each failing validation function in order; a binding listed twice runs once', async () => {
  const validate = await compileRules({ exprtValidation: { schema: true, bindings: ['rules.isEven', 'rules.isSmall', 'rules.isEven'] } }, ['rules.isEven', 'rules.isSmall']);
  assert.deepEqual(validate(51, true), [
    { path: [], code: 'custom' },
    { path: [], code: 'custom', reason: 'must be below 10' },
  ]);
  assert.deepEqual(ruleCalls(), ['isEven', 'isSmall']);
});

test('fast-fail stops before a later validation function runs', async () => {
  const validate = await compileRules({ exprtValidation: { schema: true, bindings: ['rules.isEven', 'rules.isSmall'] } }, ['rules.isEven', 'rules.isSmall']);
  assert.deepEqual(validate(51, false), [{ path: [], code: 'custom' }]);
  assert.deepEqual(ruleCalls(), ['isEven']);
});

test('a binding list without a wrapper schema is the same check', async () => {
  const validate = await compileRules({ exprtValidation: ['rules.isEven'] }, ['rules.isEven']);
  assert.deepEqual(validate(3, true), [{ path: [], code: 'custom' }]);
  assert.deepEqual(validate(2, true), []);
});

test('the structural schema of a validation wrapper marks the properties it evaluates', async () => {
  const validate = await compileRules({
    exprtValidation: { schema: { properties: { a: true } }, bindings: ['rules.always'] },
    unevaluatedProperties: false,
  }, ['rules.always']);
  assert.deepEqual(validate({ a: 1 }, true), []);
  assert.deepEqual(validate({ a: 1, b: 2 }, true), [{ path: ['b'], code: 'unknownKey', key: 'b' }]);
});

test('a binding that no validation names is an error naming it and its place in the schema', () => {
  const result = compile(
    { roots: new Map([['root', { exprtValidation: { schema: true, bindings: ['rules.isEven', 'rules.missing'] } }]]), validations: new Map([
      ['rules.isEven', { importPath: RULES_PATH, exportName: 'isEven' }],
    ]) },
    { unknownFormats: 'warn', documentName: 'orders.yaml' },
  );
  assert.equal(result.source, '');
  assert.deepEqual(result.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
    ['VALIDATE_UNKNOWN_VALIDATION', GolemDiagnosticSeverity.Error, '/exprtValidation/bindings/1'],
  ]);
  assert.match(result.diagnostics[0].message, /rules\.missing/);
  assert.match(result.diagnostics[0].message, /orders\.yaml/);
  const noTable = compile({ roots: new Map([['root', { exprtValidation: ['rules.isEven'] }]]) }, { unknownFormats: 'warn' });
  assert.deepEqual(noTable.diagnostics.map(entry => [entry.code, entry.path]), [['VALIDATE_UNKNOWN_VALIDATION', '/exprtValidation/0']]);
});
