import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import { generateMaterializedSdk } from './helpers.js';

const CHARGE = { type: 'object', additionalProperties: false, required: ['when'], properties: { when: { type: 'string', format: 'date-time' } } };
const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Charges', version: '1' },
  paths: { '/charges': { post: { operationId: 'createCharge', requestBody: { required: true, content: { 'application/json': { schema: CHARGE } } }, responses: { 204: { description: 'Done' } } } } },
  components: { schemas: { Unreached: { type: 'object', properties: { code: { type: 'string', format: 'not-a-known-format' } } } } },
};

test('the SDK validators hold the roots an operation reaches, and a schema no operation reaches is still checked', async t => {
  // protects: F-129, T-690 a standalone SDK carries no validator for a model nothing reads; diagnostics still run on every component
  const output = path.join(createFixtureProject(t, 'golem-sdk-reached-roots-'), 'sdk');
  const result = await generateMaterializedSdk(DOCUMENT, { output, name: 'Charges', profile: { mobx: false, validation: true, allowAny: false, unknownFormats: 'warn' } });
  const validators = result.artifacts.find(artifact => path.basename(artifact.path) === 'validators.generated.ts')?.content ?? '';
  assert.match(validators, /export function validate_createCharge_input\(/);
  assert.doesNotMatch(validators, /Unreached/);
  assert.match((result.diagnostics ?? []).map(diagnostic => diagnostic.message).join('\n'), /not-a-known-format/);
});
