import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { queryFieldTable } from '#ts-openapi/nest/query-fields';
import type { QueryFieldTable } from '#ts-openapi/runtime/query-decode';
import type { JsonSchema } from '#golem/schema';
import { decorateQueryModel, startNestApp } from './support/nest-app.js';
import { registerPassThroughCodec } from './support/pass-through-codec.js';

const REF = '__exprtGeneratedModel:';
const BASE_SCHEMA = {
  type: 'object',
  properties: { limit: { type: 'number' }, active: { type: 'boolean' }, name: { type: 'string' } },
};
const BASE_FIELDS: QueryFieldTable = { active: { types: ['boolean'] }, limit: { types: ['number'] } };
const schemas: Record<string, object> = {
  QueryRootBase: BASE_SCHEMA,
  QueryFieldFlag: { enum: [true, false] },
  QueryFieldLevel: { enum: [1, 2, 3] },
  QueryFieldLoop: { anyOf: [{ enum: [1, 2] }, { $ref: `${REF}QueryFieldLoop` }] },
};
const table = (schema: object): QueryFieldTable | undefined => queryFieldTable(schema as JsonSchema, (name) => schemas[name] as JsonSchema);

/** Serves `GET /?<query>` through NestModelInterceptor for a whole @Query() model of codec `id`, and returns the query the handler received. */
async function queryReceived(id: string, query: string): Promise<unknown> {
  class QueryController {
    list(received: unknown) { return { received }; }
  }
  decorateQueryModel(QueryController, 'list', id);
  const application = await startNestApp([QueryController]);
  try {
    const response = await fetch(`${await application.getUrl()}/?${query}`);
    assert.equal(response.status, 200);
    return ((await response.json()) as { received: unknown }).received;
  } finally {
    await application.close();
  }
}

// protects: T-377 E-49 a whole @Query() model whose schema root is a $ref decoded nothing and handed the handler raw strings
const refRoots = [
  { name: 'a root $ref to another model', schema: { $ref: `${REF}QueryRootBase` }, expected: BASE_FIELDS },
  {
    name: 'a root $ref to a local definition',
    schema: { $ref: '#/$defs/Base', $defs: { Base: BASE_SCHEMA } },
    expected: BASE_FIELDS,
  },
  {
    name: 'a root $ref that names the root itself, which ends without a loop',
    schema: { $ref: '#', properties: { page: { type: 'integer' } } },
    expected: { page: { types: ['integer'] } },
  },
  {
    name: 'a root allOf branch that is a $ref',
    schema: { allOf: [{ $ref: `${REF}QueryRootBase` }, { type: 'object', properties: { page: { type: 'integer' } } }] },
    expected: { ...BASE_FIELDS, page: { types: ['integer'] } },
  },
  {
    name: 'a root $ref that names a model whose own schema refers back to it, which ends without a loop',
    schema: { $ref: `${REF}QueryFieldLoop`, properties: { page: { type: 'integer' } } },
    expected: { page: { types: ['integer'] } },
  },
] as const;
for (const { name, schema, expected } of refRoots) {
  test(`the query fields of a model with ${name}`, () => {
    assert.deepEqual(table(schema), expected);
  });
}

// protects: T-549 I-42 a @Query() model field whose schema is a $ref to a named literal-union alias stayed a raw string
const refFields = [
  {
    name: 'an alias of numbers',
    schema: { type: 'object', properties: { level: { $ref: `${REF}QueryFieldLevel` } } },
    expected: { level: { types: [], literals: [1, 2, 3] } },
  },
  {
    name: 'a local definition of numbers',
    schema: { type: 'object', properties: { level: { $ref: '#/$defs/Level' } }, $defs: { Level: { enum: [1, 2, 3] } } },
    expected: { level: { types: [], literals: [1, 2, 3] } },
  },
  {
    name: 'a local definition that names another definition, in an array field',
    schema: {
      type: 'object',
      properties: { levels: { type: 'array', items: { $ref: '#/$defs/Alias' } } },
      $defs: { Alias: { $ref: '#/$defs/Level' }, Level: { enum: [1, 2, 3] } },
    },
    expected: { levels: { types: [], item: { types: [], literals: [1, 2, 3] } } },
  },
  {
    name: 'a local definition that refers to itself, which ends without a loop',
    schema: { type: 'object', properties: { level: { $ref: '#/$defs/Loop' } }, $defs: { Loop: { anyOf: [{ enum: [1, 2] }, { $ref: '#/$defs/Loop' }] } } },
    expected: { level: { types: [], literals: [1, 2] } },
  },
  {
    name: 'an alias of booleans, in an array field',
    schema: { type: 'object', properties: { flags: { type: 'array', items: { $ref: `${REF}QueryFieldFlag` } } } },
    expected: { flags: { types: [], item: { types: [], literals: [true, false] } } },
  },
  {
    name: 'an alias that refers to itself, which ends without a loop',
    schema: { type: 'object', properties: { level: { $ref: `${REF}QueryFieldLoop` } } },
    expected: { level: { types: [], literals: [1, 2] } },
  },
] as const;
for (const { name, schema, expected } of refFields) {
  test(`the query fields of a model with a field whose schema is a $ref to ${name}`, () => {
    assert.deepEqual(table(schema), expected);
  });
}

// protects: T-741 a query field is found through an items keyword without a type and through the oneOf and anyOf branches of the model
for (const [name, schema, expected] of [
  ['an items keyword without a type', { type: 'object', properties: { ids: { items: { type: 'integer' } } } }, { ids: { types: [], item: { types: ['integer'] } } }],
  ['a oneOf branch of the model', { type: 'object', oneOf: [{ properties: { limit: { type: 'number' } } }, { properties: { name: { type: 'string' } } }] }, { limit: { types: ['number'] } }],
  ['an anyOf branch of the model', { type: 'object', anyOf: [{ properties: { active: { type: 'boolean' } } }] }, { active: { types: ['boolean'] } }],
] as const) {
  test(`the query fields of a model with ${name}`, () => {
    assert.deepEqual(table(schema), expected);
  });
}

test('a model with only string fields has no query fields', () => {
  // protects: T-377 a string-only model, even one with a string-or-array field, registers no query field table
  assert.equal(table({ type: 'object', properties: { name: { type: 'string' }, either: { type: ['string', 'array'], items: { type: 'string' } } } }), undefined);
});

// protects: T-823 a query tuple decoded every position by the item types merged over all positions
test('NestModelInterceptor decodes each position of a query tuple by its own type', async () => {
  const fields = table({
    type: 'object',
    properties: {
      pair: { type: 'array', minItems: 2, prefixItems: [{ type: 'integer' }, { type: 'string' }], items: false, maxItems: 2 },
      mixed: { type: 'array', minItems: 1, prefixItems: [{ type: 'integer' }], items: { type: 'boolean' } },
    },
  });
  assert.deepEqual(fields, {
    mixed: { types: [], item: { types: ['boolean'] }, prefix: [{ types: ['integer'] }] },
    pair: { types: [], item: { types: [] }, prefix: [{ types: ['integer'] }, { types: ['string'] }] },
  });
  registerPassThroughCodec('QueryTuple_0', { data: { nest: fields } });
  assert.deepEqual(
    await queryReceived('QueryTuple_0', 'pair=1&pair=2&pair=3&mixed=1&mixed=true&mixed=false&mixed=x'),
    { pair: [1, '2', '3'], mixed: [1, true, false, 'x'] },
  );
});

// protects: T-823 a branch's items reached no position that another branch lists, so a valid request for a union of an array and a tuple stayed text
for (const [name, schema, query, expected] of [
  ['a tuple, then an array', { oneOf: [{ type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false }, { type: 'array', items: { type: 'boolean' } }] }, 'x=true&x=false', [true, false]],
  ['an array, then a tuple', { oneOf: [{ type: 'array', items: { type: 'boolean' } }, { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false }] }, 'x=true&x=false', [true, false]],
  ['a tuple with a rest, then a tuple', { oneOf: [{ type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'boolean' } }, { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false }] }, 'x=1&x=true', [1, true]],
  ['a tuple, then a tuple with a rest', { oneOf: [{ type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false }, { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'boolean' } }] }, 'x=1&x=true', [1, true]],
] as const) {
  test(`NestModelInterceptor decodes a query union of ${name} by every branch that reaches a position`, async () => {
    const id = `QueryUnion_${name.replaceAll(/\W/g, '')}`;
    registerPassThroughCodec(id, { data: { nest: table({ type: 'object', properties: { x: schema } }) } });
    assert.deepEqual(await queryReceived(id, query), { x: expected });
  });
}

test('NestModelInterceptor decodes a whole @Query() model with the fields of its codec', async () => {
  // protects: T-640 the interceptor decodes a query string by the nest data of the registered codec, not by a schema
  registerPassThroughCodec('QueryRoot_0', { data: { nest: BASE_FIELDS } });
  assert.deepEqual(await queryReceived('QueryRoot_0', 'limit=10&active=true&name=7&page=2'), { limit: 10, active: true, name: '7', page: '2' });
});
