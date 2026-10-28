import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { queryFieldTable } from '#golem/query-fields';
import type { JsonSchema } from '#golem/schema';
import type { QueryFieldTable } from '@exprtlabs/golem/serde';
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

test('a model with only string fields has no query fields', () => {
  // protects: T-377 a string-only model, even one with a string-or-array field, registers no query field table
  assert.equal(table({ type: 'object', properties: { name: { type: 'string' }, either: { type: ['string', 'array'], items: { type: 'string' } } } }), undefined);
});

test('NestModelInterceptor decodes a whole @Query() model with the fields of its codec', async () => {
  // protects: T-640 the interceptor decodes a query string by the queryFields of the registered codec, not by a schema
  registerPassThroughCodec('QueryRoot_0', { queryFields: BASE_FIELDS });
  assert.deepEqual(await queryReceived('QueryRoot_0', 'limit=10&active=true&name=7&page=2'), { limit: 10, active: true, name: '7', page: '2' });
});
