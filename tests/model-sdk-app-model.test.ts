import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fileFixtureScope } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { isGeneratedClientClass } from './openapi/helpers.js';
import { loadGolemModeProject, writeGolemModeProject, type GolemModeSdkSetup } from './openapi/sdk-client-fixture.js';

const scope = fileFixtureScope();
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });

/** A charge SDK whose `id` holds at most five characters and whose `at` is an instant. */
function chargeDocument(closed = false): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'Charges', version: '1' },
    paths: { '/charges': { post: { operationId: 'createCharge', requestBody: { required: true, content: json(ref('Charge')) }, responses: { 200: { description: 'ok', content: json(ref('Charge')) } } } } },
    components: { schemas: { Charge: { type: 'object', ...(closed ? { additionalProperties: false } : {}), required: ['id', 'amount'], properties: { id: { type: 'string', maxLength: 5 }, amount: { type: 'number' }, at: { type: 'string', format: 'date-time' } } } } },
  };
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
