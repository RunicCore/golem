import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { LibError } from '@exprtlabs/golem/errors';
import {
  compileStrictUnusedSdk,
  generateMaterializedSdk,
  loadGeneratedClient,
  recordingFetch,
} from './helpers.js';

const USER_ID = 'https://schemas.example.test/user';
const ENVELOPE_ID = 'https://schemas.example.test/envelope';
const SCOPE_BASE = 'https://schemas.example.test/scope/';
const SCOPE_USER_ID = 'https://schemas.example.test/scope/user';
const EMBEDDED_ID = 'urn:fixture:embedded';

function resourceTypesDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'ResourceTypes', version: '1' },
    paths: {
      '/envelope': {
        post: {
          operationId: 'putEnvelope',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: ENVELOPE_ID } },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: ENVELOPE_ID } },
              },
            },
          },
        },
      },
      '/embedded': {
        get: {
          operationId: 'getEmbedded',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: EMBEDDED_ID } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          $id: USER_ID,
          type: 'object',
          additionalProperties: false,
          required: ['id', 'secret', 'serverValue'],
          properties: {
            id: { type: 'string' },
            secret: { type: 'string', writeOnly: true },
            serverValue: { type: 'string', readOnly: true },
          },
        },
        Envelope: {
          $id: ENVELOPE_ID,
          type: 'object',
          additionalProperties: false,
          required: ['user', 'relative'],
          properties: {
            user: { $ref: USER_ID },
            relative: { $ref: 'user' },
            scoped: {
              $id: SCOPE_BASE,
              type: 'object',
              properties: {
                inner: { $ref: 'user' },
              },
            },
          },
        },
        ScopeUser: {
          $id: SCOPE_USER_ID,
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        Embedded: {
          $id: EMBEDDED_ID,
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
  };
}

test('public generate types URI $id refs, directional imports, nested models, and validation', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-resource-types-'), 'sdk');
  const result = await generateMaterializedSdk(resourceTypesDocument(), {
    output,
    name: 'ResourceTypes',
    profile: { validation: true },
  });
  copyFixtureFile(output, "openapi/resource-types/resource-types-assert.ts", "resource-types-assert.ts");
  compileStrictUnusedSdk(output, [path.join(output, 'resource-types-assert.ts')]);

  const Client = await loadGeneratedClient(output, 'ResourceTypes');
  const request = {
    user: { id: 'u1', secret: 's' },
    relative: { id: 'u1', secret: 's' },
    scoped: { inner: { id: 'scoped' } },
  };
  const reply = {
    user: { id: 'u1', serverValue: 'ok' },
    relative: { id: 'u1', serverValue: 'ok' },
    scoped: { inner: { id: 'scoped' } },
  };
  const send = async (body: unknown, answer: unknown): Promise<{ sent: unknown; received: unknown }> => {
    const { fetchImpl, sent } = recordingFetch(() => Response.json(answer));
    const client = new Client({ baseUrl: 'https://api.test', fetchImpl });
    const received = (await client.putEnvelope!().execute({ body })).body;
    return { sent: sent[0], received };
  };

  assert.deepEqual(await send(request, reply), { sent: request, received: reply });
  await assert.rejects(
    () => send({ ...request, user: { id: 'u1' } }, reply),
    (error: unknown) => error instanceof LibError,
  );
  await assert.rejects(
    () => send(request, { ...reply, relative: { id: 'u1' } }),
    (error: unknown) => error instanceof LibError,
  );
});
