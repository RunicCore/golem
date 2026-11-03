import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#model/generator';
import { createFixtureProject } from './fixture-project.js';
import { createModelProject, writeModelSources } from './model-project.js';
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

/** The `@exprtlabs/golem/...` modules that generated files import for values (`import { … }`) and for types only (`import type …`). */
function importedRuntimeModules(directory: string): { readonly values: readonly string[]; readonly types: readonly string[] } {
  const values = new Set<string>();
  const types = new Set<string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') visit(file);
      else if (/\.(?:ts|generated\.js)$/.test(entry.name)) {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/^import (type )?[^;]*? from ["'](@exprtlabs\/golem(?:-openapi-ts)?\/[^"']+)["']/gm)) (match[1] ? types : values).add(match[2]!);
      }
    }
  };
  visit(directory);
  return { values: [...values].sort(), types: [...types].sort() };
}

const profiles: readonly [string, OpenApiGenerationProfile, readonly string[], readonly string[]][] = [
  // A standalone SDK carries its runtime and imports nothing from @exprtlabs/golem.
  ['plain', { validation: false }, [], []],
  ['mobx and validation', { mobx: true, validation: true }, [
    '@exprtlabs/golem/internal/client-runtime', '@exprtlabs/golem/internal/client-validation-runtime', '@exprtlabs/golem-openapi-ts/internal/mobx-runtime', '@exprtlabs/golem/internal/model-runtime', '@exprtlabs/golem/internal/validation-runtime',
  ], ['@exprtlabs/golem/client', '@exprtlabs/golem-openapi-ts/mobx', '@exprtlabs/golem/serde', '@exprtlabs/golem/validation']],
];

for (const [label, profile, valueModules, typeModules] of profiles) {
  test(`a generated SDK (${label}) compiles and runs importing its runtime values from the internal entries and its types from the public subpaths`, async (t) => {
    // protects: T-653 generated files reach their runtime helpers only through the internal runtime entries; the types that apps see stay public
    const output = path.join(createFixtureProject(t, 'golem-runtime-entries-'), 'sdk');
    await generateMaterializedSdk(document, { output, name: 'Entries', profile });
    assert.deepEqual(importedRuntimeModules(output), { values: [...valueModules].sort(), types: [...typeModules].sort() });
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
    const created = await client.createItem().execute({ body: { id: 'a', createdAt: new Date('1970-01-01T00:00:00.000Z'), tags: ['x'] } });
    assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { id: 'a', createdAt: '1970-01-01T00:00:00.000Z', tags: ['x'] });
    assert.equal((created.body as { createdAt: Date }).createdAt.toISOString(), '1970-01-01T00:00:01.000Z');
    await client.getItem().execute({ path: { id: 'a b' }, query: { tag: ['p', 'q'] } });
    assert.equal(sent[1]!.url, 'https://api.example/items/a%20b?tag=p&tag=q');
    assert.equal(sent[1]!.init.headers.get('authorization'), 'Bearer token');
  });
}

test('a golem-model companion with validation off imports its runtime from the model entry alone, and loads no client entry', t => {
  // protects: T-653 a model-only app does not load the OpenAPI client runtime or its validation
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-entries-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ id: string; name: string }>;
export class Item extends TItemBaseModel {}
`,
  });
  const imported = new Set(generate({ root, profile: { validation: false } }).artifacts
    .flatMap(({ content }) => [...content.matchAll(/^import [^;]*? from '(@exprtlabs\/golem\/[^']+)'/gm)].map(match => match[1]!)));
  assert.deepEqual([...imported].sort(), ['@exprtlabs/golem/internal/model-runtime', '@exprtlabs/golem/model', '@exprtlabs/golem/serde']);
});
