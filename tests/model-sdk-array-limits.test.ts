import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { fileFixtureScope } from './fixture-project.js';
import { chargesDocument, loadGolemModeProject, type GolemModeSdkSetup } from './openapi/sdk-client-fixture.js';

const scope = fileFixtureScope();
const CHARGES: GolemModeSdkSetup = {
  folder: 'sdk/charges',
  name: 'Charges',
  document: chargesDocument({ Charge: { type: 'object', required: ['id', 'tags'], properties: { id: { type: 'string' }, tags: { type: 'array', minItems: 1, items: { type: 'string' } } } } }),
};
const CHARGE_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from '../sdk/charges/index.js';
export type TChargeRecord = IModel<Charge>;
`;

test('an app model over an SDK type keeps the minItems of an array field when it reads and writes', async () => {
  // protects: T-719 an array limit of the OpenAPI schema reaches the model plane of an SDK type
  const project = await loadGolemModeProject(scope, 'sdk-array-limit-', [CHARGES], true, { 'src/charge.model.ts': CHARGE_MODEL });
  const generated = await import(pathToFileURL(path.join(project.root, 'build', 'src/charge.model.generated.js')).href) as Record<string, any>;
  assert.deepEqual(generated.fromWireFormatTChargeRecord({ id: 'c1', tags: ['a'] }), { id: 'c1', tags: ['a'] });
  const isValidation = (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation;
  assert.throws(() => generated.fromWireFormatTChargeRecord({ id: 'c1', tags: [] }), isValidation);
  assert.throws(() => generated.toWireFormatTChargeRecord({ id: 'c1', tags: [] }), isValidation);
});
