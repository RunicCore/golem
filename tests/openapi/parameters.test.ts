import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generate } from '#openapi/generator';
import {
  captureRequest,
  compileGeneratedSdk,
  compileStrictUnusedSdk,
  documentBase,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  writeOpenApiDocument,
  type CapturedRequest,
} from './helpers.js';

test('operation parameters override path parameters by (in, name) and repeated path placeholders share one encoded parameter, observed on the wire', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-r5-');
  const output = path.join(directory, 'sdk');
  await generateMaterializedSdk(documentBase('3.1.0', {
    paths: {
      '/items/{id}': {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
        ],
        get: {
          operationId: 'getItem',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'tag', in: 'query', schema: { type: 'integer' } },
          ],
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/x/{id}/{id}': {
        get: {
          operationId: 'repeat',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
  }), {
    output,
    name: 'ParameterOverrides',
    profile: { mobx: false, validation: false },
  });
  copyFixtureFile(output, 'openapi/parameters/parameters-assert.ts', 'parameters-assert.ts');
  compileStrictUnusedSdk(output, [path.join(output, 'parameters-assert.ts')]);

  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'parameter override client',
  );
  const Client = module.ParameterOverridesClient;
  assert.equal(isGeneratedClientClass(Client), true);
  if (!isGeneratedClientClass(Client)) throw new TypeError('ParameterOverridesClient');
  let captured: CapturedRequest | undefined;
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      captured = captureRequest(url, init);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.getItem().execute({ path: { id: 5 }, query: { tag: 3 } });
  assert.equal(
    captured?.url,
    'https://api.example/items/5?tag=3',
    'the operation-level integer parameters win over the path-level string parameters and are each serialized exactly once',
  );
  const value = '$& /café';
  await client.repeat().execute({ path: { id: value } });
  assert.equal(
    captured?.url,
    `https://api.example/x/${encodeURIComponent(value)}/${encodeURIComponent(value)}`,
    'every repeated path placeholder uses the same encoded parameter',
  );
});

test('generated content parameters validate before execute with runtime and standalone Ajv', async t => {
  for (const ajvStandalone of [false, true] as const) {
    const directory = createFixtureProject(t, 'runic-openapi-content-parameters-');
    const output = path.join(directory, 'sdk');
    const contentSchema = (required: string) => ({
      type: 'object',
      required: [required],
      properties: { [required]: { type: 'string', pattern: '^[a-z]+$' } },
      additionalProperties: false,
    });
    const document = documentBase('3.2.0', {
      paths: {
        '/querystring': {
          get: {
            operationId: 'queryStringParam',
            parameters: [{
              name: 'queryStringValue',
              in: 'querystring',
              required: true,
              content: { 'application/x-www-form-urlencoded': { schema: contentSchema('term') } },
            }],
            responses: { 204: { description: 'ok' } },
          },
        },
        '/query': {
          get: {
            operationId: 'queryParam',
            parameters: [{
              name: 'queryValue',
              in: 'query',
              content: { 'application/json': { schema: contentSchema('filter') } },
            }],
            responses: { 204: { description: 'ok' } },
          },
        },
        '/header': {
          get: {
            operationId: 'headerParam',
            parameters: [{
              name: 'X-Content',
              in: 'header',
              content: { 'application/json': { schema: contentSchema('header') } },
            }],
            responses: { 204: { description: 'ok' } },
          },
        },
        '/items/{pathValue}': {
          get: {
            operationId: 'pathParam',
            parameters: [{
              name: 'pathValue',
              in: 'path',
              required: true,
              content: { 'application/json': { schema: contentSchema('id') } },
            }],
            responses: { 204: { description: 'ok' } },
          },
        },
        '/blocked': {
          get: {
            operationId: 'blocked',
            parameters: [{
              name: 'queryValue',
              in: 'query',
              content: { 'application/json': { schema: false } },
            }],
            responses: { 204: { description: 'blocked' } },
          },
        },
      },
    });
    await generateMaterializedSdk(document, {
      output,
      name: 'ContentParameters',
      profile: { mobx: false, validation: true, ajvStandalone },
    });
    copyFixtureFile(output, 'openapi/parameters/parameters-content-false-assert.ts', 'parameters-content-false-assert.ts');
    compileGeneratedSdk(output, [path.join(output, 'parameters-content-false-assert.ts')]);
    if (!ajvStandalone) {
      // A `false` parameter content schema stays `false` through normalization into the emitted runtime registry.
      const schemas = requireRecord(
        await import(pathToFileURL(path.join(output, 'dist/schemas.js')).href),
        'content false schemas',
      );
      const registry = requireRecord(schemas.runtimeSchemaRegistry, 'content false runtime registry');
      const operation = requireRecord(requireRecord(registry.operations, 'content false operations').blocked, 'blocked operation');
      const input = requireRecord(operation.input, 'blocked input');
      const query = requireRecord(requireRecord(input.properties, 'blocked input properties').query, 'blocked query');
      assert.equal(requireRecord(query.properties, 'blocked query properties').queryValue, false);
    }
    const module = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
      'content parameter client',
    );
    const Client = module.ContentParametersClient;
    assert.equal(isGeneratedClientClass(Client), true);
    if (!isGeneratedClientClass(Client)) throw new TypeError('ContentParametersClient');

    let fetchCount = 0;
    const client = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(null, { status: 204 });
      },
    });
    const cases = [
      {
        operation: 'queryStringParam',
        valid: { querystring: { term: 'search' } },
        invalid: { querystring: { term: 1 } },
      },
      {
        operation: 'queryParam',
        valid: { query: { queryValue: { filter: 'active' } } },
        invalid: { query: { queryValue: { filter: 1 } } },
      },
      {
        operation: 'headerParam',
        valid: { header: { 'X-Content': { header: 'trace' } } },
        invalid: { header: { 'X-Content': { header: 1 } } },
      },
      {
        operation: 'pathParam',
        valid: { path: { pathValue: { id: 'item' } } },
        invalid: { path: { pathValue: { id: 1 } } },
      },
    ] as const;
    for (const [index, { operation, valid, invalid }] of cases.entries()) {
      const api = client[operation]();
      const fetchesBeforeInvalid = fetchCount;
      await assert.rejects(
        () => api.execute(invalid),
        /API data validation failed|validation failed/i,
        `${operation} content parameter is rejected before serialization`,
      );
      assert.equal(fetchCount, fetchesBeforeInvalid, `${operation} invalid content parameter did not reach fetch`);
      await api.execute(valid);
      assert.equal(fetchCount, index + 1);
    }
    const fetchesBeforeBlocked = fetchCount;
    await assert.rejects(
      () => client.blocked().execute({ query: { queryValue: 'anything' } }),
      /validation failed/i,
      'a schema: false content parameter is unusable and is rejected before serialization',
    );
    assert.equal(fetchCount, fetchesBeforeBlocked, 'the blocked queryValue must not reach fetch');
  }
});

test('rejects duplicate parameters within the same level', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-r5-dup-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  }));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile: { mobx: false, validation: false } }),
    /operation-parameters-unique: parameter "id" in path is listed more than once \(openapi\.json#\/paths\/~1items~1\{id\}\/get\/parameters\/1\)/,
  );
});

test('a parameter $ref into a separate file resolves to its declared type after bundling', async t => {
  const directory = createFixtureProject(t, 'runic-openapi-external-parameter-');
  writeFileSync(path.join(directory, 'parameters.json'), JSON.stringify({
    Limit: { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
  }));
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [{ $ref: './parameters.json#/Limit' }],
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  }));
  const output = path.join(directory, 'sdk');
  const result = await generate({ input, output, name: 'External', profile: { mobx: false, validation: false } });
  const types = result.artifacts.find(artifact => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /limit: number/, types);
});
