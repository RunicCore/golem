import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { getValidator } from '@exprtlabs/golem/validation';
import {
  compileStrictUnusedSdk,
  generateMaterializedSdk,
  isGeneratedModelClass,
  requireRecord,
} from './helpers.js';
import { modelCodec } from '../support/model-codec.js';

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
    profile: { mobx: false, validation: true },
  });
  copyFixtureFile(output, "openapi/resource-types/resource-types-assert.ts", "resource-types-assert.ts");
  compileStrictUnusedSdk(output, [path.join(output, 'resource-types-assert.ts')]);

  const generated = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'resource type models',
  );
  const EnvelopeModel = generated.EnvelopeModel;
  const UserModel = generated.UserModel;
  assert.ok(isGeneratedModelClass(EnvelopeModel));
  assert.ok(isGeneratedModelClass(UserModel));
  if (!isGeneratedModelClass(EnvelopeModel) || !isGeneratedModelClass(UserModel)) {
    throw new TypeError('expected EnvelopeModel and UserModel');
  }
  const valid = {
    user: { id: 'u1', secret: 's', serverValue: 'ok' },
    relative: { id: 'u1', secret: 's', serverValue: 'ok' },
    scoped: { inner: { id: 'scoped' } },
  };
  const envelope = modelCodec(EnvelopeModel).fromWireFormat(valid, { validate: false }) as unknown as {
    user: object;
    relative: object;
  };
  assert.equal(envelope.user instanceof UserModel, true);
  assert.equal(envelope.relative instanceof UserModel, true);
  assert.equal(await getValidator(envelope).validate(), true);
  const invalid = modelCodec(EnvelopeModel).fromWireFormat({
    user: { id: 'u1' },
    relative: { id: 'u1', secret: 's', serverValue: 'ok' },
  }, { validate: false });
  assert.equal(await getValidator(invalid).validate(), false);
});
