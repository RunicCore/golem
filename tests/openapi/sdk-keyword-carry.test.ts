import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { fileFixtureScope, onceShared } from '../fixture-project.js';
import { importGeneratedModule, sdkBodyCodec, withRootOperations } from './helpers.js';
import { loadGolemModeProject, loadSdk, type GolemModeSdkSetup } from './sdk-client-fixture.js';

// Every JSON Schema keyword that a model descriptor can carry reaches the model plane, so a body that converts a date is checked
// by the full schema (T-729). Each row is one component: an object with a `when` date-time field and the keyword under test.

const AT = '2025-01-02T03:04:05.000Z';
const DATE_TIME = { type: 'string', format: 'date-time' };
const body = (keywords: Record<string, unknown>, properties: Record<string, unknown> = {}) => ({
  type: 'object', required: ['when'], properties: { when: DATE_TIME, ...properties }, ...keywords,
});
const text = { type: 'string' };

/** `bad` breaks the keyword and `good` keeps it; both are the body without `when`. */
const ROWS = [
  { name: 'NotRule', schema: body({ not: { required: ['banned'] } }), bad: { banned: 1 }, good: {} },
  { name: 'ContainsRule', schema: body({}, { list: { type: 'array', items: text, contains: { const: 'x' } } }), bad: { list: ['y'] }, good: { list: ['x'] } },
  { name: 'PropertyNamesRule', schema: body({ propertyNames: { pattern: '^[a-z]+$' } }), bad: { 'A-1': 1 }, good: { abc: 1 } },
  { name: 'PatternPropertiesRule', schema: body({ patternProperties: { '^x-': text } }), bad: { 'x-a': 1 }, good: { 'x-a': 's' } },
  { name: 'DependentRequiredRule', schema: body({ dependentRequired: { card: ['cvc'] } }), bad: { card: '1' }, good: { card: '1', cvc: '2' } },
  { name: 'DependentSchemasRule', schema: body({ dependentSchemas: { card: { required: ['cvc'] } } }), bad: { card: '1' }, good: { card: '1', cvc: '2' } },
  { name: 'IfThenElseRule', schema: body({ if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['a'] }, else: { required: ['b'] } }), bad: { kind: 'a' }, good: { kind: 'a', a: 1 } },
  { name: 'UnevaluatedPropertiesRule', schema: body({ unevaluatedProperties: false }), bad: { extra: 1 }, good: {} },
  { name: 'UnevaluatedItemsRule', schema: body({}, { list: { type: 'array', prefixItems: [text], unevaluatedItems: false } }), bad: { list: ['a', 'b'] }, good: { list: ['a'] } },
  { name: 'ConstObjectRule', schema: body({}, { pin: { type: 'object', properties: { a: { type: 'integer' } }, const: { a: 1 } } }), bad: { pin: { a: 2 } }, good: { pin: { a: 1 } } },
  { name: 'EnumObjectRule', schema: body({}, { pin: { type: 'object', properties: { a: { type: 'integer' } }, enum: [{ a: 1 }, { a: 2 }] } }), bad: { pin: { a: 3 } }, good: { pin: { a: 2 } } },
  { name: 'LimitBesideOneOfRule', schema: body({}, { tag: { oneOf: [text, { type: 'integer' }], maxLength: 3 } }), bad: { tag: 'abcd' }, good: { tag: 'abc' } },
  { name: 'FreeFormRule', schema: body({}, { meta: { type: 'object' } }), bad: { meta: 'x' }, good: { meta: { a: 1 } } },
  { name: 'OneOfOverlapRule', schema: body({}, { pick: { oneOf: [text, { type: 'string', maxLength: 3 }] } }), bad: { pick: 'abc' }, good: { pick: 'abcd' } },
  { name: 'LimitBesideAllOfRule', schema: body({}, { tag: { allOf: [text], maxLength: 3 } }), bad: { tag: 'abcd' }, good: { tag: 'abc' } },
] as const;
type Row = (typeof ROWS)[number];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ 'application/json': { schema: ref(name) } });
const DOCUMENT = {
  ...withRootOperations({
    openapi: '3.1.0',
    info: { title: 'Keywords', version: '1' },
    components: { schemas: Object.fromEntries(ROWS.map((row) => [row.name, row.schema])) },
  }, ...ROWS.map((row) => row.name)),
  webhooks: Object.fromEntries(ROWS.map((row) => [row.name, { post: { operationId: `receive${row.name}`, responses: { 200: { description: 'ok', content: json(row.name) } } } }])),
};

const scope = fileFixtureScope();
const sdk = onceShared(() => loadSdk(scope, 'golem-openapi-keyword-carry-', { document: DOCUMENT, name: 'Keywords', dates: 'date', validation: true }));
const GOLEM_SDK: GolemModeSdkSetup = { document: DOCUMENT, folder: 'sdk/keywords', name: 'Keywords' };
const MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import type { ${ROWS.map((row) => row.name).join(', ')} } from '../sdk/keywords/index.js';
${ROWS.map((row) => `export type T${row.name} = IModel<${row.name}>;`).join('\n')}
`;
const golemModel = onceShared(async () => {
  const project = await loadGolemModeProject(scope, 'golem-openapi-keyword-carry-model-', [GOLEM_SDK], true, { 'src/keywords.model.ts': MODEL });
  return await import(pathToFileURL(path.join(project.root, 'build', 'src/keywords.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
});

const isValidation = (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation;
const withWhen = (value: object, when: unknown) => ({ ...value, when });
// A converted value writes `when` as the wire text and a Date reads back as it; the codec leaves the names the schema does not list out, so only `when` is compared.
const writesWhen = (value: unknown) => JSON.stringify(value).includes(`"when":"${AT}"`);

async function inboundHandler(row: Row): Promise<{ readonly answer: (value: object) => Promise<unknown> }> {
  const { output } = await sdk();
  const bind = (await importGeneratedModule(output, 'generated SDK')).bindKeywordsInbound as (port: Record<string, unknown>) => Record<string, (request: unknown) => Promise<unknown>>;
  let reply: unknown;
  const port = Object.fromEntries(ROWS.map((item) => [`webhookReceive${item.name}`, async () => reply]));
  const handlers = bind(port);
  return {
    answer: async (value) => {
      reply = { matched: 'status', status: 200, contentType: 'application/json', body: withWhen(value, new Date(AT)), headers: {} };
      return handlers[`webhookReceive${row.name}`]!({});
    },
  };
}

for (const row of ROWS) {
  test(`a request body with a date is checked against ${row.name}`, async () => {
    // protects: T-729, F-163 a keyword of the full schema reaches the model plane of a converting request body
    const codec = await sdkBodyCodec((await sdk()).output, 'Keywords', row.name);
    const when = new Date(AT);
    await assert.rejects(codec.encode(withWhen(row.bad, when)), isValidation);
    assert.ok(writesWhen(await codec.encode(withWhen(row.good, when))));
  });

  test(`an inbound response with a date is checked against ${row.name}`, async () => {
    // protects: T-729, F-163 a keyword of the full schema reaches the model plane of a converting inbound response
    const { answer } = await inboundHandler(row);
    await assert.rejects(answer(row.bad), isValidation);
    assert.ok(writesWhen(await answer(row.good)));
  });

  test(`an app model over the SDK type checks ${row.name} when it reads and writes`, async () => {
    // protects: T-729, F-163 a keyword of the full schema reaches the model plane of an app model over an SDK type
    const generated = await golemModel();
    const read = generated[`fromWireFormatT${row.name}`]!;
    const write = generated[`toWireFormatT${row.name}`]!;
    assert.throws(() => read(withWhen(row.bad, AT)), isValidation);
    assert.throws(() => write(withWhen(row.bad, new Date(AT))), isValidation);
    assert.ok(writesWhen(read(withWhen(row.good, AT))));
    assert.ok(writesWhen(write(withWhen(row.good, new Date(AT)))));
  });
}

// A keyword that no descriptor carries (here the text of a date-time string) marks its node: the SDK checks the body in its wire form too,
// and an app model over the type stops generation.
const STAMP_DOCUMENT = {
  ...withRootOperations({
    openapi: '3.1.0',
    info: { title: 'Stamps', version: '1' },
    components: { schemas: { Stamp: { type: 'object', required: ['at'], properties: { at: { ...DATE_TIME, pattern: '^2025' } } } } },
  }, 'Stamp'),
  webhooks: { Stamp: { post: { operationId: 'receiveStamp', responses: { 200: { description: 'ok', content: json('Stamp') } } } } },
};
const stamps = onceShared(() => loadSdk(scope, 'golem-openapi-keyword-stamps-', { document: STAMP_DOCUMENT, name: 'Stamps', dates: 'date', validation: true }));
const BEFORE_PATTERN = new Date('1970-01-01T00:00:00Z');
/** A reply with a date that breaks the pattern is rejected and one that keeps it leaves as its wire text. */
async function assertStampWireChecked(answer: (at: Date) => Promise<unknown>): Promise<void> {
  await assert.rejects(answer(BEFORE_PATTERN), isValidation);
  assert.deepEqual(await answer(new Date(AT)), { status: 200, contentType: 'application/json', headers: {}, body: { at: AT } });
}
/** The answer of the inbound handler of the SDK module when the application's port replies with a body holding `at`. */
const stampAnswer = (sdkModule: Record<string, unknown>) => (at: Date) =>
  (sdkModule.bindStampsInbound as (port: Record<string, unknown>) => Record<string, (request: unknown) => Promise<unknown>>)({
    webhookReceiveStamp: async () => ({ matched: 'status', status: 200, contentType: 'application/json', body: { at }, headers: {} }),
  }).webhookReceiveStamp!({});

test('a request body with a date-time pattern is checked in its wire form: a date that breaks the pattern is rejected', async () => {
  // protects: T-729, F-163 a node with a keyword no descriptor carries keeps the wire check of the input root
  const codec = await sdkBodyCodec((await stamps()).output, 'Stamps', 'Stamp');
  await assert.rejects(codec.encode({ at: BEFORE_PATTERN }), isValidation);
  assert.deepEqual(await codec.encode({ at: new Date(AT) }), { at: AT });
});

test('an inbound response with a date-time pattern runs the wire check of the response root after its conversion', async () => {
  // protects: T-729, F-163 an inbound response node with a keyword no descriptor carries is also checked in its wire form
  const answer = stampAnswer(await importGeneratedModule((await stamps()).output, 'generated SDK'));
  await assertStampWireChecked(answer);
});

test('a golem-mode inbound response with a date-time pattern runs the wire check of the response root after its conversion', async () => {
  // protects: T-742 both SDK modes write wireChecked, so a golem-mode inbound response is judged in its wire form like a standalone one
  const project = await loadGolemModeProject(scope, 'golem-openapi-keyword-stamps-golem-', [{ document: STAMP_DOCUMENT, folder: 'sdk/stamps', name: 'Stamps' }], true);
  const answer = stampAnswer(await import(pathToFileURL(path.join(project.root, 'build/sdk/stamps/index.js')).href) as Record<string, unknown>);
  await assertStampWireChecked(answer);
});

test('an app model over an SDK type with a keyword that no descriptor carries stops generation and names the keyword', async () => {
  // protects: T-729 OPENAPI_KEYWORD_NOT_CARRIED: the model plane is the only check of an app model, so it never skips a keyword silently
  const model = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Stamp } from '../sdk/stamps/index.js';\nexport type TStamp = IModel<Stamp>;\n";
  await assert.rejects(
    loadGolemModeProject(scope, 'golem-openapi-keyword-stamp-model-', [{ document: STAMP_DOCUMENT, folder: 'sdk/stamps', name: 'Stamps' }], true, { 'src/stamp.model.ts': model }),
    /OPENAPI_KEYWORD_NOT_CARRIED[^]*"pattern"/,
  );
});

// A free-form object field (`type: object` alone) is an object of unknown values: it keeps its members, and no node of it is marked.
const keepsMeta = (value: unknown) => JSON.stringify(value).includes('"meta":{"a":1}');
const META = { meta: { a: 1 } };

test('a request body keeps the members of a free-form object field', async () => {
  // protects: T-729 a free-form object field is carried, so its node stays complete and its members reach the wire
  const codec = await sdkBodyCodec((await sdk()).output, 'Keywords', 'FreeFormRule');
  assert.ok(keepsMeta(await codec.encode(withWhen(META, new Date(AT)))));
});

test('an inbound response keeps the members of a free-form object field', async () => {
  // protects: T-729 a free-form object field is carried on the inbound response path
  const { answer } = await inboundHandler(ROWS.find((row) => row.name === 'FreeFormRule')!);
  assert.ok(keepsMeta(await answer(META)));
});

test('an app model over an SDK type with a free-form object field keeps its members', async () => {
  // protects: T-729 an app model over a common SDK type with a free-form field does not stop with OPENAPI_KEYWORD_NOT_CARRIED
  const generated = await golemModel();
  assert.ok(keepsMeta(generated.fromWireFormatTFreeFormRule!(withWhen(META, AT))));
  assert.ok(keepsMeta(generated.toWireFormatTFreeFormRule!(withWhen(META, new Date(AT)))));
});

// A oneOf accepts a value that exactly one branch accepts. A union whose branches cannot overlap is exact as it is.
const PET = { type: 'object', required: ['kind', 'born'], properties: { born: DATE_TIME } };
const BRANCHES = {
  openapi: '3.1.0',
  info: { title: 'Branches', version: '1' },
  components: {
    schemas: {
      Cat: { ...PET, properties: { ...PET.properties, kind: { const: 'cat' } } },
      Dog: { ...PET, properties: { ...PET.properties, kind: { const: 'dog' } } },
      Pet: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }], discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } } },
      Left: { type: 'object', required: ['born'], properties: { born: text } },
      Right: { type: 'object', properties: { born: text, note: text } },
      Either: { oneOf: [{ $ref: '#/components/schemas/Left' }, { $ref: '#/components/schemas/Right' }] },
    },
  },
};

const branches = onceShared(() => loadSdk(scope, 'golem-openapi-keyword-branches-', { document: withRootOperations(BRANCHES, 'Pet', 'Either'), name: 'Branches', dates: 'date', validation: true }));

test('a oneOf of overlapping branches rejects a value that matches both, and one tagged Pet is accepted', async () => {
  // protects: T-729 a oneOf accepts a value that exactly one branch accepts; a union that a tag makes exact needs no such check
  const { output } = await branches();
  const either = await sdkBodyCodec(output, 'Branches', 'Either');
  await assert.rejects(either.decode({ born: 'today' }), isValidation);
  assert.deepEqual(await either.decode({ note: 'n' }), { note: 'n' });
  const pet = await sdkBodyCodec(output, 'Branches', 'Pet');
  assert.deepEqual(await pet.decode({ kind: 'cat', born: AT }), { kind: 'cat', born: new Date(AT) });
});
