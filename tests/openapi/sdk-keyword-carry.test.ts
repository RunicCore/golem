import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { createFixtureProject, fileFixtureScope, onceShared } from '../fixture-project.js';
import { generateMaterializedSdk, importGeneratedModule, sdkBodyCodec, withRootOperations } from './helpers.js';
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

test('a keyword that limits the text of a date-time string stops generation and names the keyword', async () => {
  // protects: T-729 a keyword that no descriptor can carry stops generation with OPENAPI_KEYWORD_NOT_CARRIED, never a silent drop
  const document = withRootOperations({
    openapi: '3.1.0',
    info: { title: 'Stamps', version: '1' },
    components: { schemas: { Stamp: body({}, { at: { type: 'string', format: 'date-time', pattern: '^2025' } }) } },
  }, 'Stamp');
  const output = path.join(createFixtureProject(scope, 'golem-openapi-keyword-uncarried-'), 'sdk');
  await assert.rejects(generateMaterializedSdk(document, { output, name: 'Stamps' }), /OPENAPI_KEYWORD_NOT_CARRIED[^]*"pattern"/);
});
