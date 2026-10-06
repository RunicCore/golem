import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
} from './helpers.js';

test('operation schema closures preserve resource references and schema-looking JSON values', async t => {
  const directory = createFixtureProject(t, 'golem-operation-schema-contracts-');
  const literal = {
    $ref: '#/components/schemas/Unrelated',
    properties: { example: { $ref: 'https://data.example.test/not-a-schema' } },
  };
  const document = {
    openapi: '3.1.0',
    info: { title: 'Resource scoped operation', version: '1' },
    components: { schemas: {
      Envelope: {
        type: 'object',
        required: ['value', 'metadata', 'choice'],
        additionalProperties: false,
        properties: {
          value: { $ref: 'https://schemas.example.test/value' },
          metadata: { const: literal, default: literal, examples: [literal] },
          choice: { enum: [literal] },
        },
      },
      Value: { $id: 'https://schemas.example.test/value', type: 'string', minLength: 2 },
      Unrelated: { type: 'integer' },
    } },
    paths: { '/echo': { post: {
      operationId: 'echo',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
      },
      responses: { 200: {
        description: 'Echo',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
      } },
    } } },
  };

  const output = path.join(directory, 'sdk');
  await generateMaterializedSdk(document, {
    output,
    name: 'Scoped',
    profile: { mobx: false, validation: true },
  });
  compileGeneratedSdk(output, [], {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });
  const module = requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), 'scoped client');
  assert.ok(isGeneratedClientClass(module.ScopedClient));
  let requests = 0;
  const client = new module.ScopedClient({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      return new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });
    },
  });
  const body = { value: 'valid', metadata: literal, choice: literal };
  assert.deepEqual((await client.echo().execute({ body })).body, body);
  assert.equal(requests, 1);
  await assert.rejects(client.echo().execute({ body: { ...body, value: 'x' } }));
  await assert.rejects(client.echo().execute({ body: { ...body, metadata: { $ref: 'changed' } } }));
  await assert.rejects(client.echo().execute({ body: { ...body, choice: { $ref: 'changed' } } }));
  assert.equal(requests, 1, 'invalid resource or literal contracts fail before transport');
});
