import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runPipeline } from '#golem/cli';
import { fileFixtureScope } from '../fixture-project.js';
import { loadGolemModeProject, type GolemModeSdkSetup } from './sdk-client-fixture.js';

const scope = fileFixtureScope();
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });

/** A charge SDK: the request and the response carry an instant, a day and a duration. */
function charges(operation: string, extra: Record<string, unknown> = {}): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'Charges', version: '1' },
    paths: { '/charges': { post: {
      operationId: operation,
      requestBody: { required: true, content: json({ type: 'object', required: ['at'], properties: { at: { type: 'string', format: 'date-time' } } }) },
      responses: { 200: { description: 'ok', content: json(ref('Charge')) } },
    } } },
    components: { schemas: { Charge: { type: 'object', required: ['id', 'at'], properties: { id: { type: 'string' }, at: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' }, spent: { type: 'string', format: 'duration' }, ...extra } } } },
  };
}

type ChargesClient = { createCharge(): { execute(input: { body: { at: unknown } }): Promise<{ body: Record<string, unknown> }> } };
const WIRE = { id: 'c1', at: '2025-01-02T03:04:05Z', day: '2025-01-02', spent: 'PT5M' };

test('a golem-mode call converts its request and its response, Temporal values included, in an app with no model file', async () => {
  // protects: T-699 R-82 a golem-mode SDK converts through the codecs file the models job writes; the openapi job runs first from a clean tree and the file is built
  const sdk: GolemModeSdkSetup = { document: charges('createCharge'), folder: 'sdk/charges', name: 'Charges', dates: 'temporal' };
  const project = await loadGolemModeProject(scope, 'golem-mode-e2e-', [sdk]);
  const sent: unknown[] = [];
  const client = await project.client<ChargesClient>(sdk, { fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => { sent.push(init?.body); return Response.json(WIRE); } });
  const { body } = await client.createCharge().execute({ body: { at: Temporal.Instant.from('2025-01-02T03:04:05Z') } });
  assert.deepEqual(sent, ['{"at":"2025-01-02T03:04:05Z"}']);
  assert.equal(body.at instanceof Temporal.Instant, true);
  assert.equal(body.day instanceof Temporal.PlainDate, true);
  assert.equal(body.spent instanceof Temporal.Duration, true);
  assert.deepEqual([String(body.at), String(body.day), String(body.spent)], ['2025-01-02T03:04:05Z', '2025-01-02', 'PT5M']);
  // The models job owns the file the SDK imports: it is recorded for that job.
  const outputs = fs.readFileSync(path.join(project.root, '.golem/outputs.json'), 'utf8');
  assert.match(outputs, /src\/generated\/models\/sdk\/charges\.sdk\.generated\.ts/);
});

test('a golem-mode call reads the duration text that Temporal writes: fractional seconds, hours with seconds, years with days', async () => {
  // protects: T-682 the golem-mode response check uses the Temporal.Duration wire form, not the RFC 3339 duration format
  const sdk: GolemModeSdkSetup = { document: charges('createCharge'), folder: 'sdk/durations', name: 'Charges', dates: 'temporal' };
  const project = await loadGolemModeProject(scope, 'golem-mode-duration-', [sdk]);
  const spans = ['PT0.5S', 'PT1H30S', 'P1Y2D'];
  const read = async (spent: string) => {
    const client = await project.client<ChargesClient>(sdk, { fetchImpl: async () => Response.json({ ...WIRE, spent }) });
    return String((await client.createCharge().execute({ body: { at: Temporal.Instant.from('2025-01-02T03:04:05Z') } })).body.spent);
  };
  assert.deepEqual([await read(spans[0]!), await read(spans[1]!), await read(spans[2]!)], spans);
});

test('two golem-mode SDKs with one operation name share one models job; a modelOnly rerun and check change nothing', async () => {
  // protects: T-699 root and export names carry the SDK scope; --modelOnly and golem check are clean (F-34, F-125)
  const first: GolemModeSdkSetup = { document: charges('createCharge'), folder: 'sdk/charges', name: 'Charges' };
  const second: GolemModeSdkSetup = { document: charges('createCharge', { note: { type: 'string' } }), folder: 'sdk/refunds', name: 'Refunds' };
  const project = await loadGolemModeProject(scope, 'golem-mode-two-', [first, second]);
  const models = path.join(project.root, 'src/generated/models');
  const written = ['models.validators.generated.ts', 'sdk/charges.sdk.generated.ts', 'sdk/refunds.sdk.generated.ts'].map(file => [file, fs.readFileSync(path.join(models, file), 'utf8')]);
  assert.match(written[0]![1]!, /export function validate_sdk_charges_createCharge_input\(/);
  assert.match(written[0]![1]!, /export function validate_sdk_refunds_createCharge_input\(/);
  for (const [sdk, name] of [[first, 'Charges'], [second, 'Refunds']] as const) {
    const client = await project.client<ChargesClient>(sdk, { fetchImpl: async () => Response.json(WIRE) });
    const { body } = await client.createCharge().execute({ body: { at: new Date('2025-01-02T03:04:05Z') } });
    assert.equal(body.at instanceof Date, true, `${name} converts its date`);
  }

  await runPipeline(project.config, { check: true });
  assert.deepEqual(written.map(([file]) => fs.readFileSync(path.join(models, file!), 'utf8')), written.map(([, content]) => content));
});
