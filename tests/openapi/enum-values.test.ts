import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import {
  compileGeneratedSdk,
  documentBase,
  generateMaterializedSdk,
  importSdkCodecs,
  sdkFunction,
} from './helpers.js';

test('a model field limited by enum, with or without type, rejects a value outside the list', async t => {
  // protects: T-644 an enum with no type, or with a type, limits a model field to its listed values
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-values-'), 'sdk');
  const document = documentBase('3.1.0', {
    components: { schemas: {
      Ticket: {
        type: 'object',
        required: ['rank', 'mark', 'level', 'label'],
        properties: {
          rank: { enum: [1, 2, 3] },
          mark: { enum: ['low', 'high'] },
          level: { type: 'integer', enum: [1, 2, 3] },
          label: { type: 'string', enum: ['a', 'b'] },
        },
      },
    } },
    paths: { '/tickets': { post: {
      operationId: 'echo',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } } },
    } } },
  });
  await generateMaterializedSdk(document, { output, name: 'Enums', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const models = await importSdkCodecs(output, 'enum models');
  const validateTicket = sdkFunction<boolean>(models, 'validate', 'Ticket');
  const fromWireFormatTicket = sdkFunction(models, 'fromWireFormat', 'Ticket');
  const body = { rank: 2, mark: 'high', level: 3, label: 'b' };
  assert.equal(await validateTicket(body), true);
  assert.deepEqual({ ...(fromWireFormatTicket(body) as object) }, body);
  for (const [field, value] of [['rank', 4], ['rank', '2'], ['mark', 'mid'], ['level', 4], ['label', 'c']] as const) {
    const bad = { ...body, [field]: value };
    assert.equal(await validateTicket(bad), false, `validate ${field} = ${String(value)}`);
    assert.throws(
      () => fromWireFormatTicket(bad),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
      `decode ${field} = ${String(value)}`,
    );
  }
});

const shelfDocument = (properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties)) => documentBase('3.1.0', {
  components: { schemas: { Shelf: { type: 'object', required, properties } } },
  paths: { '/shelves': { post: {
    operationId: 'echo',
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Shelf' } } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Shelf' } } } } },
  } } },
});

test('an optional model field with an empty enum accepts no value', async t => {
  // protects: T-644 an empty enum admits no value (JSON Schema 2020-12 section 6.1.2), as its type says
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-empty-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({ none: { enum: [] }, name: { type: 'string' } }, ['name']), { output, name: 'Shelves', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const models = await importSdkCodecs(output, 'empty enum models');
  const validateShelf = sdkFunction<boolean>(models, 'validate', 'Shelf');
  assert.equal(await validateShelf({ none: 'x', name: 'a' }), false);
  assert.equal(await validateShelf({ none: null, name: 'a' }), false);
  assert.equal(await validateShelf({ name: 'a' }), true);
});

for (const [label, schema] of [['an empty enum', { enum: [] }], ['not: true', { not: true }], ['false', false]] as const) {
  test(`a required property whose schema is ${label} stops generation as unsatisfiable and names the schema`, async t => {
    // protects: T-644 a required property that no value can hold stops with OPENAPI_COMPOSITION_UNSATISFIABLE (F-170), as in an allOf; it generated a model that failed tsc
    const output = path.join(createFixtureProject(t, 'golem-openapi-enum-required-'), 'sdk');
    await assert.rejects(
      generateMaterializedSdk(shelfDocument({ none: schema, name: { type: 'string' } }), { output, name: 'Shelves', profile: { mobx: false, validation: true } }),
      /schema "Shelf" at #\/components\/schemas\/Shelf[^:]*: OPENAPI_COMPOSITION_UNSATISFIABLE: No object satisfies this schema: the required property "none" accepts no value/,
    );
  });
}

test('a model field limited by an enum of objects and arrays accepts a listed value and rejects any other', async t => {
  // protects: T-644 an enum of objects or arrays is valid JSON Schema and limits the field by deep equality
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-object-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({ pick: { enum: ['x', { a: 1, b: [2] }, [1, 2], Object.fromEntries([['__proto__', 'p']])] }, name: { type: 'string' } }), { output, name: 'Shelves', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const models = await importSdkCodecs(output, 'object enum models');
  const validateShelf = sdkFunction<boolean>(models, 'validate', 'Shelf');
  for (const pick of ['x', { b: [2], a: 1 }, [1, 2], Object.fromEntries([['__proto__', 'p']])]) {
    assert.equal(await validateShelf({ pick, name: 'a' }), true, JSON.stringify(pick));
  }
  for (const pick of ['y', { a: 1 }, { a: 1, b: [2], c: 3 }, { a: 1, b: [3] }, [2, 1], null, {}]) {
    assert.equal(await validateShelf({ pick, name: 'a' }), false, JSON.stringify(pick));
  }
});

test('a nullable model field limited by an enum that lists an object rejects null that the enum does not list', async t => {
  // protects: T-644 an enum limits null too (JSON Schema 2020-12 section 6.1.2), also when type lists null beside the type of the field
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-nullable-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({ pick: { type: ['string', 'null'], enum: ['x', { a: 1 }] }, name: { type: 'string' } }), { output, name: 'Shelves', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const models = await importSdkCodecs(output, 'nullable object enum models');
  const validateShelf = sdkFunction<boolean>(models, 'validate', 'Shelf');
  assert.equal(await validateShelf({ pick: 'x', name: 'a' }), true);
  for (const pick of [null, 'y', { a: 1 }]) assert.equal(await validateShelf({ pick, name: 'a' }), false, JSON.stringify(pick));
});

test('a scalar enum keeps the keywords beside it and drops a listed value that its type excludes', async t => {
  // protects: T-644 a scalar enum is still limited by minimum, maxLength, pattern and type (an enum of scalars became a bare literal union)
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-scalar-keywords-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({
    count: { type: 'integer', minimum: 2, enum: [1, 2, 3] },
    word: { type: 'string', enum: ['a', 1] },
    short: { type: 'string', maxLength: 1, enum: ['a', 'bb'] },
    code: { type: 'string', pattern: '^a', enum: ['ab', 'b'] },
    whole: { type: 'integer', enum: [1, 1.5] },
    free: { minimum: 2, enum: [1, 2, 'x'] },
  }), { output, name: 'Shelves', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const models = await importSdkCodecs(output, 'scalar enum keyword models');
  const validateShelf = sdkFunction<boolean>(models, 'validate', 'Shelf');
  const body = { count: 2, word: 'a', short: 'a', code: 'ab', whole: 1, free: 2 };
  assert.equal(await validateShelf(body), true);
  assert.equal(await validateShelf({ ...body, free: 'x' }), true);
  for (const [field, value] of [['count', 1], ['word', 1], ['short', 'bb'], ['code', 'b'], ['whole', 1.5], ['free', 1]] as const) {
    assert.equal(await validateShelf({ ...body, [field]: value }), false, `${field} = ${String(value)}`);
  }
});
