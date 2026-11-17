import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOpenApiRules } from '#openapi/openapi-rules';

function documentBase(openapi: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { openapi, info: { title: 'Rules', version: '1' }, ...extra };
}

function found(document: unknown, ruleId: string): string[] {
  return checkOpenApiRules(document).filter((problem) => problem.ruleId === ruleId).map((problem) => problem.pointer);
}

const ok = { 200: { description: 'ok' } };

test('no-unresolved-refs reports missing pointers and unknown non-fragment refs', () => {
  const document = documentBase('3.1.0', {
    paths: {
      '/a': {
        get: {
          parameters: [{ $ref: '#/components/parameters/Missing' }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './gone.json' } } } } },
        },
      },
    },
    components: {
      schemas: {
        Tree: { $id: 'https://rules.example/tree', type: 'object', properties: { child: { $ref: 'https://rules.example/tree' } } },
        Anchor: { $dynamicRef: '#node' },
        Present: { $ref: '#/components/schemas/Tree' },
      },
    },
  });
  assert.deepEqual(found(document, 'no-unresolved-refs').sort(), [
    '/paths/~1a/get/parameters/0/$ref',
    '/paths/~1a/get/responses/200/content/application~1json/schema/$ref',
  ]);
  assert.match(checkOpenApiRules(document)[0]?.message ?? '', /^Can't resolve \$ref /);
});

test('no-unresolved-refs accepts percent-encoded pointers that resolve after decoding', () => {
  const document = documentBase('3.1.0', {
    components: { schemas: { 'A B': { type: 'string' }, Ref: { $ref: '#/components/schemas/A%20B' } } },
  });
  assert.deepEqual(found(document, 'no-unresolved-refs'), []);
});

test('operation-operationId-unique covers paths, webhooks and callbacks once per operation', () => {
  const shared = { get: { operationId: 'shared', responses: ok } };
  const document = documentBase('3.1.0', {
    paths: {
      '/a': { get: { operationId: 'dup', responses: ok } },
      '/b': {
        post: {
          operationId: 'dup',
          responses: ok,
          callbacks: { cb: { '{$request.body#/url}': { post: { operationId: 'dup', responses: ok } } } },
        },
      },
      '/c': { $ref: '#/components/pathItems/Shared' },
      '/d': { $ref: '#/components/pathItems/Shared' },
    },
    webhooks: { hook: { post: { operationId: 'dup', responses: ok } } },
    components: { pathItems: { Shared: shared } },
  });
  assert.deepEqual(found(document, 'operation-operationId-unique'), [
    '/paths/~1b/post/operationId',
    '/webhooks/hook/post/operationId',
    '/paths/~1b/post/callbacks/cb/{$request.body#~1url}/post/operationId',
  ]);
  assert.deepEqual(
    checkOpenApiRules(document)
      .filter((problem) => problem.ruleId === 'operation-operationId-unique')
      .map((problem) => [problem.message, problem.relatedPointer]),
    [
      ['operationId "dup" is used more than once', '/paths/~1a/get/operationId'],
      ['operationId "dup" is used more than once', '/paths/~1a/get/operationId'],
      ['operationId "dup" is used more than once', '/paths/~1a/get/operationId'],
    ],
  );
});

test('operation-parameters-unique reports duplicates within one list only', () => {
  const query = { name: 'q', in: 'query', schema: { type: 'string' } };
  const document = documentBase('3.1.0', {
    paths: {
      '/a': {
        parameters: [query],
        get: { parameters: [query, { $ref: '#/components/parameters/Q' }], responses: ok },
      },
    },
    components: { parameters: { Q: query } },
  });
  assert.deepEqual(found(document, 'operation-parameters-unique'), ['/paths/~1a/get/parameters/1']);
});

test('operation-parameters-unique treats header names that differ only by case as one parameter', () => {
  // protects: T-491 header parameter names are case-insensitive
  const header = (name: string) => ({ name, in: 'header', schema: { type: 'string' } });
  const document = documentBase('3.1.0', {
    paths: {
      '/a': { get: { parameters: [header('X-Trace'), header('x-trace'), { name: 'Q', in: 'query' }, { name: 'q', in: 'query' }], responses: ok } },
    },
  });
  assert.deepEqual(found(document, 'operation-parameters-unique'), ['/paths/~1a/get/parameters/1']);
});

test('operation-response-headers-unique reports response header names that differ only by case', () => {
  // protects: T-963 response header names are case-insensitive, as header parameter names are (T-491, T-920)
  const header = { schema: { type: 'string' } };
  const document = documentBase('3.1.0', {
    paths: {
      '/a': {
        get: {
          responses: {
            200: { description: 'ok', headers: { 'X-A': header, 'x-a': header, 'X-B': header } },
            201: { description: 'one name', headers: { 'X-A': header } },
            202: { $ref: '#/components/responses/Shared' },
          },
        },
        post: { responses: { 202: { $ref: '#/components/responses/Shared' } } },
      },
    },
    components: { responses: { Shared: { description: 'shared', headers: { Etag: header, ETAG: header } } } },
  });
  assert.deepEqual(found(document, 'operation-response-headers-unique'), [
    '/paths/~1a/get/responses/200/headers/x-a',
    '/components/responses/Shared/headers/ETAG',
  ]);
});

test('no-duplicated-server-names reports a repeated 3.2 server name within one list', () => {
  // protects: T-491 3.2 server names are unique
  const document = documentBase('3.2.0', {
    servers: [{ url: 'https://a.example', name: 'prod' }, { url: 'https://b.example', name: 'prod' }, { url: 'https://c.example', name: 'dev' }],
    paths: { '/a': { servers: [{ url: 'https://d.example', name: 'prod' }], get: { responses: ok } } },
  });
  assert.deepEqual(found(document, 'no-duplicated-server-names'), ['/servers/1/name']);
});

test('path-parameters-defined checks both directions', () => {
  const document = documentBase('3.1.0', {
    paths: {
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { responses: ok },
      },
      '/users/{userId}': {
        get: { responses: ok },
        put: { parameters: [{ name: 'other', in: 'path', required: true, schema: { type: 'string' } }], responses: ok },
      },
    },
  });
  assert.deepEqual(found(document, 'path-parameters-defined').sort(), [
    '/paths/~1users~1{userId}/get',
    '/paths/~1users~1{userId}/put',
    '/paths/~1users~1{userId}/put/parameters/0',
  ]);
});

test('path-declaration-must-exist and no-identical-paths', () => {
  const document = documentBase('3.1.0', {
    paths: {
      '/a/{}': { get: { responses: ok } },
      '/u/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: {} }], responses: ok } },
      '/u/{name}': { get: { parameters: [{ name: 'name', in: 'path', required: true, schema: {} }], responses: ok } },
    },
  });
  assert.deepEqual(found(document, 'path-declaration-must-exist'), ['/paths/~1a~1{}']);
  assert.deepEqual(found(document, 'no-identical-paths'), ['/paths/~1u~1{name}']);
});

test('a valid document has no rule problems', () => {
  const document = documentBase('3.2.0', {
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: ok,
        },
      },
    },
  });
  assert.deepEqual(checkOpenApiRules(document), []);
});

test('no-duplicated-tag-names', () => {
  const document = documentBase('3.1.0', { paths: {}, tags: [{ name: 'a' }, { name: 'b' }, { name: 'a' }] });
  assert.deepEqual(found(document, 'no-duplicated-tag-names'), ['/tags/2/name']);
});

test('no-undefined-server-variable checks root, path and operation servers', () => {
  const document = documentBase('3.1.0', {
    servers: [{ url: 'https://{region}.api.example', variables: { region: { default: 'eu' } } }, { url: 'https://{env}.example' }],
    paths: {
      '/a': {
        servers: [{ url: 'https://{zone}.example' }],
        get: { servers: [{ url: 'https://{tier}.example', variables: {} }], responses: ok },
      },
    },
  });
  assert.deepEqual(found(document, 'no-undefined-server-variable'), [
    '/servers/1/url',
    '/paths/~1a/servers/0/url',
    '/paths/~1a/get/servers/0/url',
  ]);
});

test('operation-security-defined reports security requirement names that no security scheme declares', () => {
  // protects: security requirement naming an undeclared scheme generated a client that sent no credentials
  const document = documentBase('3.1.0', {
    security: [{ apiKey: [] }, { rootTypo: [] }],
    paths: {
      '/a': { get: { security: [{ typo: [] }, { apiKey: [], other: [] }], responses: ok } },
      '/b': { get: { security: [], responses: ok } },
      '/c': { get: { responses: ok } },
    },
    components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
  });
  assert.deepEqual(
    checkOpenApiRules(document)
      .filter((problem) => problem.ruleId === 'operation-security-defined')
      .map((problem) => [problem.pointer, problem.message]),
    [
      ['/security/1/rootTypo', 'security requirement names "rootTypo", which is not declared in components.securitySchemes'],
      ['/paths/~1a/get/security/0/typo', 'security requirement names "typo", which is not declared in components.securitySchemes'],
      ['/paths/~1a/get/security/1/other', 'security requirement names "other", which is not declared in components.securitySchemes'],
    ],
  );
});

test('no-request-item-schema reports a request body itemSchema inline, through a $ref and in a webhook', () => {
  // protects: T-964 a request itemSchema was typed unknown and sent as JSON
  const feed = { 'application/x-ndjson': { itemSchema: { type: 'object' } } };
  const document = documentBase('3.2.0', {
    paths: {
      '/upload': { post: { requestBody: { content: feed }, responses: ok } },
      '/feed': { post: { requestBody: { $ref: '#/components/requestBodies/Feed' }, responses: ok } },
      '/read': { get: { responses: { 200: { description: 'ok', content: feed } } } },
    },
    webhooks: { pushed: { post: { requestBody: { content: feed }, responses: ok } } },
    components: { requestBodies: { Feed: { content: feed } } },
  });
  assert.deepEqual(found(document, 'no-request-item-schema'), [
    '/paths/~1upload/post/requestBody/content/application~1x-ndjson/itemSchema',
    '/components/requestBodies/Feed/content/application~1x-ndjson/itemSchema',
    '/webhooks/pushed/post/requestBody/content/application~1x-ndjson/itemSchema',
  ]);
});

test('spec-querystring-parameters checks the effective path and operation set in 3.2', () => {
  const form = { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } };
  const paths = {
    '/a': {
      parameters: [{ name: 'filter', in: 'querystring', content: form }],
      get: { parameters: [{ name: 'other', in: 'querystring', content: form }], responses: ok },
      put: { parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }], responses: ok },
      post: { parameters: [{ name: 'filter', in: 'querystring', content: form }], responses: ok },
    },
  };
  assert.deepEqual(found(documentBase('3.2.0', { paths }), 'spec-querystring-parameters'), [
    '/paths/~1a/get/parameters/0',
    '/paths/~1a/put/parameters/0',
  ]);
  assert.deepEqual(found(documentBase('3.1.0', { paths }), 'spec-querystring-parameters'), []);
});

test('spec-no-invalid-tag-parents reports unknown parents and cycles in 3.2', () => {
  const tags = [
    { name: 'a', parent: 'missing' },
    { name: 'b', parent: 'c' },
    { name: 'c', parent: 'b' },
    { name: 'd', parent: 'b' },
  ];
  assert.deepEqual(found(documentBase('3.2.0', { paths: {}, tags }), 'spec-no-invalid-tag-parents'), [
    '/tags/0/parent',
    '/tags/1/parent',
    '/tags/2/parent',
    '/tags/3/parent',
  ]);
});

test('spec-discriminator-defaultMapping in 3.2', () => {
  const document = documentBase('3.2.0', {
    paths: {},
    components: {
      schemas: {
        Cat: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
        Optional: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { type: 'object' }], discriminator: { propertyName: 'kind' } },
        Required: { oneOf: [{ $ref: '#/components/schemas/Cat' }], discriminator: { propertyName: 'kind' } },
        WithDefault: { oneOf: [{ type: 'object' }], discriminator: { propertyName: 'kind', defaultMapping: 'Cat' } },
        WithPointerDefault: { oneOf: [{ type: 'object' }], discriminator: { propertyName: 'kind', defaultMapping: '#/components/schemas/Cat' } },
        BadDefault: { oneOf: [{ type: 'object' }], discriminator: { propertyName: 'kind', defaultMapping: '#/components/schemas/Nope' } },
      },
    },
  });
  assert.deepEqual(found(document, 'spec-discriminator-defaultMapping'), [
    '/components/schemas/Optional/discriminator',
    '/components/schemas/BadDefault/discriminator/defaultMapping',
  ]);
});

test('spec-discriminator-defaultMapping follows a $ref chain before checking required', () => {
  const document = documentBase('3.2.0', {
    paths: {},
    components: {
      schemas: {
        Cat: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
        Alias: { $ref: '#/components/schemas/Cat' },
        ViaAlias: { oneOf: [{ $ref: '#/components/schemas/Alias' }], discriminator: { propertyName: 'kind' } },
      },
    },
  });
  assert.deepEqual(found(document, 'spec-discriminator-defaultMapping'), []);
});

test('spec-discriminator-defaultMapping follows an $anchor reference to the schema it names', () => {
  // protects: T-937 the rule followed only pointer and $id references, so a branch named by `#cat` was never judged
  const document = documentBase('3.2.0', {
    paths: {},
    components: {
      schemas: {
        Cat: { $anchor: 'cat', type: 'object', properties: { kind: { type: 'string' } } },
        Pet: { oneOf: [{ $ref: '#cat' }], discriminator: { propertyName: 'kind' } },
      },
    },
  });
  assert.deepEqual(found(document, 'spec-discriminator-defaultMapping'), ['/components/schemas/Pet/discriminator']);
});

test('spec-discriminator-defaultMapping reads the references of an embedded resource against that resource', () => {
  // protects: T-937 a `#/$defs/Base` inside an `$id` resource was read from the document root, found nothing and counted as required
  const document = documentBase('3.2.0', {
    paths: {},
    components: {
      schemas: {
        Cat: {
          $id: 'https://rules.example/cat',
          $defs: { Base: { type: 'object', properties: { kind: { type: 'string' } } } },
          allOf: [{ $ref: '#/$defs/Base' }],
        },
        Pet: { oneOf: [{ $ref: 'https://rules.example/cat' }], discriminator: { propertyName: 'kind' } },
      },
    },
  });
  assert.deepEqual(found(document, 'spec-discriminator-defaultMapping'), ['/components/schemas/Pet/discriminator']);
});

test('spec-discriminator-defaultMapping judges a schema shared by two oneOf branches in each branch', () => {
  // protects: T-491 a shared allOf member must not hide an optional discriminator property
  const document = documentBase('3.2.0', {
    paths: {},
    components: {
      schemas: {
        Common: { type: 'object', properties: { kind: { type: 'string' } } },
        Pet: {
          oneOf: [
            { allOf: [{ $ref: '#/components/schemas/Common' }, { required: ['kind'] }] },
            { allOf: [{ $ref: '#/components/schemas/Common' }] },
          ],
          discriminator: { propertyName: 'kind' },
        },
      },
    },
  });
  assert.deepEqual(found(document, 'spec-discriminator-defaultMapping'), ['/components/schemas/Pet/discriminator']);
});

test('no-unresolved-refs checks webhooks named example and examples', () => {
  // protects: T-491 a webhook name is not an OpenAPI literal key
  const hook = { post: { parameters: [{ $ref: '#/components/parameters/Missing' }], responses: ok } };
  const document = documentBase('3.1.0', { webhooks: { example: hook, examples: hook } });
  assert.deepEqual(found(document, 'no-unresolved-refs').sort(), [
    '/webhooks/example/post/parameters/0/$ref',
    '/webhooks/examples/post/parameters/0/$ref',
  ]);
});

test('rules skip an x- extension key under paths, and check a webhook named x-…', () => {
  const operation = { operationId: 'same', responses: ok };
  const document = documentBase('3.1.0', {
    paths: { '/a': { get: operation }, 'x-notes': { get: operation } },
    webhooks: { event: { post: { operationId: 'other', responses: ok } }, 'x-notes': { post: { operationId: 'other', responses: ok } } },
  });
  assert.deepEqual(found(document, 'operation-operationId-unique'), ['/webhooks/x-notes/post/operationId']);
});

test('no-unresolved-refs resolves "#/…" inside a schema with its own $id against that resource, then the document root', () => {
  const document = documentBase('3.1.0', {
    paths: {},
    components: {
      schemas: {
        Shared: { type: 'string' },
        Money: {
          $id: 'https://rules.example/money',
          type: 'object',
          properties: {
            amount: { type: 'number' },
            viaRoot: { $ref: '#/components/schemas/Shared' },
            viaResource: { $ref: '#/properties/amount' },
            viaNowhere: { $ref: '#/properties/nowhere' },
          },
        },
      },
    },
  });
  assert.deepEqual(found(document, 'no-unresolved-refs'), ['/components/schemas/Money/properties/viaNowhere/$ref']);
});

test('no-unresolved-refs reads "#/" as the key "" (RFC 6901), not as the whole resource', () => {
  const document = documentBase('3.1.0', {
    paths: {},
    components: {
      schemas: {
        Tree: { $id: 'https://rules.example/tree', type: 'object', properties: { whole: { $ref: '#' }, keyless: { $ref: '#/' } } },
      },
    },
  });
  assert.deepEqual(found(document, 'no-unresolved-refs'), ['/components/schemas/Tree/properties/keyless/$ref']);
});

test('no-unresolved-refs reports a discriminator mapping pointer that resolves to nothing', () => {
  const document = documentBase('3.1.0', {
    paths: {},
    components: {
      schemas: {
        Dog: { type: 'object' },
        Pet: {
          oneOf: [{ $ref: '#/components/schemas/Dog' }],
          discriminator: { propertyName: 'kind', mapping: { dog: '#/components/schemas/Dog', named: 'Dog', cat: '#/components/schemas/Cat' } },
        },
      },
    },
  });
  const problems = checkOpenApiRules(document).filter((problem) => problem.ruleId === 'no-unresolved-refs');
  assert.deepEqual(problems.map((problem) => [problem.pointer, problem.message]), [
    ['/components/schemas/Pet/discriminator/mapping/cat', "Can't resolve discriminator mapping #/components/schemas/Cat"],
  ]);
});

test('no-unresolved-refs reports a discriminator defaultMapping pointer that resolves to nothing', () => {
  const document = documentBase('3.2.0', {
    paths: {},
    components: {
      schemas: {
        Dog: { type: 'object' },
        Pet: {
          oneOf: [{ $ref: '#/components/schemas/Dog' }],
          discriminator: { propertyName: 'kind', defaultMapping: '#/components/schemas/Cat' },
        },
        Named: { oneOf: [{ $ref: '#/components/schemas/Dog' }], discriminator: { propertyName: 'kind', defaultMapping: 'Dog' } },
      },
    },
  });
  const problems = checkOpenApiRules(document).filter((problem) => problem.ruleId === 'no-unresolved-refs');
  assert.deepEqual(problems.map((problem) => [problem.pointer, problem.message]), [
    ['/components/schemas/Pet/discriminator/defaultMapping', "Can't resolve discriminator mapping #/components/schemas/Cat"],
  ]);
});
