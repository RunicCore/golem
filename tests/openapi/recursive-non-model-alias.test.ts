import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, readGeneratedModelSource, requireRecord } from './helpers.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const dateTime = { type: 'string', format: 'date-time' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', required, properties });
const operation = (id: string, schema: string) => ({
  post: {
    operationId: id,
    requestBody: { required: true, content: { 'application/json': { schema: ref(schema) } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref(schema) } } } },
  },
});

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

async function loadModels(output: string): Promise<Record<string, unknown>> {
  return requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
}

test('a recursive non-model component is typed Types.<Name> with no alias in the model layer, and a plain one stays inline', async t => {
  // protects: A-60 case 10 recursive non-object component generates
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-json-'), 'sdk');
  await generateMaterializedSdk(jsonDocument, { output, name: 'RecursiveJson', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const source = readGeneratedModelSource(output);
  assert.match(source, /declare payload: Types\.JsonValue;/);
  assert.match(source, /declare tag\?: string;/);
  assert.doesNotMatch(source, /type JsonValue\b/);
  assert.doesNotMatch(source, /Recursive schema aliases/);

  const models = await loadModels(output);
  const stringifyNote = models.stringifyNote as (value: unknown) => string;
  const parseNote = models.parseNote as (text: string) => { payload: unknown };
  const wire = { title: 'a', payload: { list: [1, null, { deep: ['x', true] }], n: 2.5 }, tag: 't' };
  const note = parseNote(JSON.stringify(wire));
  assert.deepEqual(note.payload, wire.payload);
  assert.deepEqual(JSON.parse(stringifyNote(note)), wire);
});

test('two model groups that hold one recursive component share its functions, defined once', async t => {
  // protects: A-60 case 11 alias shared across groups defines no function twice
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-groups-'), 'sdk');
  await generateMaterializedSdk(datedDocument, { output, name: 'RecursiveDated', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const sources = groupSources(output);
  assert.equal(sources.length, 3);
  assert.equal(sources.filter(source => /^(export )?function fromWireFormatDatedTree\(/m.test(source)).length, 1);
  assert.equal(sources.filter(source => /^(export )?function toWireFormatDatedTree\(/m.test(source)).length, 1);
  const importing = sources.filter(source => /import \{[^}]*\bfromWireFormatDatedTree\b[^}]*\} from "\.\/_group-/.test(source));
  assert.equal(importing.length, 2);
});

test('a recursive component that holds a date-time value types it as Date in the model layer and decodes it', async t => {
  // protects: A-60 case 16 recursive component with a date decodes the date
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-date-'), 'sdk');
  await generateMaterializedSdk(datedDocument, { output, name: 'RecursiveDated', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const source = readGeneratedModelSource(output);
  assert.match(source, /type DatedTreeFields = Array<\{ at: Date; kids: DatedTreeFields \}>;/);
  assert.doesNotMatch(source, /declare history: Types\.DatedTree;/);

  const models = await loadModels(output);
  const stringifyLog = models.stringifyLog as (value: unknown) => string;
  const parseLog = models.parseLog as (text: string) => { history: { at: Date; kids: { at: Date }[] }[] };
  const wire = {
    name: 'l',
    history: [{ at: '2025-01-02T03:04:05.000Z', kids: [{ at: '2025-02-03T04:05:06.000Z', kids: [] }] }],
  };
  const log = parseLog(JSON.stringify(wire));
  assert.equal(log.history[0]?.at instanceof Date, true);
  assert.equal(log.history[0]?.kids[0]?.at instanceof Date, true);
  assert.equal(log.history[0]?.kids[0]?.at.toISOString(), '2025-02-03T04:05:06.000Z');
  assert.deepEqual(JSON.parse(stringifyLog(log)), wire);
});
