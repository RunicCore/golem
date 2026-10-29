import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFixtureProject } from './fixture-project.js';
import { captureRequest, compileGeneratedSdk, documentBase, generateMaterializedSdk, loadGeneratedClient, type OpenApiGenerationProfile } from './openapi/helpers.js';

const item = { $ref: '#/components/schemas/Item' };
const json = (schema: unknown) => ({ 'application/json': { schema } });

const document = documentBase('3.1.0', {
  components: {
    schemas: {
      Item: {
        type: 'object',
        required: ['id', 'createdAt'],
        properties: { id: { type: 'string', minLength: 1 }, createdAt: { type: 'string', format: 'date-time' }, tags: { type: 'array', items: { type: 'string' } } },
      },
    },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'ok', content: json(item) } },
      },
    },
    '/items': { post: { operationId: 'createItem', requestBody: { required: true, content: json(item) }, responses: { 200: { description: 'ok', content: json(item) } } } },
  },
});

/** Every `@exprtlabs/golem/...` module that a generated file imports, read from the files that the tsc run of the SDK compiles and loads. */
function importedRuntimeModules(directory: string): readonly string[] {
  const found = new Set<string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') visit(file);
      else if (/\.(?:ts|generated\.js)$/.test(entry.name)) {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/from ["'](@exprtlabs\/golem\/[^"']+)["']/g)) found.add(match[1]!);
      }
    }
  };
  visit(directory);
  return [...found].sort();
}

const profiles: readonly [string, OpenApiGenerationProfile, readonly string[]][] = [
  ['plain', { mobx: false, validation: false }, ['@exprtlabs/golem/client', '@exprtlabs/golem/internal/client-runtime', '@exprtlabs/golem/internal/model-runtime']],
  ['mobx and validation', { mobx: true, validation: true }, [
    '@exprtlabs/golem/client', '@exprtlabs/golem/internal/client-runtime', '@exprtlabs/golem/internal/mobx-runtime',
    '@exprtlabs/golem/internal/model-runtime', '@exprtlabs/golem/internal/validation-runtime',
  ]],
];

for (const [label, profile, modules] of profiles) {
  test(`a generated SDK (${label}) compiles and runs importing its runtime-only names from the internal entries only`, async (t) => {
    // protects: T-653 generated files reach their runtime helpers only through the internal runtime entries
    const output = path.join(createFixtureProject(t, 'golem-runtime-entries-'), 'sdk');
    await generateMaterializedSdk(document, { output, name: 'Entries', profile });
    assert.deepEqual(importedRuntimeModules(output), modules);
    compileGeneratedSdk(output);
    const Client = await loadGeneratedClient(output, 'Entries');
    const sent: ReturnType<typeof captureRequest>[] = [];
    const client = new Client({
      baseUrl: 'https://api.example',
      auth: { bearer: 'token' },
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        sent.push(captureRequest(url, init));
        return new Response(JSON.stringify({ id: 'a', createdAt: '1970-01-01T00:00:01.000Z', tags: ['x'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const created = await client.createItem().execute({ body: { id: 'a', createdAt: '1970-01-01T00:00:00.000Z', tags: ['x'] } });
    assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { id: 'a', createdAt: '1970-01-01T00:00:00.000Z', tags: ['x'] });
    assert.equal((created.body as { createdAt: string }).createdAt, '1970-01-01T00:00:01.000Z');
    await client.getItem().execute({ path: { id: 'a b' }, query: { tag: ['p', 'q'] } });
    assert.equal(sent[1]!.url, 'https://api.example/items/a%20b?tag=p&tag=q');
    assert.equal(sent[1]!.init.headers.get('authorization'), 'Bearer token');
  });
}
