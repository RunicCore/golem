import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { reaction } from 'mobx';
import { generate } from '#openapi/generator';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isAsyncIterable,
  requireRecord,
  writeOpenApiDocument,
  type OpenApiGenerationProfile,
} from './helpers.js';
import { beginMobxPass, captureWarnings, deferred, enforceActions, rejectOnAbort } from '../support/client-test-utils.js';

interface RuntimeApiOperation {
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<{
    status: number;
    body: unknown;
  }>;
}

interface ObservableRuntimeApiOperation extends RuntimeApiOperation {
  readonly loading: boolean;
}

interface ItemsClient {
  listItems(): RuntimeApiOperation;
  createItem(): RuntimeApiOperation;
  readStream(): RuntimeApiOperation;
}

function isRuntimeApiOperation(value: unknown): value is RuntimeApiOperation {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'execute') === 'function'
    && !('then' in value);
}

function isObservableRuntimeApiOperation(value: unknown): value is ObservableRuntimeApiOperation {
  return isRuntimeApiOperation(value) && typeof Reflect.get(value, 'loading') === 'boolean';
}

function isItemsClientClass(value: unknown): value is new (options: Record<string, unknown>) => ItemsClient {
  return typeof value === 'function';
}

function defaultItemsFetch(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST') {
    return Promise.resolve(Response.json({ id: 'item-1' }, { status: 201 }));
  }
  return Promise.resolve(Response.json(['ok']));
}

function itemsDocument(): Record<string, unknown> {
  return {
    openapi: '3.2.0',
    info: { title: 'Items', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          security: [{ apiKey: [] }],
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createItem',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: { title: { type: 'string' } },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            201: {
              description: 'created',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      '/items/stream': {
        get: {
          operationId: 'readStream',
          responses: {
            200: {
              description: 'stream',
              content: {
                'application/x-ndjson': {
                  itemSchema: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'integer' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    webhooks: {
      itemCreated: {
        post: {
          operationId: 'receiveItemCreated',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
              },
            },
          },
          responses: { 204: { description: 'accepted' } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
  };
}

interface ItemsClientModule {
  readonly Client: new (options: Record<string, unknown>) => ItemsClient;
  readonly output: string;
}

// One generate and compile per profile: the tests share the loaded module and each builds its own clients.
const itemsClients = new Map<string, Promise<ItemsClientModule>>();
const itemsClientRoots: string[] = [];
after(() => {
  for (const root of itemsClientRoots) fs.rmSync(root, { recursive: true, force: true });
});

function loadItemsClient(profile: OpenApiGenerationProfile): Promise<ItemsClientModule> {
  const key = `mobx=${profile.mobx},validation=${profile.validation}`;
  const cached = itemsClients.get(key);
  if (cached) return cached;
  const loaded = generateItemsClient(profile);
  itemsClients.set(key, loaded);
  return loaded;
}

async function generateItemsClient(profile: OpenApiGenerationProfile): Promise<ItemsClientModule> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-api-operation-')));
  itemsClientRoots.push(root);
  const output = path.join(root, 'sdk');
  const result = await generateMaterializedSdk(itemsDocument(), {
    output,
    name: 'Items',
    profile,
  });
  assert.ok(result.artifacts.some(({ path: filename }) => filename.endsWith('/client.ts')));
  compileGeneratedSdk(output);
  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'Items client',
  );
  const Client = module.ItemsClient;
  assert.equal(isItemsClientClass(Client), true);
  if (!isItemsClientClass(Client)) throw new TypeError('ItemsClient');
  return { Client, output };
}

test('generated factory is inert, reusable, and reads auth at execute time', async (t) => {
  const { Client, output } = await loadItemsClient({ mobx: false, validation: true });
  copyFixtureFile(output, "openapi/api-operation/loading-boundary.ts", "loading-boundary.ts");
  compileGeneratedSdk(output, [path.join(output, 'loading-boundary.ts')], { noEmit: true, strict: true });

  let fetches = 0;
  let authCalls = 0;
  let inputValidationCalls = 0;
  let token = 'first-token';
  const headers: string[] = [];
  const inputValidator = (): readonly [] => {
    inputValidationCalls += 1;
    return [];
  };
  const client = new Client({
    baseUrl: 'https://example.test',
    auth: {
      apiKey: () => {
        authCalls += 1;
        return token;
      },
    },
    operationValidators: new Map([
      ['listItems', { input: inputValidator, responses: new Map() }],
    ]),
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetches += 1;
      headers.push(new Headers(init?.headers).get('X-API-Key') ?? '');
      return Response.json(['ok'], { status: 200 });
    },
  });
  const operation = client.listItems();
  assert.equal(isRuntimeApiOperation(operation), true);
  if (!isRuntimeApiOperation(operation)) throw new TypeError('listItems operation');
  assert.equal('then' in operation, false);
  assert.equal('loading' in operation, false);
  assert.equal(fetches, 0);
  assert.equal(authCalls, 0);
  assert.equal(inputValidationCalls, 0);
  assert.equal((await operation.execute({})).status, 200);
  assert.equal(authCalls, 1);
  assert.equal(inputValidationCalls, 1);
  token = 'second-token';
  assert.equal((await operation.execute({ query: { cursor: 'abc' } })).status, 200);
  assert.equal(fetches, 2);
  assert.equal(authCalls, 2);
  assert.equal(inputValidationCalls, 2);
  assert.deepEqual(headers, ['first-token', 'second-token']);
});

test('overlapping generated execute calls warn in both profiles and clean up on failure', async (t) => {
  const warnings = captureWarnings(t);
  for (const mobx of [false, true]) {
    beginMobxPass(t, mobx, warnings);
    const { Client } = await loadItemsClient({ mobx, validation: true });
    const { promise: gate, resolve: release } = deferred();
    const client = new Client({
      baseUrl: 'https://example.test',
      auth: { apiKey: 'secret' },
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        await gate;
        if (init?.method === 'POST') {
          return Response.json({ id: 'item-1' }, { status: 201 });
        }
        return Response.json(['ok']);
      },
    });
    const operation = client.listItems();
    assert.equal(isRuntimeApiOperation(operation), true);
    if (!isRuntimeApiOperation(operation)) throw new TypeError('listItems operation');
    if (mobx) {
      assert.equal(isObservableRuntimeApiOperation(operation), true);
      if (!isObservableRuntimeApiOperation(operation)) throw new TypeError('observable listItems');
      assert.equal(operation.loading, false);
    } else {
      assert.equal('loading' in operation, false);
    }
    const first = operation.execute({});
    const second = operation.execute({});
    const third = operation.execute({});
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.match(warning, /listItems/);
      assert.doesNotMatch(warning, /secret/);
    }
    if (isObservableRuntimeApiOperation(operation)) assert.equal(operation.loading, true);
    release();
    await Promise.all([first, second, third]);
    if (isObservableRuntimeApiOperation(operation)) assert.equal(operation.loading, false);

    const create = client.createItem();
    assert.equal(isRuntimeApiOperation(create), true);
    if (!isRuntimeApiOperation(create)) throw new TypeError('createItem operation');
    await assert.rejects(
      create.execute({ body: {} }),
      /API data validation failed|validation/,
    );
    if (isObservableRuntimeApiOperation(create)) assert.equal(create.loading, false);
    assert.equal((await create.execute({ body: { title: 'widget' } })).status, 201);
    if (isObservableRuntimeApiOperation(create)) assert.equal(create.loading, false);

    const controller = new AbortController();
    const aborting = new Client({
      baseUrl: 'https://example.test',
      auth: { apiKey: 'secret' },
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        await rejectOnAbort(init?.signal);
      },
    }).listItems();
    const pending = aborting.execute({}, { signal: controller.signal });
    if (isObservableRuntimeApiOperation(aborting)) assert.equal(aborting.loading, true);
    controller.abort();
    await assert.rejects(pending, /aborted/);
    if (isObservableRuntimeApiOperation(aborting)) assert.equal(aborting.loading, false);
  }
});

test('generated execute recovers from pipeline failures on the same object', async (t) => {
  for (const mobx of [false, true]) {
    if (mobx) enforceActions(t);
    const { Client } = await loadItemsClient({ mobx, validation: true });

    let rejectAuth = true;
    const listed = new Client({
      baseUrl: 'https://example.test',
      auth: {
        apiKey: () => {
          if (rejectAuth) throw new Error('auth rejected');
          return 'secret';
        },
      },
      fetchImpl: defaultItemsFetch,
    }).listItems();
    await assert.rejects(listed.execute({}), /auth rejected/);
    if (isObservableRuntimeApiOperation(listed)) assert.equal(listed.loading, false);
    rejectAuth = false;
    assert.equal((await listed.execute({})).status, 200);
    if (isObservableRuntimeApiOperation(listed)) assert.equal(listed.loading, false);

    let failEncoder = true;
    const created = new Client({
      baseUrl: 'https://example.test',
      bodyEncoders: {
        'application/json': (value: unknown) => {
          if (failEncoder) throw new Error('encoder failed');
          return JSON.stringify(value);
        },
      },
      fetchImpl: defaultItemsFetch,
    }).createItem();
    await assert.rejects(created.execute({ body: { title: 'widget' } }), /encoder failed/);
    if (isObservableRuntimeApiOperation(created)) assert.equal(created.loading, false);
    failEncoder = false;
    assert.equal((await created.execute({ body: { title: 'widget' } })).status, 201);
    if (isObservableRuntimeApiOperation(created)) assert.equal(created.loading, false);

    let failFetch = true;
    const fetched = new Client({
      baseUrl: 'https://example.test',
      auth: { apiKey: 'secret' },
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (failFetch) throw new Error('fetch rejected');
        return defaultItemsFetch(_url, init);
      },
    }).listItems();
    await assert.rejects(fetched.execute({}), /fetch rejected/);
    if (isObservableRuntimeApiOperation(fetched)) assert.equal(fetched.loading, false);
    failFetch = false;
    assert.equal((await fetched.execute({})).status, 200);
    if (isObservableRuntimeApiOperation(fetched)) assert.equal(fetched.loading, false);

    let failDecoder = true;
    const decoded = new Client({
      baseUrl: 'https://example.test',
      auth: { apiKey: 'secret' },
      responseDecoders: {
        'application/json': async (response: Response) => {
          const body: unknown = await response.json();
          if (failDecoder) throw new Error('decoder failed');
          return body;
        },
      },
      fetchImpl: defaultItemsFetch,
    }).listItems();
    await assert.rejects(decoded.execute({}), /decoder failed/);
    if (isObservableRuntimeApiOperation(decoded)) assert.equal(decoded.loading, false);
    failDecoder = false;
    assert.equal((await decoded.execute({})).status, 200);
    if (isObservableRuntimeApiOperation(decoded)) assert.equal(decoded.loading, false);

    let invalidResponse = true;
    const validated = new Client({
      baseUrl: 'https://example.test',
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          if (invalidResponse) return Response.json({ id: 1 }, { status: 201 });
          return Response.json({ id: 'item-1' }, { status: 201 });
        }
        return Response.json(['ok']);
      },
    }).createItem();
    await assert.rejects(
      validated.execute({ body: { title: 'widget' } }),
      /API data validation failed|validation/,
    );
    if (isObservableRuntimeApiOperation(validated)) assert.equal(validated.loading, false);
    invalidResponse = false;
    assert.equal((await validated.execute({ body: { title: 'widget' } })).status, 201);
    if (isObservableRuntimeApiOperation(validated)) assert.equal(validated.loading, false);
  }
});

test('generated loading stays true when a failed execute overlaps a pending success', async (t) => {
  const warnings = captureWarnings(t);
  for (const mobx of [false, true]) {
    beginMobxPass(t, mobx, warnings);
    const { Client } = await loadItemsClient({ mobx, validation: true });
    const { promise: gate, resolve: release } = deferred();
    const { promise: firstInFlight, resolve: firstEntered } = deferred();
    let rejectAuth = false;
    const client = new Client({
      baseUrl: 'https://example.test',
      auth: {
        apiKey: () => {
          if (rejectAuth) throw new Error('auth rejected');
          return 'secret';
        },
      },
      fetchImpl: async () => {
        firstEntered();
        await gate;
        return Response.json(['ok']);
      },
    });
    const operation = client.listItems();
    const success = operation.execute({});
    await firstInFlight;
    if (isObservableRuntimeApiOperation(operation)) assert.equal(operation.loading, true);
    rejectAuth = true;
    await assert.rejects(operation.execute({}), /auth rejected/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /listItems/);
    if (isObservableRuntimeApiOperation(operation)) assert.equal(operation.loading, true);
    release();
    assert.equal((await success).status, 200);
    if (isObservableRuntimeApiOperation(operation)) assert.equal(operation.loading, false);
  }
});

test('generated factory objects and clients isolate pending counters and overlap warnings', async (t) => {
  const warnings = captureWarnings(t);
  for (const mobx of [false, true]) {
    beginMobxPass(t, mobx, warnings);
    const { Client } = await loadItemsClient({ mobx, validation: true });
    const { promise: gate, resolve: release } = deferred();
    const fetchImpl = async (): Promise<Response> => {
      await gate;
      return Response.json(['ok']);
    };
    const client = new Client({
      baseUrl: 'https://example.test',
      auth: { apiKey: 'secret' },
      fetchImpl,
    });
    const left = client.listItems();
    const right = client.listItems();
    const first = left.execute({});
    const second = right.execute({});
    assert.equal(warnings.length, 0);
    if (isObservableRuntimeApiOperation(left)) assert.equal(left.loading, true);
    if (isObservableRuntimeApiOperation(right)) assert.equal(right.loading, true);
    const extra = left.execute({});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /listItems/);
    const other = new Client({
      baseUrl: 'https://example.test',
      auth: { apiKey: 'other-secret' },
      fetchImpl,
    }).listItems();
    const otherPending = other.execute({});
    assert.equal(warnings.length, 1);
    if (isObservableRuntimeApiOperation(other)) assert.equal(other.loading, true);
    if (isObservableRuntimeApiOperation(left)) assert.equal(left.loading, true);
    if (isObservableRuntimeApiOperation(right)) assert.equal(right.loading, true);
    release();
    await Promise.all([first, second, extra, otherPending]);
    if (isObservableRuntimeApiOperation(left)) assert.equal(left.loading, false);
    if (isObservableRuntimeApiOperation(right)) assert.equal(right.loading, false);
    if (isObservableRuntimeApiOperation(other)) assert.equal(other.loading, false);
  }
});

test('MobX generated loading follows execute settlement, not stream consumption', async (t) => {
  enforceActions(t);
  const { Client, output } = await loadItemsClient({ mobx: true, validation: false });
  copyFixtureFile(output, "openapi/api-operation/loading-present.ts", "loading-present.ts");
  compileGeneratedSdk(output, [path.join(output, 'loading-present.ts')], { noEmit: true, strict: true });

  const { promise: fetchGate, resolve: releaseFetch } = deferred();
  const client = new Client({
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      await fetchGate;
      return new Response('{"id":1}\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    },
  });
  const operation = client.readStream();
  assert.equal(isObservableRuntimeApiOperation(operation), true);
  if (!isObservableRuntimeApiOperation(operation)) throw new TypeError('readStream operation');
  const loadings: boolean[] = [];
  const stop = reaction(
    () => operation.loading,
    (loading) => {
      loadings.push(loading);
    },
    { fireImmediately: true },
  );
  t.after(stop);
  const pending = operation.execute({});
  assert.equal(operation.loading, true);
  releaseFetch();
  const response = await pending;
  assert.equal(operation.loading, false);
  assert.equal(isAsyncIterable(response.body), true);
  if (!isAsyncIterable(response.body)) throw new TypeError('stream body');
  const items: unknown[] = [];
  for await (const item of response.body) {
    assert.equal(operation.loading, false);
    items.push(item);
  }
  assert.deepEqual(items, [{ id: 1 }]);
  assert.deepEqual(loadings, [false, true, false]);
});

test('operation names that collide with the factory remain reserved', async (t) => {
  const directory = createFixtureProject(t, 'golem-api-operation-reserved-');
  await assert.rejects(
    () => generate({
      input: writeOpenApiDocument(directory, {
        openapi: '3.1.0',
        info: { title: 'Reserved', version: '1' },
        paths: {
          '/items': {
            get: {
              operationId: 'createApiOperation',
              responses: { 204: { description: 'ok' } },
            },
          },
        },
      }),
      output: path.join(directory, 'sdk'),
      name: 'Reserved',
      profile: { mobx: false, validation: false },
    }),
    /createApiOperation/,
  );
});
