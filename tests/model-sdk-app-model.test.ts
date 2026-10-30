import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fileFixtureScope } from './fixture-project.js';
import { loadGolemModeProject, type GolemModeSdkSetup } from './openapi/sdk-client-fixture.js';

const scope = fileFixtureScope();
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });

/** A charge SDK whose `id` holds at most five characters and whose `at` is an instant. */
function chargeDocument(): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'Charges', version: '1' },
    paths: { '/charges': { post: { operationId: 'createCharge', requestBody: { required: true, content: json(ref('Charge')) }, responses: { 200: { description: 'ok', content: json(ref('Charge')) } } } } },
    components: { schemas: { Charge: { type: 'object', required: ['id', 'amount'], properties: { id: { type: 'string', maxLength: 5 }, amount: { type: 'number' }, at: { type: 'string', format: 'date-time' } } } } },
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
