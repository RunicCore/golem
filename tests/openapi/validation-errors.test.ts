import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { compileGeneratedSdk, generateMaterializedSdk, isGeneratedClientClass } from './helpers.js';

test('client validation failures use library errors while network failures preserve their identity', async t => {
  const directory = createFixtureProject(t, 'golem-validation-errors-');
  const output = path.join(directory, 'sdk');
  await generateMaterializedSdk({
    openapi: '3.1.0', info: { title: 'Failures', version: '1' },
    paths: { '/value': { get: { operationId: 'getValue', responses: {
      200: { description: 'Value', content: { 'application/json': { schema: { type: 'number' } } } },
    } } } },
  }, { output, name: 'Failures', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output);
  const { FailuresClient } = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  assert.ok(isGeneratedClientClass(FailuresClient));
  const validatorFailure = new Error('Engine stopped');
  let failure: unknown = validatorFailure;
  let shouldThrow = true;
  const engine = {
    addSchema() {},
    getSchema() { return () => { if (shouldThrow) throw failure; return true; }; },
  };
  const client = new FailuresClient({
    baseUrl: 'https://api.example.test', validationEngine: engine,
    fetchImpl: async () => new Response('1', { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(() => client.getValue().execute({}), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.equal(error.cause, validatorFailure);
    return true;
  });
  failure = new LibError(LibErrorKind.Validation, 'Application validation failed');
  await assert.rejects(() => client.getValue().execute({}), error => error === failure);
  shouldThrow = false;
  const networkFailure = new TypeError('Fetch failed');
  const disconnected = new FailuresClient({
    baseUrl: 'https://api.example.test', validationEngine: engine,
    fetchImpl: async () => { throw networkFailure; },
  });
  await assert.rejects(() => disconnected.getValue().execute({}), error => error === networkFailure);
  const missingValidators = new FailuresClient({
    baseUrl: 'https://api.example.test',
    validationEngine: { addSchema() {}, getSchema() { return undefined; } },
  });
  assert.throws(() => missingValidators.getValue(),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    'first use must fail clearly when the supplied engine cannot resolve its operation schemas');
});
