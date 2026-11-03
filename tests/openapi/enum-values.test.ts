import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import {
  compileGeneratedSdk,
  documentBase,
  generateMaterializedSdk,
  sdkBodyCodec,
  withRootOperations,
  type SdkBodyCodec,
} from './helpers.js';

/** The client's own reading of a value that fails a check. */
const isValidation = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

/** Whether the client sends `value` as a request body; a check that fails is `false`, any other failure is the test's. */
async function requestAccepts(codec: SdkBodyCodec, value: unknown): Promise<boolean> {
  try {
    await codec.encode(value);
    return true;
  } catch (error) {
    if (!isValidation(error)) throw error;
    return false;
  }
}

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
  });
  await generateMaterializedSdk(withRootOperations(document, 'Ticket'), { output, name: 'Enums', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const client = await sdkBodyCodec(output, 'Enums', 'Ticket');
  const body = { rank: 2, mark: 'high', level: 3, label: 'b' };
  assert.deepEqual(await client.encode(body), body);
  assert.deepEqual(await client.decode(body), body);
  for (const [field, value] of [['rank', 4], ['rank', '2'], ['mark', 'mid'], ['level', 4], ['label', 'c']] as const) {
    const bad = { ...body, [field]: value };
    await assert.rejects(client.encode(bad), isValidation, `request ${field} = ${String(value)}`);
    await assert.rejects(client.decode(bad), isValidation, `response ${field} = ${String(value)}`);
  }
});

const shelfDocument = (properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties)) => withRootOperations(documentBase('3.1.0', {
  components: { schemas: { Shelf: { type: 'object', required, properties } } },
}), 'Shelf');

test('an optional model field with an empty enum accepts no value', async t => {
  // protects: T-644 an empty enum admits no value (JSON Schema 2020-12 section 6.1.2), as its type says
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-empty-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({ none: { enum: [] }, name: { type: 'string' } }, ['name']), { output, name: 'Shelves', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const shelf = await sdkBodyCodec(output, 'Shelves', 'Shelf');
  assert.equal(await requestAccepts(shelf, { none: 'x', name: 'a' }), false);
  assert.equal(await requestAccepts(shelf, { none: null, name: 'a' }), false);
  assert.equal(await requestAccepts(shelf, { name: 'a' }), true);
});

for (const [label, schema] of [['an empty enum', { enum: [] }], ['not: true', { not: true }], ['false', false]] as const) {
  test(`a required property whose schema is ${label} stops generation as unsatisfiable and names the schema`, async t => {
    // protects: T-644 a required property that no value can hold stops with OPENAPI_COMPOSITION_UNSATISFIABLE (F-170), as in an allOf; it generated a model that failed tsc
    const output = path.join(createFixtureProject(t, 'golem-openapi-enum-required-'), 'sdk');
    await assert.rejects(
      generateMaterializedSdk(shelfDocument({ none: schema, name: { type: 'string' } }), { output, name: 'Shelves', profile: { validation: true } }),
      /schema "Shelf" at #\/components\/schemas\/Shelf[^:]*: OPENAPI_COMPOSITION_UNSATISFIABLE: No object satisfies this schema: the required property "none" accepts no value/,
    );
  });
}

test('a model field limited by an enum of objects and arrays accepts a listed value and rejects any other', async t => {
  // protects: T-644 an enum of objects or arrays is valid JSON Schema and limits the field by deep equality
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-object-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({ pick: { enum: ['x', { a: 1, b: [2] }, [1, 2], Object.fromEntries([['__proto__', 'p']])] }, name: { type: 'string' } }), { output, name: 'Shelves', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const shelf = await sdkBodyCodec(output, 'Shelves', 'Shelf');
  for (const pick of ['x', { b: [2], a: 1 }, [1, 2], Object.fromEntries([['__proto__', 'p']])]) {
    assert.equal(await requestAccepts(shelf, { pick, name: 'a' }), true, JSON.stringify(pick));
  }
  for (const pick of ['y', { a: 1 }, { a: 1, b: [2], c: 3 }, { a: 1, b: [3] }, [2, 1], null, {}]) {
    assert.equal(await requestAccepts(shelf, { pick, name: 'a' }), false, JSON.stringify(pick));
  }
});

test('a nullable model field limited by an enum that lists an object rejects null that the enum does not list', async t => {
  // protects: T-644 an enum limits null too (JSON Schema 2020-12 section 6.1.2), also when type lists null beside the type of the field
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-nullable-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({ pick: { type: ['string', 'null'], enum: ['x', { a: 1 }] }, name: { type: 'string' } }), { output, name: 'Shelves', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const shelf = await sdkBodyCodec(output, 'Shelves', 'Shelf');
  assert.equal(await requestAccepts(shelf, { pick: 'x', name: 'a' }), true);
  for (const pick of [null, 'y', { a: 1 }]) assert.equal(await requestAccepts(shelf, { pick, name: 'a' }), false, JSON.stringify(pick));
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
  }), { output, name: 'Shelves', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const shelf = await sdkBodyCodec(output, 'Shelves', 'Shelf');
  const body = { count: 2, word: 'a', short: 'a', code: 'ab', whole: 1, free: 2 };
  assert.equal(await requestAccepts(shelf, body), true);
  assert.equal(await requestAccepts(shelf, { ...body, free: 'x' }), true);
  for (const [field, value] of [['count', 1], ['word', 1], ['short', 'bb'], ['code', 'b'], ['whole', 1.5], ['free', 1]] as const) {
    assert.equal(await requestAccepts(shelf, { ...body, [field]: value }), false, `${field} = ${String(value)}`);
  }
});

for (const [label, schema] of [
  ['an enum that its type empties', { type: 'string', enum: [1, 2] }],
  ['a const that its type excludes', { type: 'string', const: 1 }],
  ['a const of another type', { type: 'integer', const: 'a' }],
  ['a const object under a scalar type', { type: 'string', const: { a: 1 } }],
  ['a const that its enum does not list', { const: 1, enum: [2] }],
] as const) {
  test(`a required property whose schema is ${label} stops generation as unsatisfiable`, async t => {
    // protects: T-667 T-668 enum and const keep only the values that type admits; a required property left with none stops generation (T-644 rule)
    const output = path.join(createFixtureProject(t, 'golem-openapi-enum-type-empty-'), 'sdk');
    await assert.rejects(
      generateMaterializedSdk(shelfDocument({ none: schema, name: { type: 'string' } }), { output, name: 'Shelves', profile: { validation: true } }),
      /schema "Shelf" at #\/components\/schemas\/Shelf[^:]*: OPENAPI_COMPOSITION_UNSATISFIABLE: No object satisfies this schema: the required property "none" accepts no value/,
    );
  });
}

test('an enum and a const keep the type and the keywords beside them, in the model and in the generated type', async t => {
  // protects: T-667 T-668 one rule for enum and const: the type filter and the sibling keywords (a const was a bare literal)
  const output = path.join(createFixtureProject(t, 'golem-openapi-const-keywords-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({
    word: { type: 'string', enum: ['a', 1] },
    never: { type: 'string', const: 1 },
    low: { type: 'integer', minimum: 2, const: 1 },
    fixed: { type: 'integer', minimum: 2, const: 2 },
    same: { type: 'integer', const: 1.0 },
    deep: { type: 'string', const: { a: 1 } },
    both: { const: 1, enum: [1, 2] },
  }, ['word', 'fixed', 'same', 'both']), { output, name: 'Shelves', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const shelf = await sdkBodyCodec(output, 'Shelves', 'Shelf');
  const body = { word: 'a', fixed: 2, same: 1, both: 1 };
  assert.equal(await requestAccepts(shelf, body), true);
  for (const [field, value] of [['word', 1], ['fixed', 3], ['same', 2], ['never', 1], ['never', '1'], ['low', 1], ['low', 2], ['deep', 'x'], ['deep', { a: 1 }], ['both', 2]] as const) {
    assert.equal(await requestAccepts(shelf, { ...body, [field]: value }), false, `${field} = ${JSON.stringify(value)}`);
  }
  const source = readdirSync(output, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.includes('node_modules'))
    .map(file => readFileSync(path.join(output, file), 'utf8')).join('\n');
  assert.match(source, /word: "a";/);
  assert.match(source, /never\?: never;/);
  assert.match(source, /both: 1;/);
});

for (const [label, schema] of [
  ['a const that its minimum excludes', { type: 'integer', minimum: 2, const: 1 }],
  ['an enum that its multipleOf empties', { enum: [1, 3], multipleOf: 2 }],
  ['a const string that its pattern excludes', { const: 'x', pattern: '^a' }],
  ['an enum of strings that its minLength empties', { enum: ['a', 'bb'], minLength: 3 }],
  ['an enum of arrays that its maxItems empties', { enum: [[1, 2], [3]], maxItems: 0 }],
  ['an enum that its maximum empties', { enum: [3, 4], maximum: 2 }],
  ['an enum that its exclusiveMinimum empties at the limit', { enum: [1, 2], exclusiveMinimum: 2 }],
  ['an enum that its exclusiveMaximum empties at the limit', { enum: [2, 3], exclusiveMaximum: 2 }],
  ['an enum of strings that its maxLength empties', { enum: ['ab', 'abc'], maxLength: 1 }],
  ['an enum of arrays that its minItems empties', { enum: [[1], []], minItems: 2 }],
  ['an enum of objects that its minProperties empties', { enum: [{ a: 1 }, {}], minProperties: 2 }],
  ['an enum of objects that its maxProperties empties', { enum: [{ a: 1 }, { a: 1, b: 2 }], maxProperties: 0 }],
  ['an enum that its not lists in full', { enum: [1], not: { enum: [1] } }],
] as const) {
  test(`a required property whose schema is ${label} stops generation as unsatisfiable`, async t => {
    // protects: T-840 a required enum or const that its sibling keywords exclude stops generation (it generated a model that rejected every value)
    const output = path.join(createFixtureProject(t, 'golem-openapi-enum-keywords-empty-'), 'sdk');
    await assert.rejects(
      generateMaterializedSdk(shelfDocument({ none: schema, name: { type: 'string' } }), { output, name: 'Shelves', profile: { validation: true } }),
      /schema "Shelf" at #\/components\/schemas\/Shelf[^:]*: OPENAPI_COMPOSITION_UNSATISFIABLE: No object satisfies this schema: the required property "none" accepts no value/,
    );
  });
}

test('an enum drops each listed value that a keyword beside it excludes, in the generated type and in the validator, and an optional field still generates', async t => {
  // protects: T-840 one rule drops the listed values that minimum, multipleOf, pattern and minLength exclude, for the type and the validator alike
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-keywords-'), 'sdk');
  await generateMaterializedSdk(shelfDocument({
    count: { enum: [1, 2, 3], minimum: 2 },
    even: { enum: [1, 2, 3, 4], multipleOf: 2 },
    word: { enum: ['ab', 'b', 'abc'], pattern: '^a', minLength: 3 },
    low: { type: 'integer', minimum: 2, const: 1 },
  }, ['count', 'even', 'word']), { output, name: 'Shelves', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const shelf = await sdkBodyCodec(output, 'Shelves', 'Shelf');
  const body = { count: 2, even: 4, word: 'abc' };
  assert.equal(await requestAccepts(shelf, body), true);
  assert.equal(await requestAccepts(shelf, { ...body, count: 3, even: 2 }), true);
  for (const [field, value] of [['count', 1], ['even', 1], ['even', 3], ['word', 'ab'], ['word', 'b'], ['low', 1], ['low', 2]] as const) {
    assert.equal(await requestAccepts(shelf, { ...body, [field]: value }), false, `${field} = ${JSON.stringify(value)}`);
  }
  const source = readdirSync(output, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.includes('node_modules'))
    .map(file => readFileSync(path.join(output, file), 'utf8')).join('\n');
  assert.match(source, /count: 2 \| 3;/);
  assert.match(source, /even: 2 \| 4;/);
  assert.match(source, /word: "abc";/);
  assert.match(source, /low\?: never;/);
});
