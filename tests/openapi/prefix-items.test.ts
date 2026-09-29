import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOpenApiAjvEngine } from '@exprtlabs/codegen/ajv';
import { schemaType } from '#openapi/generator';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  requireRecord,
} from './helpers.js';

function prefixDoc(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Prefix', version: '1' },
    paths: {
      '/tuple': {
        post: {
          operationId: 'putTuple',
          requestBody: {
            required: true,
            content: { 'application/json': { schema } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema } },
            },
          },
        },
      },
    },
  };
}

test('prefixItems type is a prefix-length union filtered by min/max and items:false', () => {
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: false,
  }), '[] | [string] | [string, number]');
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: false,
    minItems: 2,
  }), '[string, number]');
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: false,
    maxItems: 1,
  }), '[] | [string]');
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }],
    items: { type: 'boolean' },
  }), '[] | [string] | [string, ...boolean[]]');
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: { type: 'boolean' },
    maxItems: 2,
  }), '[] | [string] | [string, number]');
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }],
    items: false,
    minItems: 3,
  }), 'never');
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }],
    minItems: 2,
    maxItems: 1,
  }), 'never');
});

test('prefixItems unions compile in strict TypeScript and validate on default Ajv', async (t) => {
  const schema = {
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: false,
  };
  const output = path.join(createFixtureProject(t, 'runic-openapi-prefix-'), 'sdk');
  await generateMaterializedSdk(prefixDoc(schema), {
    output,
    name: 'Prefix',
    profile: { mobx: false, validation: true },
  });
  copyFixtureFile(output, "openapi/prefix-items/prefix-assert.ts", "prefix-assert.ts");
  compileGeneratedSdk(output, [path.join(output, 'prefix-assert.ts')], { strict: true });
  const validation = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/schemas.js')).href),
    'validation',
  );
  const createOperationRuntimeValidators = validation.createOperationRuntimeValidators as (
    engine: ReturnType<typeof createOpenApiAjvEngine>,
  ) => Map<string, { responses: Map<string, (value: unknown) => boolean | Promise<boolean>> }>;
  const validators = createOperationRuntimeValidators(createOpenApiAjvEngine());
  const response = validators.get('putTuple')?.responses.get('200:application/json');
  assert.ok(response);
  assert.equal(await response([]), true);
  assert.equal(await response(['a']), true);
  assert.equal(await response(['a', 1]), true);
  assert.equal(await response([1]), false);
  assert.equal(await response(['a', 1, true]), false);
});

test('prefixItems rest tuples accept extra items at runtime while keeping positional types', async (t) => {
  const schema = {
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: { type: 'boolean' },
  };
  const output = path.join(createFixtureProject(t, 'runic-openapi-prefix-rest-'), 'sdk');
  await generateMaterializedSdk(prefixDoc(schema), {
    output,
    name: 'PrefixRest',
    profile: { mobx: false, validation: true },
  });
  copyFixtureFile(output, "openapi/prefix-items/prefix-rest-assert.ts", "prefix-rest-assert.ts");
  compileGeneratedSdk(output, [path.join(output, 'prefix-rest-assert.ts')], { strict: true });
  const validation = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/schemas.js')).href),
    'validation',
  );
  const createOperationRuntimeValidators = validation.createOperationRuntimeValidators as (
    engine: ReturnType<typeof createOpenApiAjvEngine>,
  ) => Map<string, { responses: Map<string, (value: unknown) => boolean | Promise<boolean>> }>;
  const validators = createOperationRuntimeValidators(createOpenApiAjvEngine());
  const response = validators.get('putTuple')?.responses.get('200:application/json');
  assert.ok(response);
  assert.equal(await response([]), true);
  assert.equal(await response(['a']), true);
  assert.equal(await response(['a', 1]), true);
  assert.equal(await response(['a', 1, true]), true);
  assert.equal(await response([1]), false);
  assert.equal(await response(['a', 1, 'nope']), false);
});
