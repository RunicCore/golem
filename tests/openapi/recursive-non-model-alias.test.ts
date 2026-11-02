import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, sdkBodyCodec, withRootOperations, writeOpenApiDocument } from './helpers.js';
import { LibError } from '@exprtlabs/golem/errors';
import { dateTime, object, operation, ref } from './schema-builders.js';
import { generate } from '#openapi/generator';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// JsonValue reaches itself through an array and an object and holds no date or model: its wire type is its model type.
// Tag is a non-model component that reaches nothing, so it stays inline.
const jsonDocument = {
  openapi: '3.1.0',
  info: { title: 'RecursiveJson', version: '1' },
  paths: { '/notes': operation('createNote', 'Note') },
  components: {
    schemas: {
      JsonValue: {
        oneOf: [
          { type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string' },
          { type: 'array', items: ref('JsonValue') },
          { type: 'object', additionalProperties: ref('JsonValue') },
        ],
      },
      Tag: { type: 'string', maxLength: 20 },
      Note: object({ title: { type: 'string' }, payload: ref('JsonValue'), tag: ref('Tag') }, ['title', 'payload']),
    },
  },
};

// DatedTree is an array of objects that hold a date and the array again. Log and Audit share nothing else, so they sit
// in two model groups and DatedTree in a third.
const datedDocument = {
  openapi: '3.1.0',
  info: { title: 'RecursiveDated', version: '1' },
  paths: { '/logs': operation('createLog', 'Log'), '/audits': operation('createAudit', 'Audit') },
  components: {
    schemas: {
      DatedTree: { type: 'array', items: object({ at: dateTime, kids: ref('DatedTree') }, ['at', 'kids']) },
      Log: object({ name: { type: 'string' }, history: ref('DatedTree') }, ['name', 'history']),
      Audit: object({ owner: { type: 'string' }, trail: ref('DatedTree') }, ['owner', 'trail']),
    },
  },
};

function groupSources(output: string): string[] {
  const directory = path.join(output, 'models');
  return readdirSync(directory).filter(name => /^_group-.*\.ts$/.test(name)).sort()
    .map(name => readFileSync(path.join(directory, name), 'utf8'));
}

test('a recursive non-model component generates and its body round-trips through the client', async t => {
  // protects: A-60 case 10 recursive non-object component generates
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-json-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(jsonDocument, 'Note'), { output, name: 'RecursiveJson', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });

  const note = await sdkBodyCodec(output, 'RecursiveJson', 'Note');
  const wire = { title: 'a', payload: { list: [1, null, { deep: ['x', true] }], n: 2.5 }, tag: 't' };
  const decoded = await note.decode(wire);
  assert.deepEqual(decoded, wire);
  assert.deepEqual(await note.encode(decoded), wire);
});

test('two model groups that hold one recursive component share its functions, defined once', async t => {
  // protects: A-60 case 11 alias shared across groups defines no function twice
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-groups-'), 'sdk');
  await generateMaterializedSdk(datedDocument, { output, name: 'RecursiveDated', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const sources = groupSources(output);
  assert.equal(sources.length, 3);
  assert.equal(sources.filter(source => /^(export )?function fromWireFormatDatedTree\(/m.test(source)).length, 1);
  assert.equal(sources.filter(source => /^(export )?function toWireFormatDatedTree\(/m.test(source)).length, 1);
  const importing = sources.filter(source => /import \{[^}]*\bfromWireFormatDatedTree\b[^}]*\} from "\.\/_group-/.test(source));
  assert.equal(importing.length, 2);
});

test('a recursive component that holds a date-time value decodes the date at each level and encodes it back', async t => {
  // protects: A-60 case 16 recursive component with a date decodes the date
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-date-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(datedDocument, 'Log'), { output, name: 'RecursiveDated', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });

  const log = await sdkBodyCodec(output, 'RecursiveDated', 'Log');
  const wire = {
    name: 'l',
    history: [{ at: '2025-01-02T03:04:05.000Z', kids: [{ at: '2025-02-03T04:05:06.000Z', kids: [] }] }],
  };
  const decoded = await log.decode(wire);
  assert.deepEqual(decoded, {
    name: 'l',
    history: [{ at: new Date('2025-01-02T03:04:05.000Z'), kids: [{ at: new Date('2025-02-03T04:05:06.000Z'), kids: [] }] }],
  });
  assert.deepEqual(await log.encode(decoded), wire);
});

// Forest is an array of inline objects that hold a Leaf model and the array again.
const forestDocument = {
  openapi: '3.1.0',
  info: { title: 'RecursiveForest', version: '1' },
  paths: { '/gardens': operation('createGarden', 'Garden') },
  components: {
    schemas: {
      Leaf: object({ name: { type: 'string' } }, ['name']),
      Forest: { type: 'array', items: object({ leaf: ref('Leaf'), kids: ref('Forest') }, ['leaf', 'kids']) },
      Garden: object({ name: { type: 'string' }, forest: ref('Forest') }, ['name', 'forest']),
    },
  },
};

test('a recursive component that holds a model checks the model at each level', async t => {
  // protects: T-251 recursive alias that reaches a model is checked at each level
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-model-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(forestDocument, 'Garden'), { output, name: 'RecursiveForest', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });

  const garden = await sdkBodyCodec(output, 'RecursiveForest', 'Garden');
  const wire = { name: 'g', forest: [{ leaf: { name: 'a' }, kids: [{ leaf: { name: 'b' }, kids: [] }] }] };
  assert.deepEqual(await garden.decode(wire), wire);
  assert.deepEqual(await garden.encode(wire), wire);
  const nestedLeafWithoutName = { name: 'g', forest: [{ leaf: { name: 'a' }, kids: [{ leaf: {}, kids: [] }] }] };
  await assert.rejects(() => garden.decode(nestedLeafWithoutName), (error: unknown) => error instanceof LibError);
  await assert.rejects(() => garden.encode(nestedLeafWithoutName), (error: unknown) => error instanceof LibError);
});

test('a component that is only a $ref to itself stops generation with the ref cycle error', async t => {
  // protects: T-251 a $ref loop without a base case is reported, not an internal error
  const directory = createFixtureProject(t, 'golem-openapi-ref-loop-');
  const loop = {
    openapi: '3.1.0',
    info: { title: 'RefLoop', version: '1' },
    paths: { '/loops': operation('createLoop', 'Holder') },
    components: { schemas: { A: ref('A'), Holder: object({ value: ref('A') }, ['value']) } },
  };
  const result = await generate({
    input: writeOpenApiDocument(directory, loop),
    output: path.join(directory, 'sdk'),
    profile: { validation: true },
  });
  assert.deepEqual(result.artifacts, []);
  const diagnostics = result.diagnostics ?? [];
  assert.notEqual(diagnostics.length, 0);
  assert.deepEqual([...new Set(diagnostics.map(({ code, severity }) => `${code} ${severity}`))], ['VALIDATE_REF_CYCLE error']);
});

/** A component `JsonValue` that is a string or a `branch` schema, so it reaches itself only through a keyword of the branch. */
function recursesThrough(branch: Record<string, unknown>): Record<string, unknown> {
  return withRootOperations({
    openapi: '3.1.0',
    info: { title: 'RecursiveKeyword', version: '1' },
    paths: {},
    components: { schemas: { JsonValue: { oneOf: [{ type: 'string' }, branch] } } },
  }, 'JsonValue');
}

for (const { keyword, branch, valid, invalid } of [
  { keyword: 'patternProperties', branch: { type: 'object', patternProperties: { '^.*$': ref('JsonValue') } }, valid: { a: 'x' }, invalid: [{ a: 1 }] },
  { keyword: 'unevaluatedProperties', branch: { type: 'object', unevaluatedProperties: ref('JsonValue') }, valid: { a: 'x' }, invalid: [{ a: 1 }] },
  { keyword: 'contains', branch: { type: 'array', contains: ref('JsonValue') }, valid: ['x'], invalid: [[1]] },
  { keyword: 'propertyNames', branch: { type: 'object', propertyNames: ref('JsonValue') }, valid: { a: 1 }, invalid: [] },
]) {
  test(`a component that recurses only through ${keyword} generates and checks each level`, async t => {
    // protects: T-866 a component that reached itself only through a constraint keyword failed generation
    const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-keyword-'), 'sdk');
    await generateMaterializedSdk(recursesThrough(branch), { output, name: 'RecursiveKeyword', profile: { validation: true } });
    compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
    const codec = await sdkBodyCodec(output, 'RecursiveKeyword', 'JsonValue');
    assert.deepEqual(await codec.decode(valid), valid);
    await Promise.all(invalid.map(value => assert.rejects(() => codec.decode(value), (error: unknown) => error instanceof LibError)));
  });
}

for (const [keyword, branch] of [
  ['not', { type: 'object', not: ref('JsonValue') }],
  ['if', { type: 'object', if: ref('JsonValue'), then: { type: 'object' } }],
] as const) {
  test(`a component that returns to itself through ${keyword} without reading the value stops generation with a located ref cycle error`, async t => {
    // protects: T-866 a component that reached itself only through not or if ended in an internal error
    const directory = createFixtureProject(t, 'golem-openapi-recursive-keyword-');
    const result = await generate({
      input: writeOpenApiDocument(directory, recursesThrough(branch)),
      output: path.join(directory, 'sdk'),
      profile: { validation: true },
    });
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(
      (result.diagnostics ?? []).map(({ code, severity, message }) => `${code} ${severity} ${message.split(':')[0]}`),
      [
        'VALIDATE_REF_CYCLE error openapi.json#/components/schemas/JsonValue',
        `VALIDATE_REF_CYCLE error openapi.json#/components/schemas/JsonValue/oneOf/1/${keyword}/$ref`,
      ],
    );
  });
}
