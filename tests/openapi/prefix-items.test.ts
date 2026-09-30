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

/** One operation per tuple schema; each round-trips the schema as request and response body. */
function prefixDoc(schemas: Readonly<Record<string, Record<string, unknown>>>): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [operationId, schema] of Object.entries(schemas)) {
    paths[`/${operationId}`] = {
      post: {
        operationId,
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
    };
  }
  return { openapi: '3.1.0', info: { title: 'Prefix', version: '1' }, paths };
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

test('prefixItems closed and rest tuples compile in strict TypeScript and validate on default Ajv', async (t) => {
  const output = path.join(createFixtureProject(t, 'runic-openapi-prefix-'), 'sdk');
  await generateMaterializedSdk(prefixDoc({
    putTuple: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
      items: false,
    },
    putRestTuple: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
      items: { type: 'boolean' },
    },
  }), {
    output,
    name: 'Prefix',
    profile: { mobx: false, validation: true },
  });
  copyFixtureFile(output, "openapi/prefix-items/prefix-assert.ts", "prefix-assert.ts");
  copyFixtureFile(output, "openapi/prefix-items/prefix-rest-assert.ts", "prefix-rest-assert.ts");
  compileGeneratedSdk(output, [path.join(output, 'prefix-assert.ts'), path.join(output, 'prefix-rest-assert.ts')], { strict: true });
  const validation = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/schemas.js')).href),
    'validation',
  );
  const createOperationRuntimeValidators = validation.createOperationRuntimeValidators as (
    engine: ReturnType<typeof createOpenApiAjvEngine>,
  ) => Map<string, { responses: Map<string, (value: unknown) => boolean | Promise<boolean>> }>;
  const validators = createOperationRuntimeValidators(createOpenApiAjvEngine());
  const closed = validators.get('putTuple')?.responses.get('200:application/json');
  assert.ok(closed);
  assert.equal(await closed([]), true);
  assert.equal(await closed(['a']), true);
  assert.equal(await closed(['a', 1]), true);
  assert.equal(await closed([1]), false);
  assert.equal(await closed(['a', 1, true]), false);
  const rest = validators.get('putRestTuple')?.responses.get('200:application/json');
  assert.ok(rest);
  assert.equal(await rest([]), true);
  assert.equal(await rest(['a']), true);
  assert.equal(await rest(['a', 1]), true);
  assert.equal(await rest(['a', 1, true]), true);
  assert.equal(await rest([1]), false);
  assert.equal(await rest(['a', 1, 'nope']), false);
});
