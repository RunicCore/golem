import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, readGeneratedModelSource, requireRecord, writeOpenApiDocument } from './helpers.js';
import { generate } from '#openapi/generator';
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
  // Kept pins: which type a model-layer field names (the Types.<Name> reference or an inline type) is the layering claim; the compile above and the round trip below prove the types and the values.
  assert.match(source, /declare payload: Types\.JsonValue;/);
  assert.match(source, /declare tag\?: string;/);

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
  // Kept pin: the model layer names its own Date type for the alias; the round trip below proves the decode.
  assert.match(source, /type DatedTreeFields = Array<\{ at: Date; kids: DatedTreeFields \}>;/);

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

test('a recursive component that holds a model decodes and initializes a model at each level, and encodes it back', async t => {
  // protects: T-251 init of a recursive alias that reaches a model constructs the model
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-model-'), 'sdk');
  await generateMaterializedSdk(forestDocument, { output, name: 'RecursiveForest', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const models = await loadModels(output);
  const GardenModel = models.GardenModel as new (init: unknown) => { forest: { leaf: unknown; kids: { leaf: unknown }[] }[] };
  const LeafModel = models.LeafModel as abstract new (...args: never[]) => unknown;
  const parseGarden = models.parseGarden as (text: string) => InstanceType<typeof GardenModel>;
  const stringifyGarden = models.stringifyGarden as (value: unknown) => string;
  const wire = { name: 'g', forest: [{ leaf: { name: 'a' }, kids: [{ leaf: { name: 'b' }, kids: [] }] }] };

  const decoded = parseGarden(JSON.stringify(wire));
  assert.equal(decoded.forest[0]?.leaf instanceof LeafModel, true);
  assert.equal(decoded.forest[0]?.kids[0]?.leaf instanceof LeafModel, true);
  const initialized = new GardenModel(wire);
  assert.equal(initialized.forest[0]?.leaf instanceof LeafModel, true);
  assert.equal(initialized.forest[0]?.kids[0]?.leaf instanceof LeafModel, true);
  assert.deepEqual(JSON.parse(stringifyGarden(initialized)), wire);
  assert.deepEqual(JSON.parse(stringifyGarden(decoded)), wire);
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
    profile: { mobx: false, validation: true },
  });
  assert.deepEqual(result.artifacts, []);
  const diagnostics = result.diagnostics ?? [];
  assert.notEqual(diagnostics.length, 0);
  assert.deepEqual([...new Set(diagnostics.map(({ code, severity }) => `${code} ${severity}`))], ['VALIDATE_REF_CYCLE error']);
});
