import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import vm from 'node:vm';

import { build } from 'esbuild';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import { MODEL_CODEC_IDS_KEY } from '@exprtlabs/golem/internal/schema';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compile } from '@exprtlabs/golem/internal/validator-compiler';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';

import { compileSchema, compileValidationPlan, compileValidatorModule, compileValidators } from './support/compiled-validators.js';
import { createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { TSC } from './support/build-project.js';
import { command, workspace } from './support/process.js';

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

test('an object reports its own required and unknown keys before the issues of its properties', async () => {
  const validate = await compileSchema({
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' }, a: { type: 'string' } },
    additionalProperties: false,
  });
  assert.deepEqual(validate({ id: 1, a: 1, extra: true }, false), [{ path: ['extra'], code: 'unknownKey', key: 'extra' }]);
  assert.deepEqual(validate({ a: 1, extra: true }, true), [
    { path: ['id'], code: 'required', key: 'id' },
    { path: ['extra'], code: 'unknownKey', key: 'extra' },
    { path: ['a'], code: 'type', expected: ['string'] },
  ]);
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
    { path: ['other'], code: 'unknownKey', key: 'other' },
    { path: ['x-a'], code: 'type', expected: ['integer'] },
    { path: ['fullname'], code: 'type', expected: ['string'] },
    { path: ['x-name'], code: 'type', expected: ['integer'] },
    { path: ['x-name'], code: 'type', expected: ['string'] },
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

test('uniqueItems compares items by the JSON view: an undefined item equals null', async () => {
  await assertIssues({ uniqueItems: true }, [undefined, null], [{ path: [], code: 'unique', indexes: [0, 1] }]);
  await assertIssues({ uniqueItems: true }, [undefined, 0], []);
});

test('items, prefixItems and contains read an undefined item as null, as uniqueItems does', async () => {
  // protects: T-183 one JSON view of an array item in every array keyword
  await assertIssues({ items: { type: 'null' } }, [undefined, null], []);
  await assertIssues({ prefixItems: [{ type: 'null' }] }, [undefined], []);
  await assertIssues({ contains: { type: 'null' } }, ['a', undefined], []);
});

test('a hole in an array is a type issue at its index', async () => {
  // protects: T-183 conversion rejects array holes (runtime-api.md); an undefined item is not a hole
  const expected = ['null', 'boolean', 'number', 'string', 'array', 'object'];
  await assertIssues({ type: 'array' }, ['a', , 'b'], [{ path: [1], code: 'type', expected }]);
  await assertIssues({ items: { type: ['string', 'null'] } }, [, 'a'], [{ path: [0], code: 'type', expected }]);
  await assertIssues({ items: { type: 'string' } }, ['a', , 'b'], [{ path: [1], code: 'type', expected }]);
  await assertIssues({ prefixItems: [{ type: 'string' }] }, [, 'b'], [{ path: [0], code: 'type', expected }]);
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

/**
 * Bundles the named exports of an emitted validator module with esbuild and runs the bundle in a fresh context, a realm of its
 * own: a test that counts what the bundle calls patches that realm's globals with `setup` and never the test process's.
 */
async function loadBundle(t: TestContext, source: string, names: readonly string[], context: object = {}, setup = ''): Promise<{ readonly values: readonly Validator[]; readonly text: string }> {
  const directory = mkdtempSync(path.join(tmpdir(), 'golem-validators-bundle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'validators.js'), source);
  writeFileSync(path.join(directory, 'entry.js'), `import { ${names.join(', ')} } from './validators.js';\nglobalThis.used = [${names.join(', ')}];\n`);
  const result = await build({ entryPoints: [path.join(directory, 'entry.js')], bundle: true, format: 'cjs', write: false, treeShaking: true, external: ['golem-validation-runtime'] });
  const runtime = await import('@exprtlabs/golem/validation-runtime');
  const fresh = vm.createContext({ ...context, require: () => runtime });
  vm.runInContext(setup, fresh);
  vm.runInContext(result.outputFiles[0].text, fresh);
  return { values: fresh.used, text: result.outputFiles[0].text };
}

test('an anyOf of branches that differ by JSON type checks a valid value with the one branch of its type', async t => {
  // protects: T-255 one type switch for a disjoint union (F-250); `Number.isInteger` runs only in the integer branch, which comes first.
  const { source, exports, fastExports } = compile(
    { roots: new Map([['root', { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }, { type: 'array', items: { type: 'string' } }, { type: 'object' }] }]]) },
    { unknownFormats: 'warn', runtimeModule: 'golem-validation-runtime', fastPath: true },
  );
  const counts = { isInteger: 0 };
  const { values } = await loadBundle(t, source, [fastExports.get('root')!, exports.get('root')!], { counts }, 'const real = Number.isInteger; Number.isInteger = value => (counts.isInteger++, real(value));');
  const [fast, full] = values;
  const checks = [fast as unknown as (value: unknown) => boolean, (value: unknown) => full(value, false).length === 0];
  for (const check of checks) {
    const callsFor = (value: unknown): readonly [boolean, number] => {
      counts.isInteger = 0;
      return [check(value), counts.isInteger];
    };
    assert.deepEqual(callsFor('a'), [true, 0]);
    assert.deepEqual(callsFor(null), [true, 0]);
    assert.deepEqual(callsFor(['a']), [true, 0]);
    assert.deepEqual(callsFor({ a: 1 }), [true, 0]);
    const [verdict, isIntegerCalls] = callsFor(3);
    assert.equal(verdict, true);
    assert.ok(isIntegerCalls <= 1, `the integer branch called Number.isInteger ${isIntegerCalls} times`);
  }
});

test('a union that dispatches by JSON type reports the union issue for a value no branch accepts, in both modes', async () => {
  // protects: T-255 issues of a disjoint-type union do not change.
  const disjoint = { anyOf: [{ type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'object', additionalProperties: { type: 'string' } }] };
  const none = [{ path: [], code: 'union', matched: 0 }];
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, [1], { a: 1 }, [undefined]]) await assertIssues(disjoint, value, none);
  for (const value of [null, true, 1.5, 'a', ['a'], [], { a: 'b' }, {}]) await assertIssues(disjoint, value, []);
  // Branches that share a JSON type are tried in order inside that type; a branch with no type is tried for every value.
  const shared = { anyOf: [{ type: 'string', minLength: 3 }, { type: 'integer' }, { type: 'string', pattern: '^b' }, { type: ['null', 'integer'], minimum: 5 }] };
  for (const value of ['abc', 'b', 7, null, 3]) await assertIssues(shared, value, []);
  for (const value of ['a', 1.5, [], {}, true]) await assertIssues(shared, value, none);
  const untyped = { anyOf: [{ type: 'string', minLength: 3 }, { type: 'integer' }, { not: { type: 'boolean' } }] };
  for (const value of ['a', 1.5, null, 3]) await assertIssues(untyped, value, []);
  await assertIssues(untyped, true, none);
});

test('an anyOf or oneOf of constants reports one literal issue with every allowed value', async () => {
  await assertIssues({ anyOf: [{ const: 'a' }, { const: 'b' }] }, 'c', [{ path: [], code: 'literal', expected: ['a', 'b'] }]);
  await assertIssues({ anyOf: [{ const: 'a' }, { const: 'b' }] }, 'b', []);
  await assertIssues({ oneOf: [{ const: 1 }, { const: 2 }, { const: 3 }] }, 4, [{ path: [], code: 'literal', expected: [1, 2, 3] }]);
  await assertIssues({ oneOf: [{ const: 1 }, { const: 2 }, { const: 3 }] }, 3, []);
  await assertIssues({ properties: { kind: { anyOf: [{ const: 'a' }, { const: 'b' }] } } }, { kind: 'z' }, [{ path: ['kind'], code: 'literal', expected: ['a', 'b'] }]);
});

test('enum branches, null and annotations fold into one literal issue in branch order', async () => {
  const schema = { anyOf: [{ enum: ['a', 'b'], title: 'letters' }, { const: null, description: 'nothing', 'x-note': 1 }, { enum: [3] }] };
  await assertIssues(schema, 'c', [{ path: [], code: 'literal', expected: ['a', 'b', null, 3] }]);
  await assertIssues(schema, null, []);
  await assertIssues(schema, 3, []);
  await assertIssues({ oneOf: [{ enum: ['a', 'b'] }, { const: null }] }, 1, [{ path: [], code: 'literal', expected: ['a', 'b', null] }]);
});

test('a oneOf whose constants repeat keeps the union issue and its matched count', async () => {
  const schema = { oneOf: [{ const: 'a' }, { const: 'b' }, { enum: ['a'] }] };
  await assertIssues(schema, 'a', [{ path: [], code: 'union', matched: 2 }]);
  await assertIssues(schema, 'z', [{ path: [], code: 'union', matched: 0 }]);
  await assertIssues(schema, 'b', []);
  const reordered = { oneOf: [{ const: { x: 1, y: 2 } }, { const: { y: 2, x: 1 } }] };
  await assertIssues(reordered, { x: 1, y: 2 }, [{ path: [], code: 'union', matched: 2 }]);
});

test('a constant branch with a type that every value satisfies folds into the literal issue', async () => {
  await assertIssues({ anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'integer', const: 3 }] }, 'c', [{ path: [], code: 'literal', expected: ['a', 'b', 3] }]);
  await assertIssues({ anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'integer', const: 3 }] }, 3, []);
  await assertIssues({ oneOf: [{ type: ['string', 'null'], enum: ['a', null] }, { const: 1 }] }, 2, [{ path: [], code: 'literal', expected: ['a', null, 1] }]);
  await assertIssues({ oneOf: [{ type: ['string', 'null'], enum: ['a', null] }, { const: 1 }] }, null, []);
});

test('a constant branch whose type a value does not satisfy keeps the union issue', async () => {
  const schema = { anyOf: [{ type: 'string', enum: ['a', 1] }, { const: 'b' }] };
  await assertIssues(schema, 'c', [{ path: [], code: 'union', matched: 0 }]);
  await assertIssues(schema, 'a', []);
  await assertIssues(schema, 1, [{ path: [], code: 'union', matched: 0 }]);
  await assertIssues({ anyOf: [{ type: 'integer', const: 1.5 }, { const: 'b' }] }, 1.5, [{ path: [], code: 'union', matched: 0 }]);
});

test('a union of a constant and another shape keeps the union issue', async () => {
  const schema = { anyOf: [{ const: 'a' }, { type: 'object' }] };
  await assertIssues(schema, 'b', [{ path: [], code: 'union', matched: 0 }]);
  await assertIssues(schema, 'a', []);
  await assertIssues(schema, {}, []);
  await assertIssues({ anyOf: [{ const: 'a', minLength: 1 }, { const: 'b' }] }, 'c', [{ path: [], code: 'union', matched: 0 }]);
});

test('an anyOf or oneOf with one branch reports the issues of that branch', async () => {
  const defs = { Owner: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } };
  for (const keyword of ['anyOf', 'oneOf']) {
    const schema = { $defs: defs, properties: { owner: { [keyword]: [{ $ref: '#/$defs/Owner' }] } } };
    await assertIssues(schema, { owner: 1 }, [{ path: ['owner'], code: 'type', expected: ['object'] }]);
    await assertIssues(schema, { owner: {} }, [{ path: ['owner', 'id'], code: 'required', key: 'id' }]);
    await assertIssues(schema, { owner: { id: 'x' } }, [{ path: ['owner', 'id'], code: 'type', expected: ['integer'] }]);
    await assertIssues(schema, { owner: { id: 1 } }, []);
  }
});

test('a one-branch anyOf evaluates keys as its branch does', async () => {
  const schema = { anyOf: [{ properties: { a: { type: 'string' } } }], unevaluatedProperties: false };
  await assertIssues(schema, { a: 'x' }, []);
  await assertIssues(schema, { a: 'x', b: 1 }, [{ path: ['b'], code: 'unknownKey', key: 'b' }]);
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

const MODEL_CODEC_IDS = Symbol.for(MODEL_CODEC_IDS_KEY);

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

test('golemModelInstance matches a registered codec id exactly, never by a prefix of it', async () => {
  // protects: bug T-294 a hashed id is never guessed from a name
  const Order = modelClass('Order_1a2b3c4d');
  await assertIssues({ golemModelInstance: { of: 'Order_1a2b3c4d', among: ['Order_1a2b3c4d'], required: true } }, new Order(), []);
  await assertIssues({ golemModelInstance: { of: 'Order_ffffffff', among: ['Order_ffffffff'], required: true } }, new Order(), [
    { path: [], code: 'instance', model: 'Order_ffffffff' },
  ]);
  const Named = modelClass('Order_1a2b3c4d_ffffffff');
  await assertIssues({ golemModelInstance: { of: 'Order_1a2b3c4d', among: ['Order_1a2b3c4d'], required: true } }, new Named(), [
    { path: [], code: 'instance', model: 'Order_1a2b3c4d' },
  ]);
});

/** A graph that holds a plain model of one tag; `name` is the model name, and the graph sealed. */
function graphOf(...models: readonly (readonly [string, string])[]): ReturnType<typeof createSchemaGraph> {
  const graph = createSchemaGraph();
  for (const [name, tag] of models) {
    const descriptor: ModelTypeDescriptor = { kind: 'object', properties: { kind: { kind: 'literal', value: tag } }, required: ['kind'], additionalProperties: false };
    graph.intern(descriptor, name);
  }
  graph.seal();
  return graph;
}

test('a plan resolves a model name to its codec id, and the compiled check tells a model named like a hashed id from the model it is named after', async () => {
  // protects: bug T-294 a model named like a codec id keeps its full name in codec identity
  const graph = graphOf(['Order', 'plain'], ['Order_0badc0de', 'suffixed']);
  const [order, suffixed] = ['Order', 'Order_0badc0de'].map((name) => [...graph.nodes.values()].find((node) => node.name === name)!.codecId);
  const keyword = { of: 'Order_0badc0de', among: ['Order', 'Order_0badc0de'], required: true };
  const plan = buildCodecValidationPlan(graph, [], { Holder: { golemModelInstance: keyword } });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.schemas.Holder)), { golemModelInstance: { ...keyword, of: suffixed, among: [order, suffixed] }, $id: 'Holder' });
  const { Holder } = await compileValidationPlan(plan);
  assert.deepEqual(Holder(new (modelClass(suffixed))(), true), []);
  assert.deepEqual(Holder(new (modelClass(order))(), true), [{ path: [], code: 'instance', model: suffixed }]);
});

test('a plan that cannot tell which model a name means says so, and a codec id is never ambiguous', () => {
  // protects: bug T-294 a name shared by two graphs is an error naming the keyword, not a silent pick
  const graphs = [graphOf(['Order', 'one']), graphOf(['Order', 'two'])];
  const [one, two] = graphs.map((graph) => [...graph.nodes.values()][0]!.codecId);
  assert.throws(
    () => buildCodecValidationPlan(graphs, [], { Holder: { golemModelInstance: { of: 'Order', among: ['Order'], required: true } } }),
    /the golemModelInstance model name "Order" is ambiguous between codec identities/,
  );
  const plan = buildCodecValidationPlan(graphs, [], { Holder: { golemModelInstance: { of: one, among: [one, two], required: true } } });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.schemas.Holder)), { golemModelInstance: { of: one, among: [one, two], required: true }, $id: 'Holder' });
  // A model named like the codec id of another is one name for two models; the id itself still means one.
  const lookalike = graphOf([one, 'three']);
  const withLookalike = buildCodecValidationPlan([graphs[0]!, lookalike], [], { Holder: { golemModelInstance: { of: one, among: [one], required: true } } });
  assert.equal((withLookalike.schemas.Holder as { golemModelInstance: { of: string } }).golemModelInstance.of, one);
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

test('a golem keyword with a malformed value is an error naming the keyword, not a dropped check', () => {
  const cases: readonly [string, unknown][] = [
    ['golemModelDate', 'yes'],
    ['golemModelInstance', { among: 'Cat', required: true }],
    ['golemModelInstance', { of: 1, among: ['Cat'], required: true }],
    ['golemModelInstance', { among: ['Cat'] }],
    ['golemModelInstance', 'Cat'],
    ['exprtValidation', 'rules.isEven'],
    ['exprtValidation', { schema: true }],
    ['exprtValidation', { schema: true, bindings: 'rules.isEven' }],
    ['exprtValidation', { schema: true, bindings: ['rules.isEven', 5] }],
    ['exprtValidation', { schema: 'string', bindings: ['rules.isEven'] }],
    ['exprtValidation', { schema: null, bindings: ['rules.isEven'] }],
    ['exprtValidation', { schema: [{ type: 'string' }], bindings: ['rules.isEven'] }],
    ['exprtValidation', ['rules.isEven', null]],
  ];
  for (const [keyword, value] of cases) {
    const result = compile(
      { roots: new Map([['root', { properties: { a: { [keyword]: value } } }]]), validations: new Map([['rules.isEven', { importPath: RULES_PATH, exportName: 'isEven' }]]) },
      { unknownFormats: 'warn', documentName: 'orders.yaml' },
    );
    assert.equal(result.source, '', `${keyword} ${JSON.stringify(value)}`);
    assert.deepEqual(result.diagnostics.map(entry => [entry.code, entry.severity, entry.path]), [
      ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `/properties/a/${keyword}`],
    ], `${keyword} ${JSON.stringify(value)}`);
    assert.match(result.diagnostics[0].message, new RegExp(`value of ${keyword} is not valid`));
    assert.match(result.diagnostics[0].message, /orders\.yaml/);
  }
});

test('a discriminator reads the tag through a validation wrapper and runs only the selected branch', async () => {
  const wrap = (schema: unknown): unknown => ({ exprtValidation: { schema, bindings: ['rules.always'] } });
  const schema = {
    oneOf: [
      wrap({ properties: { kind: { const: 'a' }, x: { type: 'integer' } }, required: ['kind'] }),
      wrap({ allOf: [{ properties: { kind: { enum: ['b', 'c'] } } }, { properties: { y: { type: 'string' } } }], required: ['kind'] }),
    ],
    discriminator: { propertyName: 'kind' },
  };
  const validate = await compileRules(schema, ['rules.always']);
  assert.deepEqual(validate({ kind: 'a', x: 'no' }, true), [{ path: ['x'], code: 'type', expected: ['integer'] }]);
  assert.deepEqual(validate({ kind: 'c', y: 1 }, false), [{ path: ['y'], code: 'type', expected: ['string'] }]);
  assert.deepEqual(validate({ kind: 'z' }, true), [{ path: ['kind'], code: 'literal', expected: ['a', 'b', 'c'] }]);
  assert.deepEqual(validate({ kind: 'a', x: 1 }, true), []);
});

test('a key whose value is undefined counts as absent for required, properties, unknown keys, property counts and property names', async () => {
  const value = { a: undefined };
  await assertIssues({ required: ['a'] }, value, [{ path: ['a'], code: 'required', key: 'a' }]);
  await assertIssues({ properties: { a: { type: 'string' } } }, value, []);
  await assertIssues({ additionalProperties: false }, value, []);
  await assertIssues({ additionalProperties: { type: 'string' } }, value, []);
  await assertIssues({ unevaluatedProperties: false }, value, []);
  await assertIssues({ minProperties: 1 }, value, [{ path: [], code: 'tooSmall', measure: 'properties', limit: 1, inclusive: true }]);
  await assertIssues({ maxProperties: 0 }, value, []);
  await assertIssues({ propertyNames: { maxLength: 0 } }, value, []);
  await assertIssues({ required: ['a'] }, { a: null }, []);
});

test('a non-enumerable own key counts as absent for required, properties and dependentRequired', async () => {
  const hidden = (): object => Object.defineProperty({}, 'a', { value: 5, enumerable: false });
  await assertIssues({ required: ['a'] }, hidden(), [{ path: ['a'], code: 'required', key: 'a' }]);
  await assertIssues({ properties: { a: { type: 'string' } } }, hidden(), []);
  await assertIssues({ dependentRequired: { a: ['b'] } }, hidden(), []);
});

test('uniqueItems rejects items that differ only by undefined-valued keys', async () => {
  await assertIssues({ uniqueItems: true }, [{ a: 1, b: undefined }, { a: 1 }], [{ path: [], code: 'unique', indexes: [0, 1] }]);
  await assertIssues({ uniqueItems: true }, [[undefined], [null]], [{ path: [], code: 'unique', indexes: [0, 1] }]);
});

test('const and enum accept a value with an extra undefined-valued key', async () => {
  await assertIssues({ const: { a: 1 } }, { a: 1, b: undefined }, []);
  await assertIssues({ enum: [{ a: 1 }, 2] }, { a: 1, b: undefined }, []);
});

test('compile with typed emits the same validator with its issue type', async (t) => {
  // protects: value the typed validator reports the same issues as the untyped one and returns SchemaIssue[]
  const { byRoot } = await compileValidatorModule({ roots: { root: { type: 'string' } }, typed: true });
  assert.deepEqual(byRoot.root('a', true), []);
  assert.deepEqual(byRoot.root(5, true), [{ path: [], code: 'type', expected: ['string'] }]);
  // A type is erased before the module runs, so the compiler proves the annotation: the validator returns `readonly SchemaIssue[]`, not `any`.
  const project = createFixtureProject(t, 'golem-typed-validator-');
  linkProjectPackages(project, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  const { source } = compile({ roots: new Map([['root', { type: 'string' }]]) }, { unknownFormats: 'warn', typed: true });
  writeFileSync(path.join(project, 'validators.ts'), source);
  writeFileSync(path.join(project, 'probe.ts'), [
    "import type { SchemaIssue } from '@exprtlabs/golem/validation-runtime';",
    "import { validate_root } from './validators.js';",
    "export const issues: readonly SchemaIssue[] = validate_root('a', true);",
    '// @ts-expect-error an item is a SchemaIssue; an unannotated validator would give any',
    "export const notNumber: number = validate_root('a', true)[0];",
    '',
  ].join('\n'));
  writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true }, include: ['*.ts'] }));
  await command(project, process.execPath, [TSC, '-p', 'tsconfig.json']);
});

const MODEL_ROOTS = new Map<string, unknown>([
  ['PaymentDraft_8be34727', { type: 'object', properties: { note: { type: 'string', pattern: '^draft-[0-9]{4}$' } }, additionalProperties: false }],
  ['PaymentDraft_8be34727#wire', { type: 'object', properties: { tags: { enum: ['a', 'b'] } } }],
  ['getPayment:input', { type: 'object', required: ['id'] }],
  ['getPayment:response:200:application/json', { type: 'array', items: { type: 'string' }, uniqueItems: true }],
]);

test('every root is exported as a named function under the name the compile reports, and runs its own root', async () => {
  // protects: value each root has one exported validator, under the name the compile reports, that runs its own root
  const { exports, exportNames, byRoot } = await compileValidatorModule({ roots: Object.fromEntries(MODEL_ROOTS) });
  assert.deepEqual([...exports], [
    ['PaymentDraft_8be34727', 'validate_PaymentDraft_8be34727'],
    ['PaymentDraft_8be34727#wire', 'validate_PaymentDraft_8be34727_wire'],
    ['getPayment:input', 'validate_getPayment_input'],
    ['getPayment:response:200:application/json', 'validate_getPayment_response_200_application_json'],
  ].sort(([first], [second]) => (first < second ? -1 : 1)));
  assert.deepEqual(exportNames, [...exports.values()].sort());
  assert.deepEqual(byRoot['PaymentDraft_8be34727']({ note: 'draft-0001' }, true), []);
  assert.deepEqual(byRoot['PaymentDraft_8be34727']({ note: 'x' }, true), [{ path: ['note'], code: 'pattern', pattern: '^draft-[0-9]{4}$' }]);
  assert.deepEqual(byRoot['PaymentDraft_8be34727#wire']({ tags: 'c' }, true), [{ path: ['tags'], code: 'literal', expected: ['a', 'b'] }]);
  assert.deepEqual(byRoot['getPayment:input']({}, true), [{ path: ['id'], code: 'required', key: 'id' }]);
  assert.deepEqual(byRoot['getPayment:response:200:application/json'](['a', 'a'], true), [{ path: [], code: 'unique', indexes: [0, 1] }]);
});

test('adding a root renames no other export', () => {
  const before = compile({ roots: MODEL_ROOTS }, { unknownFormats: 'warn' }).exports;
  const grown = new Map<string, unknown>([['Aardvark_00000000', { type: 'string' }], ...MODEL_ROOTS, ['zebra:input', { type: 'string' }]]);
  const after = compile({ roots: grown }, { unknownFormats: 'warn' }).exports;
  for (const [root, exported] of before) assert.equal(after.get(root), exported, root);
  assert.equal(after.size, before.size + 2);
});

test('roots whose names become one identifier get a number, the others keep their name', async () => {
  const roots = { 'a-b': { type: 'integer' }, 'a_b': { type: 'string' }, 'c': { type: 'boolean' } };
  const compiled = await import('./support/compiled-validators.js').then(module => module.compileValidatorModule({ roots }));
  assert.deepEqual([...compiled.exports], [['a-b', 'validate_a_b'], ['a_b', 'validate_a_b_2'], ['c', 'validate_c']]);
  assert.deepEqual(compiled.byRoot['a-b']('x', true), [{ path: [], code: 'type', expected: ['integer'] }]);
  assert.deepEqual(compiled.byRoot.a_b(1, true), [{ path: [], code: 'type', expected: ['string'] }]);
});

test('a bundle of one validator drops an unused validator with its constants', async t => {
  // protects: value a bundle of one validator holds no pattern, set or literal constant of a validator it does not import
  const roots = new Map<string, unknown>([
    ['kept', { type: 'string', pattern: '^kept-pattern-[0-9]+$' }],
    ['unused', { type: 'object', properties: { code: { type: 'string', pattern: '^unused-pattern-[0-9]+$' }, kind: { enum: ['unused-literal-a', 'unused-literal-b'] } }, additionalProperties: false }],
  ]);
  const { source, exports } = compile({ roots }, { unknownFormats: 'warn', runtimeModule: 'golem-validation-runtime' });
  const kept = exports.get('kept') ?? '';
  const unused = exports.get('unused') ?? '';
  const one = await loadBundle(t, source, [kept]);
  const both = await loadBundle(t, source, [kept, unused]);
  const unusedConstants = /unused-pattern|unused-literal/;
  assert.equal(unusedConstants.test(both.text), true, 'a bundle that imports the unused validator holds its constants');
  assert.equal(unusedConstants.test(one.text), false, 'a bundle of the kept validator holds none of them');
  assert.deepEqual(JSON.parse(JSON.stringify(one.values[0]('kept-pattern-7', true))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(one.values[0]('other', true))), [{ path: [], code: 'pattern', pattern: '^kept-pattern-[0-9]+$' }]);
});

test('a diagnostic is placed where the locator says and reported once per place', () => {
  const result = compile(
    { roots: new Map([['a', { $ref: 'shared' }], ['b', { $ref: 'shared' }]]), resources: new Map([['shared', { format: 'money' }]]) },
    {
      unknownFormats: 'warn',
      documentName: 'orders.yaml',
      locate: (resource, pointer) => resource === 'shared' ? { where: `orders.yaml#/Money${pointer}`, file: 'orders.yaml', path: `#/Money${pointer}` } : undefined,
    },
  );
  assert.deepEqual(result.diagnostics, [{
    code: 'VALIDATE_UNKNOWN_FORMAT',
    severity: GolemDiagnosticSeverity.Warning,
    message: 'orders.yaml#/Money/format: the format "money" is not implemented and is not checked',
    file: 'orders.yaml',
    path: '#/Money/format',
  }]);
});

test('the expected values an issue shares with the validator cannot be changed by its reader', async () => {
  const [enumIssue] = (await compileSchema({ enum: ['a', 'b'] }))('c', true);
  const [tagIssue] = (await compileSchema({
    oneOf: [{ properties: { kind: { const: 'a' } }, required: ['kind'] }, { properties: { kind: { const: 'b' } }, required: ['kind'] }],
    discriminator: { propertyName: 'kind' },
  }))({ kind: 'z' }, true);
  for (const issue of [enumIssue, tagIssue]) {
    assert.ok(issue.code === 'literal' && Object.isFrozen(issue.expected), JSON.stringify(issue));
  }
});

test('number and integer reject NaN and the infinities, and other number keywords never crash on them', async () => {
  const notFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const value of notFinite) {
    await assertIssues({ type: 'number' }, value, [{ path: [], code: 'type', expected: ['number'] }]);
    await assertIssues({ type: 'integer' }, value, [{ path: [], code: 'type', expected: ['integer'] }]);
    await assertIssues({ type: ['number', 'string'] }, value, [{ path: [], code: 'type', expected: ['number', 'string'] }]);
    const validate = await compileSchema({ type: 'number', minimum: 0, maximum: 10, multipleOf: 2, const: 4 });
    assert.doesNotThrow(() => validate(value, true));
    assert.ok(validate(value, true).some(issue => issue.code === 'type'));
    const enumerated = await compileSchema({ enum: [1, 2] });
    assert.doesNotThrow(() => enumerated(value, true));
  }
  for (const value of [0, -1.5, 3, 1e300, Number.MIN_VALUE]) await assertIssues({ type: 'number' }, value, []);
  for (const value of [0, -3, 2 ** 40]) await assertIssues({ type: 'integer' }, value, []);
});

/** The compiled module text of `roots` (named by `resources` for `$ref` targets). */
function emitted(roots: Record<string, unknown>, resources: Record<string, unknown> = {}): string {
  const { source } = compile({ roots: new Map(Object.entries(roots)), resources: new Map(Object.entries(resources)) }, { unknownFormats: 'warn' });
  return source;
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

const FUNCTION_DECLARATIONS = /^function f\d+(?:_[\w$]*)?\(/gm;

test('a $ref chain emits the function of its target only, and the root still validates', async () => {
  const roots = { root: { $ref: 'one' } };
  const resources = { one: { $ref: 'two' }, two: { $ref: 'three' }, three: { type: 'string', minLength: 2 } };
  assert.equal(count(emitted(roots, resources), FUNCTION_DECLARATIONS), 1);
  const { root } = await compileValidators({ roots, resources });
  assert.deepEqual(root('a', true), [{ path: [], code: 'tooSmall', measure: 'length', limit: 2, inclusive: true }]);
  assert.deepEqual(root(5, true), [{ path: [], code: 'type', expected: ['string'] }]);
  assert.deepEqual(root('ab', true), []);
});

test('identical sets, patterns and literals are declared once for the module', async () => {
  const model = {
    type: 'object',
    properties: { k: { type: 'string', pattern: '^p' }, m: { const: 'x' } },
    additionalProperties: false,
  };
  const roots = { first: model, second: { ...model, minProperties: 1 } };
  const source = emitted(roots);
  assert.equal(count(source, /new Set\(/g), 1);
  assert.equal(count(source, /new RegExp\(/g), 1);
  assert.equal(count(source, /JSON\.parse\(/g), 1);
  const { first, second } = await compileValidators({ roots });
  assert.deepEqual(first({ k: 'pa', m: 'x', z: 1 }, true), [{ path: ['z'], code: 'unknownKey', key: 'z' }]);
  assert.deepEqual(second({}, true), [{ path: [], code: 'tooSmall', measure: 'properties', limit: 1, inclusive: true }]);
  assert.deepEqual(second({ k: 'q', m: 'y' }, true), [
    { path: ['k'], code: 'pattern', pattern: '^p' },
    { path: ['m'], code: 'literal', expected: ['x'] },
  ]);
});

test('schemas that compile to the same body share one function, recursive ones included', async () => {
  const wire = (): unknown => ({ type: 'object', properties: { next: { $ref: '#' }, id: { type: 'integer' } } });
  const roots = { model: wire(), wire: wire(), other: { type: 'string' } };
  assert.equal(count(emitted(roots), FUNCTION_DECLARATIONS), 2);
  const { model, wire: wireValidator } = await compileValidators({ roots });
  const value = { id: 1, next: { id: 'x' } };
  const expected = [{ path: ['next', 'id'], code: 'type', expected: ['integer'] }];
  assert.deepEqual(model(value, true), expected);
  assert.deepEqual(wireValidator(value, true), expected);
});

test('functions that reference different targets stay separate', async () => {
  const roots = { textHolder: { properties: { v: { $ref: 'text' } } }, countHolder: { properties: { v: { $ref: 'count' } } } };
  const resources = { text: { type: 'string' }, count: { type: 'integer' } };
  assert.equal(count(emitted(roots, resources), FUNCTION_DECLARATIONS), 4);
  const { textHolder, countHolder } = await compileValidators({ roots, resources });
  assert.deepEqual(textHolder({ v: 1 }, true), [{ path: ['v'], code: 'type', expected: ['string'] }]);
  assert.deepEqual(countHolder({ v: 'a' }, true), [{ path: ['v'], code: 'type', expected: ['integer'] }]);
});

test('a function carries the name of its root or $ref target, and a branch function stays anonymous', async () => {
  const roots = {
    'Pet.v1': {
      type: 'object',
      properties: { owner: { $ref: '#/$defs/Owner' }, tag: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
      $defs: { Owner: { type: 'object', properties: { id: { type: 'integer' } } } },
    },
    ['L'.repeat(60)]: { type: 'boolean' },
  };
  const source = emitted(roots);
  assert.equal(count(source, /^function f\d+_Pet_v1\(/gm), 1);
  assert.equal(count(source, /^function f\d+_Owner\(/gm), 1);
  assert.equal(count(source, /^function f\d+_L{40}\(/gm), 1);
  assert.equal(count(source, /^function f\d+\(/gm), 2);
  const validators = await compileValidators({ roots });
  assert.deepEqual(validators['Pet.v1']({ owner: { id: 'x' }, tag: 1 }, true), [
    { path: ['owner', 'id'], code: 'type', expected: ['integer'] },
    { path: ['tag'], code: 'union', matched: 0 },
  ]);
  assert.deepEqual(validators['Pet.v1']({ owner: { id: 1 }, tag: {} }, true), []);
});

test('merged functions keep the name of the first of them', async () => {
  const wire = (): unknown => ({ type: 'object', properties: { next: { $ref: '#' }, id: { type: 'integer' } } });
  const source = emitted({ Model: wire(), Wire: wire() });
  assert.equal(count(source, FUNCTION_DECLARATIONS), 1);
  assert.equal(count(source, /^function f\d+_Model\(/gm), 1);
});

test('a forwarding function stays when its target takes an evaluation record that the forwarder is not handed', async () => {
  // `target` is reached in place by the root, which keeps a record, so it takes one; `viaForwarder` is reached only through a property, so it takes none.
  const roots = {
    root: {
      type: 'object',
      properties: { child: { $ref: 'viaForwarder' } },
      allOf: [{ $ref: 'target' }],
      unevaluatedProperties: false,
    },
  };
  const resources = { target: { type: 'object', properties: { a: { type: 'string' } } }, viaForwarder: { $ref: 'target' } };
  assert.equal(count(emitted(roots, resources), FUNCTION_DECLARATIONS), 3);
  const { root } = await compileValidators({ roots, resources });
  assert.deepEqual(root({ a: 'x', child: { a: 'y' } }, true), []);
  assert.deepEqual(root({ a: 1, child: { a: 2 } }, true), [
    { path: ['child', 'a'], code: 'type', expected: ['string'] },
    { path: ['a'], code: 'type', expected: ['string'] },
  ]);
  assert.deepEqual(root({ a: 'x', child: { a: 'y' }, z: 1 }, true), [{ path: ['z'], code: 'unknownKey', key: 'z' }]);
});

test('fastPath as a set of root names gives a fast check to the roots in it that have one, and to no other', () => {
  const roots = new Map<string, unknown>([
    ['Included', { type: 'string' }],
    ['Excluded', { type: 'string' }],
    ['AlsoIncluded', { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }],
  ]);
  const { fastExports, exports } = compile({ roots }, { unknownFormats: 'warn', fastPath: new Set(['Included', 'AlsoIncluded', 'NotARoot']) });
  assert.deepEqual([...fastExports.keys()].sort(), ['AlsoIncluded', 'Included']);
  assert.deepEqual([...exports.keys()].sort(), ['AlsoIncluded', 'Excluded', 'Included'], 'every root keeps its validator');
});

// An object that names no property needs no pass of its own in the fast check, but the fast check still reads every own
// value (spec 7.3). `late` is the last key; its getter shows whether the check read it, also after an earlier key failed.
const NO_NAMED_PROPERTIES = [
  { name: 'additionalProperties schema', schema: { additionalProperties: { type: 'integer' } }, late: 'zz', lateValue: 1, valid: { a: 1 }, invalid: { a: 'x' }, issues: [{ path: ['a'], code: 'type', expected: ['integer'] }] },
  { name: 'additionalProperties schema beside patternProperties', schema: { patternProperties: { '^x': { type: 'string' } }, additionalProperties: { type: 'integer' } }, late: 'zz', lateValue: 1, valid: { xa: 'p', b: 1 }, invalid: { xa: 1, b: 'q' }, issues: [{ path: ['b'], code: 'type', expected: ['integer'] }, { path: ['xa'], code: 'type', expected: ['string'] }] },
  { name: 'additionalProperties schema beside a pattern that accepts everything', schema: { patternProperties: { '^x': true }, additionalProperties: { type: 'integer' } }, late: 'x9', lateValue: 1, valid: { a: 1 }, invalid: { a: 'x' }, issues: [{ path: ['a'], code: 'type', expected: ['integer'] }] },
  { name: 'additionalProperties schema beside propertyNames', schema: { propertyNames: { maxLength: 2 }, additionalProperties: { type: 'integer' } }, late: 'zz', lateValue: 1, valid: { a: 1 }, invalid: { a: 'x' }, issues: [{ path: ['a'], code: 'type', expected: ['integer'] }] },
  { name: 'patternProperties', schema: { patternProperties: { '^x': { type: 'integer' } } }, late: 'x9', lateValue: 1, valid: { xa: 1 }, invalid: { xa: 'x' }, issues: [{ path: ['xa'], code: 'type', expected: ['integer'] }] },
  { name: 'propertyNames', schema: { propertyNames: { maxLength: 2 } }, late: 'zz', lateValue: 1, valid: { ab: 1 }, invalid: { abc: 1 }, issues: [{ path: [], code: 'invalidKey', key: 'abc' }] },
  // An inner failure reads the inner values, then the outer failure reads the values of the outer object.
  { name: 'additionalProperties schema inside additionalProperties schema', schema: { additionalProperties: { additionalProperties: { type: 'integer' } } }, late: 'zz', lateValue: { c: 1 }, valid: { a: { b: 1 } }, invalid: { a: { b: 'x' } }, issues: [{ path: ['a', 'b'], code: 'type', expected: ['integer'] }] },
  // The pass stays for these: a count, an unknown-key flag or a captured key does real work.
  { name: 'additionalProperties false', schema: { additionalProperties: false }, late: 'zz', lateValue: undefined, valid: {}, invalid: { a: 1 }, issues: [{ path: ['a'], code: 'unknownKey', key: 'a' }] },
  { name: 'maxProperties beside additionalProperties schema', schema: { maxProperties: 2, additionalProperties: { type: 'integer' } }, late: 'zz', lateValue: 1, valid: { a: 1 }, invalid: { a: 'x', b: 1 }, issues: [{ path: [], code: 'tooBig', measure: 'properties', limit: 2, inclusive: true }, { path: ['a'], code: 'type', expected: ['integer'] }] },
  { name: 'required key beside additionalProperties schema', schema: { required: ['r'], additionalProperties: { type: 'integer' } }, late: 'zz', lateValue: 1, valid: { r: 1 }, invalid: { a: 'x' }, issues: [{ path: ['r'], code: 'required', key: 'r' }, { path: ['a'], code: 'type', expected: ['integer'] }] },
];

for (const row of NO_NAMED_PROPERTIES) {
  for (const [state, base, issues] of [['valid', row.valid, []], ['invalid', row.invalid, row.issues]] as const) {
    test(`${row.name}, ${state} value: the fast check gives the verdict, the issues and the reads of the full validator`, async () => {
      // protects: T-255 the fast check of an object with no named property keeps the full validator's verdict and reads
      const { byRoot: { root: validate }, fastByRoot: { root: isValid } } = await compileValidatorModule({ roots: { root: row.schema }, fastPath: true });
      const reads: string[] = [];
      const value = Object.defineProperty({ ...base }, row.late, { enumerable: true, get: () => { reads.push(row.late); return row.lateValue; } });
      assert.deepEqual(validate(value, true), issues);
      assert.deepEqual(validate(value, false), issues.slice(0, 1));
      reads.length = 0;
      assert.equal(isValid(value), issues.length === 0);
      assert.ok(reads.includes(row.late), 'the fast check read the last key');
    });
  }
}
