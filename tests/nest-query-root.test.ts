import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decorateQueryModel, startNestApp } from './support/nest-app.js';
import { registerPassThroughCodec } from './support/pass-through-codec.js';

const BASE_SCHEMA = {
  type: 'object',
  properties: { limit: { type: 'number' }, active: { type: 'boolean' }, name: { type: 'string' } },
};

/** A codec that checks nothing and hands the wire value on, so the test sees what the interceptor decoded. */
function register(id: string, schema: object): void {
  registerPassThroughCodec(id, { schema });
}

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
const DECODED = { limit: 10, active: true, name: '7' };
const refRoots = [
  { name: 'a root $ref to another codec by its id', schema: { $ref: 'QueryRootBase_1' }, expected: { ...DECODED, page: '2' } },
  {
    name: 'a root $ref to a local definition that names a codec',
    schema: { $ref: '#/$defs/Base', $defs: { Base: { $ref: 'QueryRootBase_1' } } },
    expected: { ...DECODED, page: '2' },
  },
  {
    name: 'a root allOf branch that is a $ref',
    schema: { allOf: [{ $ref: 'QueryRootBase_1' }, { type: 'object', properties: { page: { type: 'integer' } } }] },
    expected: { ...DECODED, page: 2 },
  },
  {
    name: 'a root $ref that names the root itself, which ends without a loop',
    schema: { $ref: '#', properties: { page: { type: 'integer' } } },
    expected: { limit: '10', active: 'true', name: '7', page: 2 },
  },
] as const;
register('QueryRootBase_1', BASE_SCHEMA);
for (const [index, { name, schema, expected }] of refRoots.entries()) {
  test(`NestModelInterceptor decodes a whole @Query() model with ${name}`, async () => {
    register(`QueryRoot_${index}`, schema);
    assert.deepEqual(await queryReceived(`QueryRoot_${index}`, 'limit=10&active=true&name=7&page=2'), expected);
  });
}

// protects: T-549 I-42 a @Query() model field whose schema is a $ref to a named literal-union alias stayed a raw string
const refFields = [
  {
    name: 'a local definition of numbers',
    schema: { type: 'object', properties: { level: { $ref: '#/$defs/Level' } }, $defs: { Level: { enum: [1, 2, 3] } } },
    query: 'level=2', expected: { level: 2 },
  },
  {
    name: 'a registered codec of booleans',
    schema: { type: 'object', properties: { flag: { $ref: 'QueryFieldFlag_1' } } },
    query: 'flag=false', expected: { flag: false },
  },
  {
    name: 'a local definition that names another definition, in an array field',
    schema: {
      type: 'object',
      properties: { levels: { type: 'array', items: { $ref: '#/$defs/Alias' } } },
      $defs: { Alias: { $ref: '#/$defs/Level' }, Level: { enum: [1, 2, 3] } },
    },
    query: 'levels=1&levels=3', expected: { levels: [1, 3] },
  },
  {
    name: 'a definition that refers to itself, which ends without a loop',
    schema: { type: 'object', properties: { level: { $ref: '#/$defs/Loop' } }, $defs: { Loop: { anyOf: [{ enum: [1, 2] }, { $ref: '#/$defs/Loop' }] } } },
    query: 'level=2', expected: { level: 2 },
  },
] as const;
register('QueryFieldFlag_1', { enum: [true, false] });
for (const [index, { name, schema, query, expected }] of refFields.entries()) {
  test(`NestModelInterceptor decodes a @Query() field whose schema is a $ref to ${name}`, async () => {
    register(`QueryField_${index}`, schema);
    assert.deepEqual(await queryReceived(`QueryField_${index}`, query), expected);
  });
}
