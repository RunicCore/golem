import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind, IssueSource } from '@exprtlabs/codegen/errors';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { generate } from '#openapi/generator';
import {
  ALL_GENERATION_PROFILES,
  compileGeneratedSdk,
  documentBase,
  generateMaterializedSdk,
  isGeneratedClientClass,
  isGeneratedModelClass,
  materializeGeneratedSdk,
  requireRecord,
  writeOpenApiDocument,
} from './helpers.js';

test('generated SDK enforces conditional request and response schemas with runtime and standalone Ajv', async t => {
  for (const ajvStandalone of [false, true] as const) {
    const directory = createFixtureProject(t, 'runic-openapi-advanced-');
    const output = path.join(directory, 'sdk');
    const conditionalPayment = {
      type: 'object',
      required: ['state'],
      properties: {
        state: { enum: ['pending', 'settled'] },
        settledAt: { type: 'string' },
      },
      if: {
        properties: { state: { const: 'settled' } },
        required: ['state'],
      },
      then: { required: ['settledAt'] },
    };
    const document = documentBase('3.2.0', {
      paths: {
        '/payments': {
          post: {
            operationId: 'upsertPayment',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: conditionalPayment } },
            },
            responses: {
              200: {
                description: 'payment',
                content: { 'application/json': { schema: conditionalPayment } },
              },
            },
          },
        },
      },
    });
    await generateMaterializedSdk(document, {
      output,
      name: 'AdvancedConstraints',
      profile: { mobx: false, validation: true, ajvStandalone },
    });
    compileGeneratedSdk(output);
    const module = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
      'advanced constraints client',
    );
    const Client = module.AdvancedConstraintsClient;
    assert.equal(isGeneratedClientClass(Client), true);
    if (!isGeneratedClientClass(Client)) throw new TypeError('AdvancedConstraintsClient');

    let fetchCount = 0;
    let responseBody: unknown = { state: 'settled' };
    const client = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const api = client.upsertPayment();
    const invalidInput = { body: { state: 'settled' } };
    await assert.rejects(
      () => api.execute(invalidInput),
      (error: unknown) => error instanceof LibError
        && error.kind === LibErrorKind.Validation
        && error.issues.some(issue => issue.source === IssueSource.OpenAPI),
      'conditional request branch rejects a missing settledAt field',
    );
    assert.equal(fetchCount, 0, 'invalid conditional request did not reach fetch');

    const validInput = { body: { state: 'settled', settledAt: '2026-09-11' } };
    await assert.rejects(
      () => api.execute(validInput),
      (error: unknown) => error instanceof LibError
        && error.kind === LibErrorKind.Validation
        && error.issues.some(issue => issue.source === IssueSource.OpenAPI),
      'conditional response branch rejects a missing settledAt field',
    );
    assert.equal(fetchCount, 1, 'valid request reached fetch before response validation');

    responseBody = { state: 'settled', settledAt: '2026-09-11' };
    const response = await api.execute(validInput);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, responseBody);
    assert.equal(fetchCount, 2);
  }
});

async function publicBooleanSchemaCase(t: TestContext, openapi: string, nested: boolean, byRef: boolean): Promise<void> {
  for (const profile of ALL_GENERATION_PROFILES) {
    const directory = createFixtureProject(t, 'runic-openapi-r13-');
    const falseSchema = byRef ? { $ref: '#/components/schemas/Never' } : false;
    const extra: Record<string, unknown> = {
      paths: {
        '/values': {
          post: {
            operationId: 'putValue',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: nested ? { type: 'object', additionalProperties: falseSchema } : falseSchema,
                },
              },
            },
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': { schema: true },
                },
              },
            },
          },
        },
      },
    };
    if (byRef) {
      extra.components = { schemas: { Never: false } };
    }
    const input = writeOpenApiDocument(directory, documentBase(openapi, extra));
    const result = await generate({
      input,
      output: path.join(directory, 'sdk'),
      name: 'BooleanSchema',
      profile,
    });
    const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
    if (nested) {
      assert.match(types, /Record<string, never>/);
    } else {
      assert.match(types, /body: (never|InputSchemas\.Never)/);
    }
    assert.match(types, /body: unknown/);
    const output = path.join(directory, 'sdk');
    materializeGeneratedSdk(result.artifacts, output);
    compileGeneratedSdk(output);
    const compiled = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
      'boolean schema client',
    );
    assert.equal(isGeneratedClientClass(compiled.BooleanSchemaClient), true);
    if (!isGeneratedClientClass(compiled.BooleanSchemaClient)) throw new TypeError('BooleanSchemaClient');
    const BooleanSchemaClient = compiled.BooleanSchemaClient;
    if (profile.validation) {
      const client = new BooleanSchemaClient({
        baseUrl: 'https://api.example',
        fetchImpl: async () => new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      });
      await assert.rejects(() => client.putValue().execute({ body: nested ? { extra: 1 } : 1 }), /validation failed/);
    } else {
      const client = new BooleanSchemaClient({
        baseUrl: 'https://api.example',
        fetchImpl: async () => new Response('{"unexpected":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      });
      const response = await client.putValue().execute({ body: nested ? { extra: 1 } : 1 });
      assert.equal(response.status, 200);
    }
  }
}

test('public generation accepts OAS 3.1/3.2 boolean schemas in direct, nested, and $ref positions', async (t) => {
  for (const openapi of ['3.1.0', '3.2.0']) {
    await publicBooleanSchemaCase(t, openapi, false, false);
    await publicBooleanSchemaCase(t, openapi, true, false);
    await publicBooleanSchemaCase(t, openapi, false, true);
  }
});

test('schema-valued keywords true/false do not throw during public generation', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-r13-keywords-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/closed': {
        get: {
          operationId: 'closedList',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    prefixItems: [{ type: 'string' }],
                    items: false,
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Forbidden: { not: true },
      },
    },
  }));
  await assert.doesNotReject(() => generate({
    input,
    output: path.join(directory, 'sdk'),
    profile: { mobx: false, validation: false },
  }));
});

test('rejects OAS 3.0 and malformed or unresolved documents', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-r13-30-');
  const input = writeOpenApiDocument(directory, documentBase('3.0.3', {
    paths: {
      '/values': {
        post: {
          operationId: 'putValue',
          requestBody: {
            content: { 'application/json': { schema: false } },
          },
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  }));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile: { mobx: false, validation: false } }),
    /^Error: OpenAPI 3\.0 is not supported; convert the document to OpenAPI 3\.1 or 3\.2$/,
  );

  const malformed = createFixtureProject(t, 'runic-openapi-r13-malformed-');
  const malformedInput = writeOpenApiDocument(malformed, { openapi: '3.1.0', paths: {} });
  await assert.rejects(
    () => generate({
      input: malformedInput,
      output: path.join(malformed, 'sdk'),
      profile: { mobx: false, validation: false },
    }),
    /OpenAPI validation failed/,
  );

  const unresolved = createFixtureProject(t, 'runic-openapi-r13-ref-');
  const unresolvedInput = writeOpenApiDocument(unresolved, documentBase('3.1.0', {
    paths: {
      '/values': {
        get: {
          operationId: 'getValue',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } },
            },
          },
        },
      },
    },
  }));
  await assert.rejects(
    () => generate({
      input: unresolvedInput,
      output: path.join(unresolved, 'sdk'),
      profile: { mobx: false, validation: false },
    }),
    /^Error: OpenAPI validation failed with 1 error\(s\):\nno-unresolved-refs: Can't resolve \$ref #\/components\/schemas\/Missing \(openapi\.json#\/paths\/~1values\/get\/responses\/200\/content\/application~1json\/schema\/\$ref\)$/,
  );
});

test('nullable binary response decodes to Blob or null and both pass runtime validation', async (t) => {
  const output = path.join(createFixtureProject(t, 'runic-openapi-r14-'), 'sdk');
  const document = documentBase('3.1.0', {
    paths: {
      '/file': {
        get: {
          operationId: 'getFile',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/octet-stream': {
                  schema: { type: ['string', 'null'], format: 'binary' },
                },
              },
            },
          },
        },
      },
    },
  });
  await generateMaterializedSdk(document, { output, name: 'NullableBinary', profile: { mobx: false, validation: true } });
  const typeAssertion = path.join(output, 'nullable-binary-assert.ts');
  writeFileSync(typeAssertion, [
    "import type * as Types from './types.js';",
    'const body: Types.GetFileOperationSuccessBody = null;',
    'const narrowed: Blob | null = body;',
    'void body; void narrowed;',
  ].join('\n'));
  compileGeneratedSdk(output, [typeAssertion], { strict: true });

  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'nullable binary client',
  );
  const Client = module.NullableBinaryClient;
  if (!isGeneratedClientClass(Client)) throw new TypeError('NullableBinaryClient');

  const bytesClient = new Client({
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
  });
  const bytesResponse = await bytesClient.getFile().execute({});
  assert.ok(bytesResponse.body instanceof Blob);
  if (!(bytesResponse.body instanceof Blob)) throw new TypeError('decoded blob');
  assert.equal(bytesResponse.body.size, 3);

  const nullClient = new Client({
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(new Uint8Array([9]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
    responseDecoders: { 'application/octet-stream': () => null },
  });
  const nullResponse = await nullClient.getFile().execute({});
  assert.equal(nullResponse.body, null);
});

test('an allOf alias of one model is its own model with its own codec', async t => {
  for (const profile of [{ mobx: false, validation: false }, { mobx: false, validation: true }]) {
    const directory = createFixtureProject(t, 'runic-openapi-allof-alias-');
    const output = path.join(directory, 'sdk');
    const suffix = profile.validation ? 'V' : 'N';
    await generateMaterializedSdk(documentBase('3.1.0', {
      paths: {},
      components: {
        schemas: {
          [`Money${suffix}`]: {
            type: 'object',
            additionalProperties: false,
            required: ['amount'],
            properties: { amount: { type: 'number' } },
          },
          [`Price${suffix}`]: { allOf: [{ $ref: `#/components/schemas/Money${suffix}` }] },
        },
      },
    }), { output, name: 'Alias', profile });
    compileGeneratedSdk(output, [], { strict: true });
    const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/models.js')).href), 'alias models');
    const PriceModel = models[`Price${suffix}Model`];
    const MoneyModel = models[`Money${suffix}Model`];
    const parsePrice = models[`parsePrice${suffix}`];
    const stringifyPrice = models[`stringifyPrice${suffix}`];
    if (!isGeneratedModelClass(PriceModel) || !isGeneratedModelClass(MoneyModel)) throw new TypeError('alias model classes');
    if (typeof parsePrice !== 'function' || typeof stringifyPrice !== 'function') throw new TypeError('alias codec functions');
    const price = decodeGeneratedModel(PriceModel, { amount: 3 });
    assert.ok(price instanceof PriceModel && price instanceof MoneyModel);
    assert.deepEqual(encodeGeneratedModel(price), { amount: 3 });
    // The alias owns a registered codec, like its base: parse yields wire data.
    assert.deepEqual({ ...requireRecord(Reflect.apply(parsePrice, undefined, ['{"amount":4}']), 'parsed price') }, { amount: 4 });
    assert.equal(Reflect.apply(stringifyPrice, undefined, [price]), '{"amount":3}');
    // The alias treats undeclared members exactly as its closed base does.
    const stringifyMoney = models[`stringifyMoney${suffix}`];
    if (typeof stringifyMoney !== 'function') throw new TypeError('base codec function');
    const extra = { amount: 1, extra: 2 };
    const outcome = (run: () => unknown): unknown => {
      try { return { value: run() }; } catch (error) { return { error: error instanceof Error ? error.constructor.name : 'thrown' }; }
    };
    assert.deepEqual(
      outcome(() => encodeGeneratedModel(decodeGeneratedModel(PriceModel, extra))),
      outcome(() => encodeGeneratedModel(decodeGeneratedModel(MoneyModel, extra))),
    );
    assert.deepEqual(
      outcome(() => Reflect.apply(stringifyPrice, undefined, [extra])),
      outcome(() => Reflect.apply(stringifyMoney, undefined, [extra])),
    );
  }
});

