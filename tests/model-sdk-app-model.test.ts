import 'temporal-polyfill/global';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fileFixtureScope } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { generateMaterializedSdk, isGeneratedClientClass } from './openapi/helpers.js';
import { chargesDocument, loadGolemModeProject, writeGolemModeProject, type GolemModeSdkSetup } from './openapi/sdk-client-fixture.js';

const scope = fileFixtureScope();
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });

/** A charge SDK whose `id` holds at most five characters and whose `at` is an instant. */
function chargeDocument(closed = false): unknown {
  return chargesDocument({ Charge: { type: 'object', ...(closed ? { additionalProperties: false } : {}), required: ['id', 'amount'], properties: { id: { type: 'string', maxLength: 5 }, amount: { type: 'number' }, at: { type: 'string', format: 'date-time' } } } });
}

const CHARGES: GolemModeSdkSetup = { document: chargeDocument(), folder: 'sdk/charges', name: 'Charges' };
const CHARGE_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from '../sdk/charges/index.js';
export type TChargeRecord = IModel<Charge>;
`;

async function importBuilt(root: string, file: string): Promise<Record<string, any>> {
  return await import(pathToFileURL(path.join(root, 'build', file)).href) as Record<string, any>;
}

test('a golem-mode model over an SDK type takes the SDK limits and writes no validator of its own for the type', async () => {
  // protects: T-700 R-84 E-52 an app model over an SDK type keeps the SDK's limits and shares the SDK's validators instead of compiling a copy
  const project = await loadGolemModeProject(scope, 'sdk-app-model-', [CHARGES], true, { 'src/charge.model.ts': CHARGE_MODEL });
  const validators = fs.readFileSync(path.join(project.root, 'src/generated/models/models.validators.generated.ts'), 'utf8');
  const checks = [...validators.matchAll(/^function f\d+_(\w+?)_[0-9a-f]{8}(?:_wire|_model_only|_wire_only)?\(/gm)].map(match => match[1]);
  assert.deepEqual(checks, ['Charge', 'Charge', 'Charge', 'Charge']);
  assert.match(validators, /^export function validate_TChargeRecord_[0-9a-f]{8}\(/m);

  const generated = await importBuilt(project.root, 'src/charge.model.generated.js');
  assert.deepEqual(generated.fromWireFormatTChargeRecord({ id: 'c1', amount: 2, at: '2025-01-02T03:04:05Z' }), { id: 'c1', amount: 2, at: new Date('2025-01-02T03:04:05Z') });
  assert.throws(() => generated.fromWireFormatTChargeRecord({ id: 'too-long', amount: 2 }), /id/);
});

test('a standalone model with plain Temporal fields parses and stringifies them', async () => {
  // protects: T-700 R-83 an app model over a plain SDK type with global Temporal fields derives (it stopped with RUNM1004) and converts them
  const { root, sourceRoot } = createModelProject(scope, { prefix: 'sdk-app-model-temporal-', name: 'temporal-fields', linkWorkspaceNodeModules: true, compilerOptions: { lib: ['ES2023', 'DOM', 'esnext.temporal'] } });
  writeModelSources(sourceRoot, {
    'charge.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
export type Charge = { id: string; at: Temporal.Instant; day?: Temporal.PlainDate; spent: Temporal.Duration | null };
export type TChargeRecord = IModel<Charge>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const generated = await importBuilt(root, 'charge.model.generated.js');
  const wire = { id: 'c1', at: '2025-01-02T03:04:05Z', day: '2025-01-02', spent: 'PT5M' };
  const charge = generated.parseTChargeRecord(JSON.stringify(wire));
  assert.deepEqual([charge.at instanceof Temporal.Instant, charge.day instanceof Temporal.PlainDate, charge.spent instanceof Temporal.Duration], [true, true, true]);
  assert.deepEqual(JSON.parse(generated.stringifyTChargeRecord(charge)), wire);
  assert.throws(() => generated.parseTChargeRecord(JSON.stringify({ ...wire, at: 'yesterday' })), /Temporal\.Instant|at/);
});

const CLASS_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from '../sdk/charges/index.js';
import { TChargeRecordBaseModel } from './charge.model.generated.js';
export type TChargeRecord = IModel<Charge>;
export class ChargeRecord extends TChargeRecordBaseModel {}
export class TrackedCharge extends TChargeRecordBaseModel {
  constructor(values: ConstructorParameters<typeof TChargeRecordBaseModel>[0], readonly note: string) { super(values); }
}
`;
const CLASS_USE = `import { fromWireFormat } from '@exprtlabs/golem/serde';
import { ChargeRecord, TrackedCharge } from './charge.model.js';
export const made = new ChargeRecord({ id: 'c2', amount: 3 });
export const tracked = new TrackedCharge({ id: 'c3', amount: 4 }, 'late');
export const read = fromWireFormat<ChargeRecord>({ id: 'c1', amount: 2, at: '2025-01-02T03:04:05Z' });
`;

/** A golem-mode project built with `golem build` (which rewrites `fromWireFormat<T>` and `parse<T>`), with the model files in `files`. */
async function buildGolemModeProject(prefix: string, sdk: GolemModeSdkSetup, files: Readonly<Record<string, string>>) {
  const project = writeGolemModeProject(scope, prefix, [sdk], true);
  writeModelSources(project.root, files);
  await buildModelProject(project.root);
  return project;
}

test('a golem-mode model over an SDK type has its own class, a constructor with values first, and fromWireFormat of the class', async () => {
  // protects: T-700 R-84 new ChargeRecord(body), a custom constructor and fromWireFormat<ChargeRecord> work on a model over an SDK type
  const sdk: GolemModeSdkSetup = { document: chargeDocument(true), folder: 'sdk/charges', name: 'Charges' };
  const project = await buildGolemModeProject('sdk-app-model-class-', sdk, { 'src/charge.model.ts': CLASS_MODEL, 'src/use.ts': CLASS_USE });
  const { ChargeRecord, TrackedCharge } = await importBuilt(project.root, 'src/charge.model.js');
  const { made, tracked, read } = await importBuilt(project.root, 'src/use.js');
  assert.deepEqual([made instanceof ChargeRecord, made.id, made.amount], [true, 'c2', 3]);
  assert.deepEqual([tracked instanceof TrackedCharge, tracked.id, tracked.note], [true, 'c3', 'late']);
  assert.equal(read instanceof ChargeRecord, true);
  assert.deepEqual([read.id, read.at], ['c1', new Date('2025-01-02T03:04:05Z')]);

  // The instance goes out as a body of a closed schema: its own state is not a property, so the SDK sends the declared fields only.
  const sent: unknown[] = [];
  const Client = (await importBuilt(project.root, 'sdk/charges/index.js')).ChargesClient;
  assert.ok(isGeneratedClientClass(Client), 'generated client');
  const client = new Client({ baseUrl: 'https://api.test', fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => { sent.push(init?.body); return Response.json({ id: 'c3', amount: 4 }); } }) as any;
  await client.createCharge().execute({ body: tracked });
  assert.deepEqual(sent, ['{"id":"c3","amount":4}']);
});

test('a golem-mode model over an SDK type chooses its own level, never above the project level', async () => {
  // protects: T-700 R-75 R-76 R-77 the level of a model over an SDK type is its own: it may lower the project's, and raising it stops generation
  const lowered = await loadGolemModeProject(scope, 'sdk-app-model-level-', [CHARGES], true, { 'src/charge.model.ts': `${CHARGE_MODEL}export type TLooseCharge = IModel<Charge, { validation: false }>;\n` });
  const generated = await importBuilt(lowered.root, 'src/charge.model.generated.js');
  assert.throws(() => generated.fromWireFormatTChargeRecord({ id: 'too-long', amount: 1 }), /id/);
  assert.deepEqual(generated.fromWireFormatTLooseCharge({ id: 'too-long', amount: 1 }), { id: 'too-long', amount: 1 });

  const raised = writeGolemModeProject(scope, 'sdk-app-model-level-above-', [CHARGES], 'sanity');
  writeModelSources(raised.root, { 'src/charge.model.ts': CHARGE_MODEL.replace('IModel<Charge>', 'IModel<Charge, { validation: true }>') });
  await assert.rejects(buildModelProject(raised.root), /RUNM1089: TChargeRecord sets validation true, which is above the project level 'sanity'\./);
});

const MONEY: GolemModeSdkSetup = {
  document: {
    openapi: '3.1.0',
    info: { title: 'Payments', version: '1' },
    paths: { '/payments': { post: { operationId: 'createPayment', requestBody: { required: true, content: json(ref('Money')) }, responses: { 201: { description: 'ok', content: json(ref('Money')) } } } } },
    components: { schemas: { Money: { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: { amount: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } } } } },
  },
  folder: 'sdk/payments',
  name: 'Payments',
};
const MONEY_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from '../sdk/payments/index.js';
import { TMoneyBaseModel } from './money.model.generated.js';
export type TMoney = IModel<Money>;
export type TBasket = IModel<{ price: Money; label: string }>;
export class MoneyRecord extends TMoneyBaseModel {}
`;
const MONEY_USE = `import { parse } from '@exprtlabs/golem/serde';
import type { TBasket } from './money.model.js';
import { MoneyRecord } from './money.model.js';
export const readMoney = (text: string) => parse<MoneyRecord>(text);
export const readBasket = (text: string) => parse<TBasket>(text);
`;

test('parse<T> reads an app model over an SDK model of golem mode, with the limits of the SDK', async () => {
  // protects: T-683 T-700 parse<MoneyRecord> works on a model over an SDK model (it failed with "codec not registered"), and a model that holds Money parses
  const project = await buildGolemModeProject('sdk-app-model-parse-', MONEY, { 'src/money.model.ts': MONEY_MODEL, 'src/use.ts': MONEY_USE });
  const { MoneyRecord } = await importBuilt(project.root, 'src/money.model.js');
  const { readMoney, readBasket } = await importBuilt(project.root, 'src/use.js');
  const money = readMoney('{"amount":5,"currency":"EUR"}');
  assert.deepEqual([money instanceof MoneyRecord, money.amount, money.currency], [true, 5, 'EUR']);
  assert.throws(() => readMoney('{"amount":-1,"currency":"EUR"}'), /Model validation failed/);
  assert.throws(() => readMoney('{"amount":5,"currency":"euro"}'), /Model validation failed/);
  assert.deepEqual(readBasket('{"price":{"amount":1,"currency":"USD"},"label":"x"}'), { price: { amount: 1, currency: 'USD' }, label: 'x' });
  // An SDK type as a field keeps the SDK limits too, and is checked by the SDK's validator of it.
  assert.throws(() => readBasket('{"price":{"amount":-1,"currency":"USD"},"label":"x"}'), /Model validation failed/);
  const validators = fs.readFileSync(path.join(project.root, 'src/generated/models/models.validators.generated.ts'), 'utf8');
  const holdingMinimum = validators.split(/^function /m).filter(body => /^f\d+_\w+_[0-9a-f]{8}\(/.test(body) && body.includes('< 0)')).map(body => body.replace(/^f\d+_(\w+?)_[0-9a-f]{8}\([^]*$/, '$1'));
  assert.deepEqual(holdingMinimum, ['Money']);
  // The model that holds Money converts it with the codec of the SDK's codecs file.
  const companion = fs.readFileSync(path.join(project.root, 'src/money.model.generated.ts'), 'utf8');
  assert.match(companion, /import \{[^}]*\bfromWireFormatMoney\b[^}]*\} from "\.\/generated\/models\/sdk\/payments\.sdk\.generated\.js"/);
});

test('a standalone model over an SDK type with Temporal dates derives from the plain type and converts the dates', async () => {
  // protects: T-700 R-83 an app model over a standalone SDK type with global Temporal fields derives (it stopped with RUNM1004)
  const { root, sourceRoot } = createModelProject(scope, { prefix: 'sdk-app-model-standalone-', name: 'standalone-sdk-model', linkWorkspaceNodeModules: true, compilerOptions: { lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] } });
  await generateMaterializedSdk(chargeDocument(), { output: path.join(sourceRoot, 'sdk'), name: 'Charges', dates: 'temporal', profile: { mobx: false, validation: true, allowAny: false } });
  writeModelSources(sourceRoot, {
    'charge.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from './sdk/index.js';
import { TChargeRecordBaseModel } from './charge.model.generated.js';
export type TChargeRecord = IModel<Charge>;
export class ChargeRecord extends TChargeRecordBaseModel {}
`,
    'use.ts': `import { parse, stringify } from '@exprtlabs/golem/serde';
import { ChargeRecord } from './charge.model.js';
export const read = (text: string) => parse<ChargeRecord>(text);
export const write = (value: ChargeRecord) => stringify<ChargeRecord>(value);
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const { ChargeRecord } = await importBuilt(root, 'charge.model.js');
  const { read, write } = await importBuilt(root, 'use.js');
  const charge = read('{"id":"c1","amount":2,"at":"2025-01-02T03:04:05Z"}');
  assert.deepEqual([charge instanceof ChargeRecord, charge.at instanceof Temporal.Instant], [true, true]);
  assert.equal(write(charge), '{"id":"c1","amount":2,"at":"2025-01-02T03:04:05Z"}');
});

/** A charge SDK whose Charge holds a Money: a node with a date, and a node that holds it. */
const NESTED: GolemModeSdkSetup = {
  folder: 'sdk/charges',
  name: 'Charges',
  document: chargesDocument({
    Money: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number', minimum: 0 }, at: { type: 'string', format: 'date-time' } } },
    Charge: { type: 'object', required: ['id', 'price'], properties: { id: { type: 'string', maxLength: 5 }, price: ref('Money') } },
  }),
};

test('a golem-mode model over an SDK type that holds another SDK type checks the nested type with the SDK validator', async () => {
  // protects: T-700 E-52 R-84 an SDK type reached inside an SDK type keeps its limits through the app model, and no second validator of it is written
  const project = await loadGolemModeProject(scope, 'sdk-app-model-nested-', [NESTED], true, { 'src/charge.model.ts': CHARGE_MODEL });
  const validators = fs.readFileSync(path.join(project.root, 'src/generated/models/models.validators.generated.ts'), 'utf8');
  const checks = [...validators.matchAll(/^function f\d+_(\w+?)_[0-9a-f]{8}(?:_wire|_model_only|_wire_only)?\(/gm)].map(match => match[1]);
  assert.deepEqual(checks, ['Charge', 'Charge', 'Charge', 'Charge', 'Money', 'Money', 'Money', 'Money']);

  const generated = await importBuilt(project.root, 'src/charge.model.generated.js');
  const charge = generated.fromWireFormatTChargeRecord({ id: 'c1', price: { value: 2, at: '2025-01-02T03:04:05Z' } });
  assert.deepEqual(charge.price, { value: 2, at: new Date('2025-01-02T03:04:05Z') });
  assert.throws(() => generated.fromWireFormatTChargeRecord({ id: 'c1', price: { value: -1 } }), /Model validation failed/);
  assert.throws(() => generated.toWireFormatTChargeRecord({ id: 'c1', price: { value: -1 } }), /Model validation failed/);
});

test('a golem-mode model over an SDK type that reaches itself keeps the SDK limits and conversions at every depth', async () => {
  // protects: T-715 R-82 R-84 an app model over a recursive SDK type checks and converts the nested nodes (it fell back to the TS fields with no message)
  const tree: GolemModeSdkSetup = {
    folder: 'sdk/trees',
    name: 'Trees',
    document: {
      openapi: '3.1.0',
      info: { title: 'Trees', version: '1' },
      paths: { '/nodes': { post: { operationId: 'createNode', requestBody: { required: true, content: json(ref('Node')) }, responses: { 200: { description: 'ok', content: json(ref('Node')) } } } } },
      components: { schemas: {
        Node: { type: 'object', required: ['value'], properties: { value: { type: 'string', maxLength: 3 }, at: { type: 'string', format: 'date-time' }, children: { type: 'array', items: ref('Node') } } },
      } },
    },
  };
  const model = `import type { IModel } from '@exprtlabs/golem/model';
import type { Node } from '../sdk/trees/index.js';
export type TNodeRecord = IModel<Node>;
`;
  const project = await loadGolemModeProject(scope, 'sdk-app-model-recursive-', [tree], true, { 'src/node.model.ts': model });
  const validators = fs.readFileSync(path.join(project.root, 'src/generated/models/models.validators.generated.ts'), 'utf8');
  const checks = [...validators.matchAll(/^function f\d+_(\w+?)_[0-9a-f]{8}(?:_wire|_model_only|_wire_only)?\(/gm)].map(match => match[1]);
  assert.deepEqual(checks, ['Node', 'Node', 'Node', 'Node']);

  const generated = await importBuilt(project.root, 'src/node.model.generated.js');
  const wire = { value: 'a', children: [{ value: 'b', children: [{ value: 'c', at: '2025-01-02T03:04:05.000Z' }] }] };
  const read = generated.fromWireFormatTNodeRecord(wire);
  assert.deepEqual(read.children[0].children[0].at, new Date('2025-01-02T03:04:05Z'));
  assert.deepEqual(generated.toWireFormatTNodeRecord(read), wire);
  const tooLong = { value: 'a', children: [{ value: 'b', children: [{ value: 'toolong' }] }] };
  assert.throws(() => generated.fromWireFormatTNodeRecord(tooLong), /Model validation failed/);
  assert.throws(() => generated.toWireFormatTNodeRecord(tooLong), /Model validation failed/);
});

test('a golem-mode model over a scalar SDK alias takes the SDK limit, and a tag beside the alias adds its own limit', async () => {
  // protects: T-721 F-804 an app model field of a scalar SDK alias keeps the limit of the SDK, each limit checked once; T-730 F-232 also inside a union with null
  const sdk: GolemModeSdkSetup = {
    folder: 'sdk/charges',
    name: 'Charges',
    document: chargesDocument({
        Currency: { type: 'string', maxLength: 3 },
        Code: { type: ['string', 'null'], maxLength: 3 },
        Legacy: { type: 'string', nullable: true, maxLength: 3 },
        Status: { type: 'string', enum: ['open', 'shut'] },
        Email: { type: 'string', format: 'email' },
        Charge: { type: 'object', required: ['id', 'currency'], properties: { id: { type: 'string' }, currency: ref('Currency'), code: ref('Code'), legacy: ref('Legacy'), status: ref('Status'), email: ref('Email') } },
    }),
  };
  const model = `import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { Code, Currency, Email, Legacy, Status } from '../sdk/charges/index.js';
export type TRecord = IModel<{ plain: Currency; tagged: Currency & MinLength<2>; code: Code; legacy: Legacy; status: Status; email: Email; maybe: Currency | null }>;
`;
  const project = await loadGolemModeProject(scope, 'sdk-app-model-scalar-', [sdk], true, { 'src/record.model.ts': model });
  const generated = await importBuilt(project.root, 'src/record.model.generated.js');
  const valid = { plain: 'AB', tagged: 'AB', code: null, legacy: 'AB', status: 'shut', email: 'a@b.co', maybe: null };
  assert.deepEqual(generated.fromWireFormatTRecord(valid), valid);
  assert.deepEqual(generated.fromWireFormatTRecord({ ...valid, code: 'ABC' }).code, 'ABC');
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, plain: 'ABCDE' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, tagged: 'A' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, tagged: 'ABCDE' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, code: 'ABCDE' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, legacy: 'ABCDE' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, status: 'gone' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, email: 'nope' }), /Model validation failed/);
  assert.equal(generated.fromWireFormatTRecord({ ...valid, maybe: 'EUR' }).maybe, 'EUR');
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, maybe: 'EURO' }), /Model validation failed/);
  const validators = fs.readFileSync(path.join(project.root, 'src/generated/models/models.validators.generated.ts'), 'utf8');
  const check = validators.match(/^function f\d+_TRecord_[0-9a-f]{8}\(.*?^\}$/ms)?.[0] ?? '';
  assert.equal([...check.matchAll(/limit: 3, inclusive: true/g)].length, 3, 'the SDK limit is written once for each of the three plain string fields; the nullable one keeps it in its union member');
  assert.equal([...check.matchAll(/limit: 2, inclusive: true/g)].length, 1, 'the limit of the tag is written once');
});

test('a golem-mode model over an array, union or map SDK alias takes the SDK limits of the alias', async () => {
  // protects: T-739 F-804 an app model field of a non-scalar SDK alias keeps the SDK's item, branch and value limits
  const sdk: GolemModeSdkSetup = {
    folder: 'sdk/charges',
    name: 'Charges',
    document: chargesDocument({
      Tags: { type: 'array', items: { type: 'integer', maximum: 9 } },
      Ident: { oneOf: [{ type: 'string', maxLength: 3 }, { type: 'integer', minimum: 0 }] },
      Extra: { type: 'object', additionalProperties: { type: 'integer', maximum: 9 } },
      Charge: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, tags: ref('Tags'), ident: ref('Ident'), extra: ref('Extra') } },
    }),
  };
  const model = `import type { IModel } from '@exprtlabs/golem/model';
import type { Extra, Ident, Tags } from '../sdk/charges/index.js';
export type TRecord = IModel<{ tags: Tags; ident: Ident; extra: Extra }>;
`;
  const project = await loadGolemModeProject(scope, 'sdk-app-model-alias-', [sdk], true, { 'src/record.model.ts': model });
  const generated = await importBuilt(project.root, 'src/record.model.generated.js');
  const valid = { tags: [1, 9], ident: 'ABC', extra: { a: 9 } };
  assert.deepEqual(generated.fromWireFormatTRecord(valid), valid);
  assert.deepEqual(generated.fromWireFormatTRecord({ ...valid, ident: 7 }).ident, 7);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, tags: [1.5] }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, tags: [10] }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, ident: 'ABCDE' }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, ident: -1 }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, extra: { a: 10 } }), /Model validation failed/);
  assert.throws(() => generated.fromWireFormatTRecord({ ...valid, extra: { a: 1.5 } }), /Model validation failed/);
});

test('an app model over an SDK alias with a keyword that no descriptor carries stops generation and names the keyword', async () => {
  // protects: T-739 OPENAPI_KEYWORD_NOT_CARRIED also holds for an alias that is no model: the model plane is the only check of an app model
  const sdk: GolemModeSdkSetup = {
    folder: 'sdk/charges',
    name: 'Charges',
    document: chargesDocument({
      Pair: { type: 'array', items: { type: 'string' }, additionalItems: false },
      Charge: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, pair: { $ref: '#/components/schemas/Pair' } } },
    }),
  };
  const model = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Pair } from '../sdk/charges/index.js';\nexport type TRecord = IModel<{ pair: Pair }>;\n";
  await assert.rejects(loadGolemModeProject(scope, 'sdk-app-model-alias-uncarried-', [sdk], true, { 'src/record.model.ts': model }), /OPENAPI_KEYWORD_NOT_CARRIED[^]*"additionalItems"/);
});

test('a $ref sibling that the named schema already implies lets an app model generate, and a tighter bound beside it still stops generation', async () => {
  // protects: T-745 OPENAPI_KEYWORD_NOT_CARRIED marks only a $ref sibling that adds a limit: the same type or an equal or looser bound is already in the named schema
  const model = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Charge } from '../sdk/charges/index.js';\nexport type TRecord = IModel<Charge>;\n";
  const implied: GolemModeSdkSetup = {
    folder: 'sdk/charges',
    name: 'Charges',
    document: chargesDocument({
      Money: { type: 'object', required: ['value'], properties: { value: { type: 'number', maximum: 10 } } },
      Charge: { type: 'object', required: ['price'], properties: { price: { $ref: '#/components/schemas/Money', type: 'object' } } },
    }),
  };
  const project = await loadGolemModeProject(scope, 'sdk-app-model-ref-sibling-', [implied], true, { 'src/record.model.ts': model });
  const generated = await importBuilt(project.root, 'src/record.model.generated.js');
  assert.deepEqual(generated.fromWireFormatTRecord({ price: { value: 3 } }), { price: { value: 3 } });
  assert.throws(() => generated.fromWireFormatTRecord({ price: { value: 11 } }), /Model validation failed/);

  const narrowing: GolemModeSdkSetup = {
    ...implied,
    document: chargesDocument({
      Amount: { type: 'number', maximum: 10 },
      Charge: { type: 'object', required: ['price'], properties: { price: { $ref: '#/components/schemas/Amount', maximum: 5 } } },
    }),
  };
  await assert.rejects(loadGolemModeProject(scope, 'sdk-app-model-ref-narrow-', [narrowing], true, { 'src/record.model.ts': model }), /OPENAPI_KEYWORD_NOT_CARRIED[^]*"maximum"/);

  const looser: GolemModeSdkSetup = {
    ...implied,
    document: chargesDocument({
      Amount: { type: 'number', maximum: 10 },
      Charge: { type: 'object', required: ['price'], properties: { price: { $ref: '#/components/schemas/Amount', maximum: 20 } } },
    }),
  };
  const loose = await importBuilt((await loadGolemModeProject(scope, 'sdk-app-model-ref-loose-', [looser], true, { 'src/record.model.ts': model })).root, 'src/record.model.generated.js');
  assert.deepEqual(loose.fromWireFormatTRecord({ price: 3 }), { price: 3 });
  assert.throws(() => loose.fromWireFormatTRecord({ price: 11 }), (error: unknown) => error instanceof LibError
    && error.kind === LibErrorKind.Validation && error.causedByInput === true && error.message === 'Model validation failed.'
    && JSON.stringify(error.issues.map(issue => [issue.code, issue.path])) === '[["tooBig",["price"]]]');
});

test('a golem-mode model over an SDK discriminated union decodes each tag to its branch and rejects an unknown tag', async () => {
  // protects: T-740 R-84 a union of SDK nodes dispatches by its tag (the plain branch tested instanceof Object, so the first branch took every value), and a nullable SDK node init keeps its value
  const pets: GolemModeSdkSetup = {
    folder: 'sdk/pets',
    name: 'Pets',
    document: {
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1' },
      paths: { '/owners': { post: { operationId: 'createOwner', requestBody: { required: true, content: json(ref('Owner')) }, responses: { 200: { description: 'ok', content: json(ref('Owner')) } } } } },
      components: { schemas: {
        Cat: { type: 'object', required: ['petType', 'lives'], properties: { petType: { type: 'string', const: 'cat' }, lives: { type: 'integer', maximum: 9 } } },
        Dog: { type: 'object', required: ['petType'], properties: { petType: { type: 'string', const: 'dog' }, bornAt: { type: 'string', format: 'date-time' } } },
        Owner: { type: 'object', required: ['pet'], properties: { pet: { oneOf: [ref('Cat'), ref('Dog')], discriminator: { propertyName: 'petType', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } } } } },
      } },
    },
  };
  const model = `import type { IModel } from '@exprtlabs/golem/model';
import type { Dog, Owner } from '../sdk/pets/index.js';
import { TOwnerRecordBaseModel } from './owner.model.generated.js';
export type TOwnerRecord = IModel<Owner>;
export type TKennel = IModel<{ dog: Dog | null }>;
export class OwnerRecord extends TOwnerRecordBaseModel {}
`;
  const use = `import { fromWireFormat } from '@exprtlabs/golem/serde';
import { OwnerRecord } from './owner.model.js';
export const read = (wire: unknown) => fromWireFormat<OwnerRecord>(wire);
`;
  const project = await buildGolemModeProject('sdk-app-model-union-', pets, { 'src/owner.model.ts': model, 'src/use.ts': use });
  const { read } = await importBuilt(project.root, 'src/use.js');
  const dog = read({ pet: { petType: 'dog', bornAt: '2025-01-02T03:04:05Z' } });
  assert.deepEqual(dog.pet, { petType: 'dog', bornAt: new Date('2025-01-02T03:04:05Z') });
  assert.deepEqual(read({ pet: { petType: 'cat', lives: 9 } }).pet, { petType: 'cat', lives: 9 });
  assert.throws(() => read({ pet: { petType: 'bird' } }), (error: unknown) => error instanceof LibError
    && error.kind === LibErrorKind.Validation && error.causedByInput === true && error.message === 'Model validation failed.'
    && JSON.stringify(error.issues.map(issue => [issue.code, issue.path])) === '[["literal",["pet","petType"]]]');
  // A nullable SDK node keeps the value it is given: the same object, and null stays null.
  const { TKennelBaseModel } = await importBuilt(project.root, 'src/owner.model.generated.js');
  const given = { petType: 'dog', bornAt: new Date('2025-01-02T03:04:05Z') };
  assert.equal((Reflect.construct(TKennelBaseModel, [{ dog: given }]) as { dog: unknown }).dog, given);
  assert.equal((Reflect.construct(TKennelBaseModel, [{ dog: null }]) as { dog: unknown }).dog, null);
});

test('a companion over SDK types imports the SDK types, compiles under noUnusedLocals, and takes the SDK value as its init', async () => {
  // protects: T-744 R-84 a model over or holding an SDK type names the SDK's own type (no structural copy, no unused alias), so the SDK's value is the model's init
  const model = `import type { IModel } from '@exprtlabs/golem/model';
import type { Charge, Money } from '../sdk/charges/index.js';
export type TChargeRecord = IModel<Charge>;
export type TBasket = IModel<{ price: Money; label: string }>;
`;
  const assign = `import type { Charge, Money } from '../sdk/charges/index.js';
import type { TBasketInit, TChargeRecordInit } from './charge.model.generated.js';
declare const charge: Charge;
declare const money: Money;
export const chargeInit: TChargeRecordInit = charge;
export const basketInit: TBasketInit = { price: money, label: 'x' };
`;
  const project = writeGolemModeProject(scope, 'sdk-app-model-types-', [NESTED], true);
  writeModelSources(project.root, { 'src/charge.model.ts': model, 'src/assign.ts': assign });
  await buildModelProject(project.root, ['--noUnusedLocals']);
});

test('the JSON type of an app model over an SDK type with a date is the wire form, not the SDK type', async () => {
  // protects: T-748 T-750 an SDK node whose wire form differs from its plain form (a date) gets a JSON type of its own
  const model = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Charge } from '../sdk/charges/index.js';\nexport type TRecord = IModel<Charge>;\n";
  const use = "import type { TRecordJSON } from './record.model.generated.js';\nexport const wire: TRecordJSON = { id: 'c1', amount: 2, at: '2025-01-02T03:04:05Z' };\n// @ts-expect-error the wire form of a date is its text, not a Date\nexport const plain: TRecordJSON = { id: 'c1', amount: 2, at: new Date() };\n";
  // The build is the check: it fails when the JSON type is the SDK type, which takes a Date.
  await buildGolemModeProject('sdk-app-model-json-', CHARGES, { 'src/record.model.ts': model, 'src/use.ts': use });
});
