import { copyFixture, copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, readGeneratedModelSource } from './helpers.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind, IssueSource } from '@exprtlabs/golem/errors';
import type { GeneratedModel } from '@exprtlabs/golem/model';
import { generatedCodecId } from '../support/consumer.js';
import {
  findRemoteRefs,
  loadValidatedDocument,
  normalizeDocument,
  schemaType,
  validate,
  writeSdk as writeSdkFiles,
} from '#openapi/generator';
import {
  captureRequest,
  isAsyncIterable,
  isGeneratedClientClass,
  isGeneratedModelClass,
  openApiFixture,
  requireRecord,
  tscBin,
  writeGeneratedSdk,
  type CapturedRequest,
} from './helpers.js';

const example = openApiFixture('example.openapi.yaml');

function generated<Model extends object>(model: Model): Model & GeneratedModel<unknown> {
  return model as Model & GeneratedModel<unknown>;
}

function writeSdk(document: unknown, options: { output: string; name?: string; profile?: { mobx: boolean; validation: boolean }; check?: boolean }) {
  return writeGeneratedSdk(writeSdkFiles, document, options);
}

test('validate() version and root rules', () => {
  for (const openapi of ['3.1.0', '3.1.2', '3.2.0']) {
    assert.doesNotThrow(() => validate({
      openapi,
      info: { title: 'Fixture', version: '1' },
      components: {},
    }));
  }
  for (const openapi of ['3.0.0', '3.0.4']) {
    assert.throws(
      () => validate({ openapi, info: { title: 'Fixture', version: '1' }, components: {} }),
      /^Error: OpenAPI 3\.0 is not supported; convert the document to OpenAPI 3\.1 or 3\.2$/,
    );
  }
  assert.throws(() => validate({ openapi: '2.0', paths: {} }), /unsupported OpenAPI version/);
  assert.throws(
    () => validate({ openapi: '3.2.0', info: { title: 'Fixture', version: '1' } }),
    /at least one of paths, components, or webhooks/,
  );
});

test('finds remote references with a precise JSON Pointer', () => {
  assert.deepEqual(findRemoteRefs({
    components: {
      schemas: {
        Money: { $ref: 'https://schemas.example/money.json' },
      },
    },
  }), [{
    ref: 'https://schemas.example/money.json',
    pointer: '#/components/schemas/Money/$ref',
  }]);
});

test('bundles local multi-document references', async (t) => {
  const directory = createFixtureProject(t, 'golem-openapi-local-ref-');
  copyFixture(directory, 'openapi/conformance/local-reference');
  const filename = path.join(directory, 'openapi.yaml');
  const document = await loadValidatedDocument(filename, {});
  const schemas = requireRecord(requireRecord(requireRecord(document, 'document').components, 'components').schemas, 'schemas');
  // A root component that only aliases an external file takes that file's content under its own name.
  assert.deepEqual(Object.keys(schemas), ['Money']);
  const money = requireRecord(schemas.Money, 'Money');
  assert.equal(money.$ref, undefined);
  assert.equal(money.type, 'object');
  assert.equal(requireRecord(requireRecord(money.properties, 'properties').currency, 'currency').type, 'string');
});

test('models OpenAPI 3.1 type unions', () => {
  // `nullable` is not a 3.1 keyword; null comes only from `type`.
  assert.equal(schemaType({ type: 'string', nullable: true }, { document: { openapi: '3.1.0' } }), 'string');
  assert.equal(schemaType({ type: ['string', 'null'] }), 'string | null');
  assert.equal(schemaType(true), 'unknown');
  assert.equal(schemaType(false), 'never');
  assert.equal(schemaType({ type: ['string', 'number'] }), 'string | number');
  // Members are parenthesized only where precedence needs it, and repeated members collapse.
  assert.equal(schemaType({ allOf: [{ type: 'number' }, { type: 'number' }] }), 'number');
  assert.equal(schemaType({ type: 'number', allOf: [{ type: 'number', minimum: 0 }] }), 'number');
  assert.equal(schemaType({ allOf: [{ type: ['string', 'number'] }, { type: 'string' }] }), '(string | number) & string');
  assert.equal(schemaType({ type: 'array', items: { enum: ['a', 'b'] } }), '("a" | "b")[]');
  assert.equal(
    schemaType({ type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } }),
    '{\n  inner?: {\n    x: string;\n  };\n}',
  );
  assert.equal(schemaType({ type: 'string', not: true }), 'never');
  assert.equal(
    schemaType({
      enum: ['pending', 'settled', 'failed'],
      not: { enum: ['failed'] },
    }),
    '"pending" | "settled"',
  );
  assert.equal(
    schemaType({ enum: ['pending'], not: { const: 'pending' } }),
    'never',
  );
  assert.equal(schemaType({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: false,
  }), '[] | [string] | [string, number]');
  assert.equal(schemaType({
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      enabled: { type: 'boolean' },
    },
    additionalProperties: { type: 'number' },
  }), `{
  id: string;
  enabled?: boolean;
  [key: string]: number | string | boolean | undefined;
}`);
  const directional = {
    type: 'object',
    required: ['id', 'secret', 'serverValue'],
    properties: {
      id: { type: 'string' },
      secret: { type: 'string', writeOnly: true },
      serverValue: { type: 'string', readOnly: true },
    },
  };
  assert.equal(schemaType(directional, { direction: 'input' }), `{
  id: string;
  secret: string;
}`);
  assert.equal(schemaType(directional, { direction: 'output' }), `{
  id: string;
  serverValue: string;
}`);
  assert.equal(
    schemaType(
      { $ref: '#/components/schemas/Credentials' },
      { direction: 'input', qualifier: 'InputSchemas.' },
    ),
    'InputSchemas.Credentials',
  );
});

test('OpenAPI 3.2 QUERY and additional operations preserve wire methods', () => {
  const ir = normalizeDocument({
    openapi: '3.2.0',
    info: { title: 'Methods', version: '1' },
    paths: {
      '/documents': {
        query: {
          operationId: 'searchDocuments',
          responses: { 200: { description: 'ok' } },
        },
        additionalOperations: {
          COPY: {
            operationId: 'copyDocuments',
            responses: { 202: { description: 'accepted' } },
          },
          'Vendor-METHOD': {
            operationId: 'vendorMethod',
            responses: { 204: { description: 'done' } },
          },
        },
      },
    },
  });
  assert.deepEqual(
    ir.operations.map(({ name, method }) => ({ name, method })),
    [
      { name: 'searchDocuments', method: 'QUERY' },
      { name: 'copyDocuments', method: 'COPY' },
      { name: 'vendorMethod', method: 'Vendor-METHOD' },
    ],
  );
});

test('complex example projects polymorphic nested models and exact HTTP contracts', async (t) => {
  const document = await loadValidatedDocument(
    openApiFixture('complex-openapi.yaml'),
    {},
  );
  const output = createFixtureProject(t, 'golem-openapi-complex-');
  writeSdk(document, { output, name: 'MerchantPayments' });

  const assertFile = copyFixtureFile(output, 'openapi/conformance/complex-response-assert.ts', 'complex-response-assert.ts');
  compileGeneratedSdk(output, [assertFile], { strict: true });
});

test('OpenAPI 3.1 generation preserves its dialect', async (t) => {
  const document = {
    openapi: '3.1.2',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'OAS 31', version: '1' },
    paths: {
      '/values': {
        get: {
          operationId: 'getValues',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Value' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Value: {
          type: 'object',
          properties: {
            value: { type: ['string', 'null'] },
          },
          unevaluatedProperties: false,
        },
      },
    },
  };
  const output = createFixtureProject(t, 'golem-openapi-31-');
  writeGeneratedSdk(writeSdk, document, { output, name: 'Oas31', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module = requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), 'oas31 client');
  const Client = module.Oas31Client;
  if (!isGeneratedClientClass(Client)) throw new TypeError('Oas31Client');
  const respond = (body: unknown) => new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => Response.json(body),
  });
  // 2020-12 dialect behavior: unevaluatedProperties rejects a property no keyword evaluated.
  await assert.doesNotReject(() => respond({ value: null }).getValues().execute({}));
  await assert.rejects(() => respond({ value: 'x', extra: 1 }).getValues().execute({}), /validation failed/i);
});

test('component-root dynamic anchors retain their local recursive scope', (t) => {
  const recursiveObject = (valueType: string) => ({
    $dynamicAnchor: 'node',
    type: 'object',
    properties: {
      value: { type: valueType },
      children: {
        type: 'array',
        items: { $dynamicRef: '#node' },
      },
    },
  });
  const document = {
    openapi: '3.1.2',
    info: { title: 'Recursive anchors', version: '1' },
    paths: {},
    components: {
      schemas: {
        StringTree: recursiveObject('string'),
        NumberTree: recursiveObject('number'),
      },
    },
  };
  const output = createFixtureProject(t, 'golem-openapi-dynamic-anchor-');
  writeSdk(document, { output, name: 'RecursiveAnchors' });
  const types = fs.readFileSync(path.join(output, 'types.ts'), 'utf8');
  const models = readGeneratedModelSource(output);
  const stringType = types.split('export type StringTree = ')[1].split('export type ')[0];
  const numberType = types.split('export type NumberTree = ')[1].split('export type ')[0];
  const stringModel = models.split('export class StringTreeModel')[1].split('export class ')[0];
  const numberModel = models.split('export class NumberTreeModel')[1].split('export class ')[0];
  assert.match(stringType, /children\?: StringTree\[\]/);
  assert.match(numberType, /children\?: NumberTree\[\]/);
  assert.match(stringModel, /children\?: Array<StringTreeModel>/);
  assert.match(numberModel, /children\?: Array<NumberTreeModel>/);
});

test('generates inheritable object models with serde conversion metadata', async (t) => {
  const document = {
    openapi: '3.2.0',
    info: { title: 'Models', version: '1' },
    components: {
      schemas: {
        BasePayment: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'integer' } },
        },
        Payment: {
          allOf: [
            { $ref: '#/components/schemas/BasePayment' },
            {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, note: { type: 'string' } },
            },
          ],
        },
        Metadata: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
  };
  const output = createFixtureProject(t, 'golem-openapi-models-');
  writeSdk(document, { output, name: 'Models' });
  const models = readGeneratedModelSource(output);
  assert.match(models, /class PaymentModel extends BasePaymentModel/);
  assert.match(models, /class MetadataModel \{[\s\S]*Dynamic map values are preserved during conversion/);
  assert.match(models, /generatedModelFieldsBrand/);
  assert.match(models, /asGenObservable\(this\)/);

  copyFixtureFile(output, "openapi/conformance/consumer.ts", "consumer.ts");
  const compiled = spawnSync(process.execPath, [tscBin(), 
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable',
    '--outDir', path.join(output, 'dist'),
    path.join(output, 'consumer.ts'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

  const modelExports = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'models',
  );
  const BasePaymentModel = modelExports.BasePaymentModel;
  const MetadataModel = modelExports.MetadataModel;
  const PaymentModel = modelExports.PaymentModel;
  assert.equal(isGeneratedModelClass(BasePaymentModel), true);
  assert.equal(isGeneratedModelClass(MetadataModel), true);
  assert.equal(isGeneratedModelClass(PaymentModel), true);
  if (!isGeneratedModelClass(BasePaymentModel) || !isGeneratedModelClass(MetadataModel) || !isGeneratedModelClass(PaymentModel)) {
    throw new TypeError('expected generated model classes');
  }
  const payment = decodeGeneratedModel(PaymentModel, { amount: 125, id: 'pay_7', note: 'memo' });
  assert.ok(payment instanceof BasePaymentModel);
  assert.deepEqual(encodeGeneratedModel(generated(payment)), { amount: 125, id: 'pay_7', note: 'memo' });
  assert.throws(() => requireObjectCodec(generatedCodecId(models, 'Payment')).assert( ['not', 'an', 'object']), /validation|deserial/i);
  assert.deepEqual(encodeGeneratedModel(generated(decodeGeneratedModel(MetadataModel, { traceId: 'trace_7' }))), { traceId: 'trace_7' });
});

test('normalizes callbacks and webhooks into typed inbound contracts', (t) => {
  const document = {
    openapi: '3.2.0',
    info: { title: 'Inbound', version: '1' },
    paths: {
      '/subscriptions': {
        post: {
          operationId: 'createSubscription',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['callbackUrl'],
                  properties: { callbackUrl: { type: 'string', format: 'uri' } },
                },
              },
            },
          },
          callbacks: {
            onStatus: {
              '{$request.body#/callbackUrl}': {
                post: {
                  operationId: 'receiveStatus',
                  requestBody: {
                    required: true,
                    content: {
                      'application/json': {
                        schema: { $ref: '#/components/schemas/StatusEvent' },
                      },
                    },
                  },
                  responses: { 204: { description: 'accepted' } },
                },
              },
            },
          },
          responses: { 201: { description: 'created' } },
        },
      },
    },
    webhooks: {
      paymentSettled: {
        post: {
          operationId: 'receiveSettlement',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/StatusEvent' },
              },
            },
          },
          responses: { 204: { description: 'accepted' } },
        },
      },
    },
    components: {
      schemas: {
        StatusEvent: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string' } },
        },
      },
    },
  };
  const ir = normalizeDocument(document);
  assert.equal(ir.operations.length, 1);
  assert.equal(ir.inboundOperations.length, 2);
  assert.deepEqual(
    ir.inboundOperations.map(({ sourceKind, method }) => ({ sourceKind, method })),
    [{ sourceKind: 'webhook', method: 'POST' }, { sourceKind: 'callback', method: 'POST' }],
  );

  const output = createFixtureProject(t, 'golem-openapi-inbound-');
  writeSdk(document, { output, name: 'Inbound' });
  const inbound = fs.readFileSync(path.join(output, 'inbound.ts'), 'utf8');
  assert.match(inbound, /interface InboundInboundPort/);
  assert.match(inbound, /webhook paymentSettled: POST paymentSettled/);
  assert.match(inbound, /callback createSubscription onStatus: POST/);
  assert.match(inbound, /OperationInput/);

  copyFixtureFile(output, 'openapi/conformance/inbound-assert.ts', 'inbound-assert.ts');
  const compiled = spawnSync(process.execPath, [tscBin(),
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable',
    '--noEmit',
    path.join(output, 'index.ts'),
    path.join(output, 'inbound-assert.ts'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
});

test('generation is deterministic', async (t) => {
  const document = await loadValidatedDocument(example, {});
  const output = createFixtureProject(t, 'golem-openapi-test-');
  const profile = { mobx: true, validation: true };
  const first = writeSdkFiles(document, { output, name: 'ExamplePayments', profile });
  const second = writeSdkFiles(document, { output, name: 'ExamplePayments', profile });
  assert.deepEqual(second.artifacts, first.artifacts, 'repeated generation from the same document produces identical artifacts');
  writeSdk(document, { output, name: 'ExamplePayments' });
  assert.ok(fs.existsSync(path.join(output, 'validators.generated.ts')));
  assert.ok(fs.existsSync(path.join(output, 'input-schemas.ts')));
  assert.ok(fs.existsSync(path.join(output, 'output-schemas.ts')));
  const manifestText = fs.readFileSync(path.join(output, 'model-manifest.json'), 'utf8');
  const manifest = requireRecord(JSON.parse(manifestText), 'manifest');
  assert.equal(Object.hasOwn(manifest, 'manifestVersion'), false);
  assert.deepEqual(manifest.profile, { mobx: true, validation: true, allowAny: false, unknownFormats: 'error' });
  const source = requireRecord(manifest.source, 'source');
  assert.equal(source.dialect, requireRecord(document, 'document').openapi);
  assert.match(String(source.digest), /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.models));
  assert.ok(manifest.models.every((model: unknown) => {
    if (typeof model !== 'object' || model === null) return false;
    const record = requireRecord(model, 'model');
    const type = requireRecord(record.type, 'type');
    const generated = requireRecord(record.generated, 'generated');
    return record.sourceKind === 'openapi'
      && !Object.hasOwn(record, 'validation')
      && type.module === './types.ts'
      && generated.module === `./models/${String(type.export)}.ts`
      && generated.export === `${String(type.export)}Model`
      && fs.existsSync(path.join(output, String(generated.module)));
  }));
  assert.match(
    fs.readFileSync(path.join(output, 'types.ts'), 'utf8'),
    /@golem-model-manifest \.\/model-manifest\.json/,
  );
});

function wireAuthDocument() {
  return {
    openapi: '3.1.0',
    info: { title: 'Wire', version: '1' },
    security: [{ apiKey: [] }],
    paths: {
      '/forms/{id}': {
        post: {
          operationId: 'submitForm',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  required: ['amount'],
                  properties: {
                    amount: { type: 'integer' },
                    memo: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    filters: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                    redirect: { type: 'string' },
                  },
                },
                encoding: {
                  tags: { style: 'form', explode: false },
                  filters: { style: 'form', explode: true },
                  redirect: { allowReserved: true },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/secure': {
        get: {
          operationId: 'secure',
          security: [{ oauth: ['payments:read'], mtls: [] }],
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/oidc': {
        get: {
          operationId: 'openIdProfile',
          security: [{ oidc: ['openid', 'profile'] }],
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/money/{id}': {
        post: {
          operationId: 'putMoney',
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^pay_[0-9]+$' },
          }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Money' } },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Money' } },
              },
            },
          },
        },
      },
      '/xml': {
        post: {
          operationId: 'xmlRoundTrip',
          requestBody: {
            required: true,
            content: {
              'application/xml': {
                schema: {
                  type: 'object',
                  required: ['value'],
                  properties: { value: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              headers: {
                'X-Rate': { schema: { type: 'integer' } },
                'X-Flags': {
                  schema: { type: 'array', items: { type: 'boolean' } },
                },
                'X-Meta': {
                  explode: true,
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      active: { type: 'boolean' },
                    },
                  },
                },
                'X-Envelope': {
                  content: {
                    'application/xml': {
                      schema: {
                        type: 'object',
                        required: ['value'],
                        properties: { value: { type: 'string' } },
                      },
                    },
                  },
                },
              },
              content: {
                'application/xml': {
                  schema: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { type: 'string' } },
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
        Money: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'integer', minimum: 1 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
          additionalProperties: false,
        },
      },
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'query', name: 'key' },
        oauth: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://identity.example/token',
              scopes: {
                'payments:read': 'Read payments',
                'payments:write': 'Write payments',
              },
            },
          },
        },
        oidc: {
          type: 'openIdConnect',
          openIdConnectUrl: 'https://identity.example/.well-known/openid-configuration',
        },
        mtls: { type: 'mutualTLS' },
      },
    },
  };
}

let wireClient: ReturnType<typeof generateWireClient> | undefined;
const wireClientRoots: string[] = [];
after(() => {
  for (const root of wireClientRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Generate and compile the Wire SDK against `wireAuthDocument()` once; the wire tests share its client class. */
function compileWireClient() {
  wireClient ??= generateWireClient();
  return wireClient;
}

async function generateWireClient() {
  const document = wireAuthDocument();
  const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-openapi-wire-')));
  wireClientRoots.push(output);
  writeSdk(document, { output, name: 'Wire' });
  copyFixtureFile(output, "openapi/conformance/auth-type-test.ts", "auth-type-test.ts");
  const compiled = spawnSync(process.execPath, [tscBin(),
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable',
    '--outDir', path.join(output, 'dist'),
    path.join(output, 'index.ts'),
    path.join(output, 'auth-type-test.ts'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const clientModule = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'client',
  );
  assert.equal(isGeneratedClientClass(clientModule.WireClient), true);
  if (!isGeneratedClientClass(clientModule.WireClient)) throw new TypeError('WireClient');
  return clientModule.WireClient;
}

test('generated client serializes path, repeated query, form body and API-key auth', async () => {
  const WireClient = await compileWireClient();
  let request: CapturedRequest | undefined;
  const client = new WireClient({
    baseUrl: 'https://api.example',
    auth: { apiKey: 'secret' },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      request = captureRequest(url, init);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const controller = new AbortController();
  await client.submitForm().execute({
    path: { id: 'a/b' },
    query: { tag: ['one', 'two'] },
    body: {
      amount: 125,
      memo: 'invoice 7',
      tags: ['urgent', 'merchant'],
      filters: { state: 'settled', rail: 'NPS' },
      redirect: 'https://merchant.example/payments/7',
    },
  }, { signal: controller.signal });
  assert.ok(request);
  assert.equal(request.url, 'https://api.example/forms/a%2Fb?tag=one&tag=two&key=secret');
  assert.equal(request.init.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(
    String(request.init.body),
    'amount=125&memo=invoice%207&tags=urgent,merchant&state=settled&rail=NPS&redirect=https://merchant.example/payments/7',
  );
  assert.equal(request.init.signal, controller.signal);

  // OAuth/OIDC, mTLS, XML and undeclared-response handling on the same Wire client.
  {
    let request: CapturedRequest | undefined;
    const authContexts: unknown[] = [];
    const responseHeaderContexts: unknown[] = [];
    let mutualTlsFetchCount = 0;
    const mutualTlsFetch = async (url: string | URL | Request, init?: RequestInit) => {
      mutualTlsFetchCount += 1;
      request = captureRequest(url, init);
      if (new URL(String(url)).pathname === '/xml') {
        return new Response('<value>decoded</value>', {
          status: 200,
          headers: {
            'content-type': 'application/xml; charset=utf-8',
            'X-Rate': '25',
            'X-Flags': 'true,false',
            'X-Meta': 'count=3,active=true',
            'X-Envelope': '<value>header</value>',
          },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new WireClient({
      baseUrl: 'https://api.example',
      auth: {
        apiKey: 'secret',
        oauth: (context: unknown) => {
          authContexts.push(context);
          return 'oauth-token';
        },
        oidc: (context: unknown) => {
          authContexts.push(context);
          return 'oidc-token';
        },
      },
      mutualTls: { fetchImpl: mutualTlsFetch },
      bodyEncoders: {
        'application/xml': (value: { value: string }) => `<value>${value.value}</value>`,
      },
      responseDecoders: {
        'application/xml': async (response: Response) => ({
          value: (await response.text()).replace(/^<value>|<\/value>$/g, ''),
        }),
      },
      responseHeaderDecoders: {
        'application/xml': (value: string, context: unknown) => {
          responseHeaderContexts.push(context);
          return { value: value.replace(/^<value>|<\/value>$/g, '') };
        },
      },
      fetchImpl: async () => {
        throw new Error('fallback fetch must not be used when mutualTLS is configured');
      },
    });
    await client.secure().execute({});
    assert.ok(request);
    assert.equal(request.url, 'https://api.example/secure');
    assert.equal(request.init.headers.get('authorization'), 'Bearer oauth-token');
    await client.openIdProfile().execute({});
    assert.ok(request);
    assert.equal(request.url, 'https://api.example/oidc');
    assert.equal(request.init.headers.get('authorization'), 'Bearer oidc-token');
    assert.deepEqual(authContexts, [
      {
        scheme: 'oauth',
        type: 'oauth2',
        scopes: ['payments:read'],
        flows: {
          clientCredentials: {
            tokenUrl: 'https://identity.example/token',
            scopes: {
              'payments:read': 'Read payments',
              'payments:write': 'Write payments',
            },
          },
        },
        openIdConnectUrl: undefined,
      },
      {
        scheme: 'oidc',
        type: 'openIdConnect',
        scopes: ['openid', 'profile'],
        flows: undefined,
        openIdConnectUrl: 'https://identity.example/.well-known/openid-configuration',
      },
    ]);
    const xml = await client.xmlRoundTrip().execute({ body: { value: 'encoded' } });
    assert.ok(request);
    assert.equal(request.init.headers.get('content-type'), 'application/xml');
    assert.equal(request.init.body, '<value>encoded</value>');
    assert.equal(xml.status, 200);
    assert.deepEqual(xml.body, { value: 'decoded' });
    assert.deepEqual(xml.headers, {
      'X-Rate': 25,
      'X-Flags': [true, false],
      'X-Meta': { count: 3, active: true },
      'X-Envelope': { value: 'header' },
    });
    assert.deepEqual(responseHeaderContexts, [{
      operation: 'xmlRoundTrip',
      name: 'X-Envelope',
      contentType: 'application/xml',
    }]);
    assert.equal(mutualTlsFetchCount, 3);

    const missingHeaderDecoderClient = new WireClient({
      baseUrl: 'https://api.example',
      auth: { apiKey: 'secret' },
      fetchImpl: async () => new Response('<value>decoded</value>', {
        status: 200,
        headers: {
          'content-type': 'application/xml',
          'X-Envelope': '<value>header</value>',
        },
      }),
      bodyEncoders: { 'application/xml': () => '<value>encoded</value>' },
      responseDecoders: {
        'application/xml': async () => ({ value: 'decoded' }),
      },
    });
    await assert.rejects(
      () => missingHeaderDecoderClient.xmlRoundTrip().execute({ body: { value: 'encoded' } }),
      /No response header decoder configured/,
    );

    let insecureFetchCalled = false;
    const missingMutualTlsClient = new WireClient({
      baseUrl: 'https://api.example',
      auth: { oauth: 'oauth-token' },
      fetchImpl: async () => {
        insecureFetchCalled = true;
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await assert.rejects(
      () => missingMutualTlsClient.secure().execute({}),
      /No configured credentials satisfy/,
    );
    assert.equal(insecureFetchCalled, false);

    const undeclaredClient = new WireClient({
      baseUrl: 'https://api.example',
      auth: { apiKey: 'secret' },
      fetchImpl: async () => new Response('{}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      () => undeclaredClient.submitForm().execute({
        path: { id: 'pay_1' },
        body: { amount: 1 },
      }),
      /Undeclared OpenAPI response/,
    );
  }

  // Operation validators and the client enforce request/response schema constraints at runtime.
  {
    let fetchCount = 0;
    let responseBody = { amount: 0, currency: 'vnd' };
    const client = new WireClient({
      baseUrl: 'https://api.example',
      auth: { apiKey: 'secret' },
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await assert.rejects(
      () => client.putMoney().execute({
        path: { id: 'invalid' },
        body: { amount: 0, currency: 'vnd' },
      }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.issues.some(issue => issue.source === IssueSource.OpenAPI),
    );
    assert.equal(fetchCount, 0);
    await assert.rejects(
      () => client.putMoney().execute({
        path: { id: 'pay_7' },
        body: { amount: 25, currency: 'VND' },
      }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.issues.some(issue => issue.source === IssueSource.OpenAPI),
    );
    assert.equal(fetchCount, 1);
    responseBody = { amount: 25, currency: 'VND' };
    const putMoneyResponse = await client.putMoney().execute({
      path: { id: 'pay_7' },
      body: { amount: 25, currency: 'VND' },
    });
    assert.equal(putMoneyResponse.status, 200);
    assert.deepEqual(putMoneyResponse.body, responseBody);
    assert.equal(fetchCount, 2);
  }
});

test('generated client implements path and query style/explode serialization', async (t) => {
  const ok = {
    200: {
      description: 'ok',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
  };
  const document = {
    openapi: '3.2.0',
    info: { title: 'Styles', version: '1' },
    paths: {
      '/simple/{array}/{objectFlat}/{objectExplode}': {
        get: {
          operationId: 'simple',
          parameters: [
            {
              name: 'array',
              in: 'path',
              required: true,
              style: 'simple',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'objectFlat',
              in: 'path',
              required: true,
              style: 'simple',
              explode: false,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
            {
              name: 'objectExplode',
              in: 'path',
              required: true,
              style: 'simple',
              explode: true,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
          ],
          responses: ok,
        },
      },
      '/label/{value}': {
        get: {
          operationId: 'label',
          parameters: [{
            name: 'value',
            in: 'path',
            required: true,
            style: 'label',
            explode: true,
            schema: { type: 'array', items: { type: 'string' } },
          }],
          responses: ok,
        },
      },
      '/label-flat/{array}/{object}': {
        get: {
          operationId: 'labelFlat',
          parameters: [
            {
              name: 'array',
              in: 'path',
              required: true,
              style: 'label',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'object',
              in: 'path',
              required: true,
              style: 'label',
              explode: false,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
          ],
          responses: ok,
        },
      },
      '/matrix/{value}': {
        get: {
          operationId: 'matrix',
          parameters: [{
            name: 'value',
            in: 'path',
            required: true,
            style: 'matrix',
            explode: true,
            schema: {
              type: 'object',
              properties: { role: { type: 'string' }, first: { type: 'string' } },
            },
          }],
          responses: ok,
        },
      },
      '/matrix-flat/{array}/{object}': {
        get: {
          operationId: 'matrixFlat',
          parameters: [
            {
              name: 'array',
              in: 'path',
              required: true,
              style: 'matrix',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'object',
              in: 'path',
              required: true,
              style: 'matrix',
              explode: false,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
          ],
          responses: ok,
        },
      },
      '/query': {
        get: {
          operationId: 'queryStyles',
          parameters: [
            {
              name: 'filter',
              in: 'query',
              style: 'deepObject',
              explode: true,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
            {
              name: 'colors',
              in: 'query',
              style: 'pipeDelimited',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'point',
              in: 'query',
              style: 'form',
              explode: false,
              schema: {
                type: 'object',
                properties: { x: { type: 'integer' }, y: { type: 'integer' } },
              },
            },
            {
              name: 'tags',
              in: 'query',
              style: 'form',
              explode: true,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'compactTags',
              in: 'query',
              style: 'form',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'dimensions',
              in: 'query',
              style: 'form',
              explode: true,
              schema: { type: 'object', additionalProperties: { type: 'integer' } },
            },
            {
              name: 'words',
              in: 'query',
              style: 'spaceDelimited',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'criteria',
              in: 'query',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['active'],
                    properties: { active: { type: 'boolean' } },
                  },
                },
              },
            },
          ],
          responses: ok,
        },
      },
      '/header': {
        get: {
          operationId: 'headerStyles',
          parameters: [
            {
              name: 'X-Array',
              in: 'header',
              style: 'simple',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'X-Object-Flat',
              in: 'header',
              style: 'simple',
              explode: false,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
            {
              name: 'X-Object-Explode',
              in: 'header',
              style: 'simple',
              explode: true,
              schema: { type: 'object', additionalProperties: { type: 'string' } },
            },
          ],
          responses: ok,
        },
      },
      '/content/{pathValue}': {
        get: {
          operationId: 'contentParameters',
          parameters: [
            {
              name: 'pathValue',
              in: 'path',
              required: true,
              content: {
                'application/xml': {
                  schema: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
            {
              name: 'queryValue',
              in: 'query',
              content: {
                'application/xml': {
                  schema: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
            {
              name: 'X-Content',
              in: 'header',
              content: {
                'application/xml': {
                  schema: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
            {
              name: 'contentCookie',
              in: 'cookie',
              content: {
                'application/xml': {
                  schema: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
          ],
          responses: ok,
        },
      },
      '/cookie': {
        get: {
          operationId: 'cookieStyles',
          parameters: [
            {
              name: 'session',
              in: 'cookie',
              style: 'form',
              explode: true,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'prefs',
              in: 'cookie',
              style: 'form',
              explode: false,
              schema: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
            },
            {
              name: 'compact',
              in: 'cookie',
              style: 'form',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'flags',
              in: 'cookie',
              style: 'form',
              explode: true,
              schema: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
            },
          ],
          responses: ok,
        },
      },
    },
  };
  const output = createFixtureProject(t, 'golem-openapi-styles-');
  writeSdk(document, { output, name: 'Styles' });
  const compiled = spawnSync(process.execPath, [tscBin(), 
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable',
    '--outDir', path.join(output, 'dist'),
    path.join(output, 'index.ts'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const stylesModule = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'styles client',
  );
  assert.equal(isGeneratedClientClass(stylesModule.StylesClient), true);
  if (!isGeneratedClientClass(stylesModule.StylesClient)) throw new TypeError('StylesClient');
  const StylesClient = stylesModule.StylesClient;
  const urls: string[] = [];
  const cookieHeaders: Array<string | null> = [];
  const styleHeaders: Array<{ array: string | null; objectFlat: string | null; objectExplode: string | null }> = [];
  const contentHeaders: Array<{ header: string | null; cookie: string | null }> = [];
  const parameterContexts: Array<{ operation: string; name: string; in: string; contentType: string }> = [];
  const client = new StylesClient({
    baseUrl: 'https://api.example',
    parameterSerializers: {
      'application/xml': (value: Record<string, unknown>, context: { operation: string; name: string; in: string; contentType: string }) => {
        parameterContexts.push(context);
        return `<value>${Object.values(value).join(',')}</value>`;
      },
    },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const captured = captureRequest(url, init);
      urls.push(captured.url);
      if (new URL(captured.url).pathname === '/cookie') {
        cookieHeaders.push(captured.init.headers.get('cookie'));
      }
      if (new URL(captured.url).pathname === '/header') {
        styleHeaders.push({
          array: captured.init.headers.get('X-Array'),
          objectFlat: captured.init.headers.get('X-Object-Flat'),
          objectExplode: captured.init.headers.get('X-Object-Explode'),
        });
      }
      if (new URL(captured.url).pathname.startsWith('/content/')) {
        contentHeaders.push({
          header: captured.init.headers.get('X-Content'),
          cookie: captured.init.headers.get('cookie'),
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await client.simple().execute({
    path: {
      array: ['blue', 'black'],
      objectFlat: { role: 'admin', first: 'Alex' },
      objectExplode: { role: 'admin', first: 'Alex' },
    },
  });
  await client.label().execute({ path: { value: ['blue', 'black'] } });
  await client.labelFlat().execute({
    path: {
      array: ['blue', 'black'],
      object: { role: 'admin', first: 'Alex' },
    },
  });
  await client.matrix().execute({ path: { value: { role: 'admin', first: 'Alex' } } });
  await client.matrixFlat().execute({
    path: {
      array: ['blue', 'black'],
      object: { role: 'admin', first: 'Alex' },
    },
  });
  await client.queryStyles().execute({
    query: {
      filter: { state: 'settled', rail: 'NPS' },
      colors: ['blue', 'black'],
      point: { x: 1, y: 2 },
      tags: ['new', 'sale'],
      compactTags: ['new', 'sale'],
      dimensions: { width: 10, height: 20 },
      words: ['blue sky', 'black night'],
      criteria: { active: true },
    },
  });
  await client.headerStyles().execute({
    header: {
      'X-Array': ['blue', 'black'],
      'X-Object-Flat': { role: 'admin', first: 'Alex' },
      'X-Object-Explode': { role: 'admin', first: 'Alex' },
    },
  });
  await client.contentParameters().execute({
    path: { pathValue: { id: 'path' } },
    query: { queryValue: { id: 'query' } },
    header: { 'X-Content': { id: 'header' } },
    cookie: { contentCookie: { id: 'cookie' } },
  });
  await client.cookieStyles().execute({
    cookie: {
      session: ['a', 'b'],
      prefs: { theme: 'dark', lang: 'en' },
      compact: ['x', 'y'],
      flags: { secure: 'yes', sameSite: 'strict' },
    },
  });
  assert.deepEqual(urls, [
    'https://api.example/simple/blue,black/role,admin,first,Alex/role=admin,first=Alex',
    'https://api.example/label/.blue.black',
    'https://api.example/label-flat/.blue,black/.role,admin,first,Alex',
    'https://api.example/matrix/;role=admin;first=Alex',
    'https://api.example/matrix-flat/;array=blue,black/;object=role,admin,first,Alex',
    'https://api.example/query?filter[state]=settled&filter[rail]=NPS&colors=blue|black&point=x,1,y,2&tags=new&tags=sale&compactTags=new,sale&width=10&height=20&words=blue%20sky%20black%20night&criteria=%7B%22active%22%3Atrue%7D',
    'https://api.example/header',
    'https://api.example/content/%3Cvalue%3Epath%3C%2Fvalue%3E?queryValue=%3Cvalue%3Equery%3C%2Fvalue%3E',
    'https://api.example/cookie',
  ]);
  assert.deepEqual(styleHeaders, [{
    array: 'blue,black',
    objectFlat: 'role,admin,first,Alex',
    objectExplode: 'role=admin,first=Alex',
  }]);
  assert.deepEqual(parameterContexts.map(({ operation, name, in: location, contentType }) => ({
    operation,
    name,
    location,
    contentType,
  })), [
    {
      operation: 'contentParameters',
      name: 'queryValue',
      location: 'query',
      contentType: 'application/xml',
    },
    {
      operation: 'contentParameters',
      name: 'X-Content',
      location: 'header',
      contentType: 'application/xml',
    },
    {
      operation: 'contentParameters',
      name: 'contentCookie',
      location: 'cookie',
      contentType: 'application/xml',
    },
    {
      operation: 'contentParameters',
      name: 'pathValue',
      location: 'path',
      contentType: 'application/xml',
    },
  ]);
  assert.equal(styleHeaders.length, 1);
  assert.deepEqual(contentHeaders, [{
    header: '<value>header</value>',
    cookie: 'contentCookie=%3Cvalue%3Ecookie%3C%2Fvalue%3E',
  }]);
  assert.deepEqual(cookieHeaders, [
    'session=a; session=b; prefs=theme,dark,lang,en; compact=x,y; secure=yes; sameSite=strict',
  ]);

  const missingParameterSerializerClient = new StylesClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => {
      assert.fail('fetch must not run without the required parameter serializer');
    },
  });
  await assert.rejects(
    () => missingParameterSerializerClient.contentParameters().execute({
      path: { pathValue: { id: 'path' } },
    }),
    /No parameter serializer configured/,
  );
});

test('OpenAPI 3.2 querystring, sequential stream, and binary responses work on the wire', async (t) => {
  const document = {
    openapi: '3.2.0',
    info: { title: 'Media', version: '1' },
    paths: {
      '/search': {
        get: {
          operationId: 'search',
          parameters: [{
            in: 'querystring',
            name: 'query',
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: {
                    phrase: { type: 'string' },
                    active: { type: 'boolean' },
                  },
                },
              },
            },
          }],
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/events': {
        get: {
          operationId: 'events',
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
      '/download': {
        get: {
          operationId: 'download',
          responses: {
            200: {
              description: 'file',
              content: { 'image/*': {} },
            },
          },
        },
      },
      '/sse': {
        get: {
          operationId: 'serverEvents',
          responses: {
            200: {
              description: 'events',
              content: {
                'text/event-stream': {
                  itemSchema: {
                    type: 'object',
                    required: ['data'],
                    properties: {
                      data: { type: 'string' },
                      event: { type: 'string' },
                      id: { type: 'string' },
                      retry: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/multipart-events': {
        get: {
          operationId: 'multipartEvents',
          responses: {
            200: {
              description: 'framed events',
              content: {
                'multipart/mixed': {
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
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['metadata', 'file'],
                  properties: {
                    metadata: {
                      type: 'object',
                      properties: { name: { type: 'string' } },
                    },
                    file: { type: 'string', format: 'binary' },
                  },
                },
                encoding: {
                  metadata: { contentType: 'application/json' },
                  file: { contentType: 'application/octet-stream' },
                },
              },
            },
          },
          responses: {
            204: { description: 'uploaded' },
          },
        },
      },
      '/advanced-upload': {
        post: {
          operationId: 'advancedUpload',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['metadata'],
                  properties: {
                    metadata: {
                      type: 'object',
                      properties: { name: { type: 'string' } },
                    },
                  },
                },
                encoding: {
                  metadata: {
                    contentType: 'application/json',
                    headers: {
                      'X-Part-Version': {
                        schema: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            204: { description: 'uploaded' },
          },
        },
      },
    },
  };
  const output = createFixtureProject(t, 'golem-openapi-media-');
  writeSdk(document, { output, name: 'Media' });
  const compiled = spawnSync(process.execPath, [tscBin(), 
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable',
    '--outDir', path.join(output, 'dist'),
    path.join(output, 'index.ts'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const mediaModule = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'media client',
  );
  assert.equal(isGeneratedClientClass(mediaModule.MediaClient), true);
  if (!isGeneratedClientClass(mediaModule.MediaClient)) throw new TypeError('MediaClient');
  const MediaClient = mediaModule.MediaClient;
  const urls: string[] = [];
  let uploadRequest: CapturedRequest | undefined;
  const client = new MediaClient({
    baseUrl: 'https://api.example',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const captured = captureRequest(url, init);
      urls.push(captured.url);
      if (captured.url.endsWith('/events')) {
        return new Response('{"id":1}\n{"id":2}\n', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      if (captured.url.endsWith('/download')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (captured.url.endsWith('/sse')) {
        return new Response(
          ': heartbeat\nid: payment-7\nevent: settled\ndata: first line\ndata: second line\nretry: 1500\n\n',
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          },
        );
      }
      if (captured.url.endsWith('/multipart-events')) {
        return new Response('{"id":3}\n{"id":4}\n', {
          status: 200,
          headers: {
            'content-type': 'multipart/mixed; boundary=fixture',
          },
        });
      }
      if (captured.url.endsWith('/upload')) {
        uploadRequest = captured;
        return new Response(null, { status: 204 });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    streamDecoders: {
      'multipart/mixed': async function* (response: Response, context: { operation: string; contentType: string }) {
        assert.equal(context.operation, 'multipartEvents');
        assert.equal(context.contentType, 'multipart/mixed');
        for (const line of (await response.text()).trim().split('\n')) {
          yield JSON.parse(line);
        }
      },
    },
  });
  await client.search().execute({ querystring: { phrase: 'a + b', active: true } });
  const stream = (await client.events().execute({})).body;
  assert.equal(isAsyncIterable(stream), true);
  if (!isAsyncIterable(stream)) throw new TypeError('events stream');
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  const file = (await client.download().execute({})).body;
  assert.ok(file instanceof Blob);
  const sseStream = (await client.serverEvents().execute({})).body;
  assert.equal(isAsyncIterable(sseStream), true);
  if (!isAsyncIterable(sseStream)) throw new TypeError('sse stream');
  const serverEvents: unknown[] = [];
  for await (const event of sseStream) serverEvents.push(event);
  const multipartStream = (await client.multipartEvents().execute({})).body;
  assert.equal(isAsyncIterable(multipartStream), true);
  if (!isAsyncIterable(multipartStream)) throw new TypeError('multipart stream');
  const multipartEvents: unknown[] = [];
  for await (const event of multipartStream) multipartEvents.push(event);
  const uploadFile = new Blob([new Uint8Array([7, 8])], { type: 'application/octet-stream' });
  await client.upload().execute({ body: { metadata: { name: 'proof' }, file: uploadFile } });
  assert.equal(urls[0], 'https://api.example/search?phrase=a+%2B+b&active=true');
  assert.deepEqual(events, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(serverEvents, [{
    data: 'first line\nsecond line',
    event: 'settled',
    id: 'payment-7',
    retry: 1500,
  }]);
  assert.deepEqual(multipartEvents, [{ id: 3 }, { id: 4 }]);
  assert.ok(uploadRequest);
  assert.equal(uploadRequest.init.headers.has('content-type'), false);
  assert.ok(uploadRequest.init.body instanceof FormData);
  const uploadedFile = uploadRequest.init.body.get('file');
  assert.ok(uploadedFile instanceof Blob);
  assert.deepEqual([...new Uint8Array(await uploadedFile.arrayBuffer())], [7, 8]);
  const metadata = uploadRequest.init.body.get('metadata');
  assert.ok(metadata instanceof Blob);
  assert.equal(metadata.type, 'application/json');
  assert.equal(await metadata.text(), '{"name":"proof"}');

  let encoderContext: { contentType?: string; encoding?: Record<string, { headers?: Record<string, { schema?: { type?: string } }> }> } | undefined;
  let advancedRequest: CapturedRequest | undefined;
  const advancedClient = new MediaClient({
    baseUrl: 'https://api.example',
    bodyEncoders: {
      'multipart/form-data': (value: unknown, context: { contentType?: string; encoding?: Record<string, { headers?: Record<string, { schema?: { type?: string } }> }> }) => {
        encoderContext = context;
        return {
          body: new Blob([JSON.stringify(value)]),
          contentType: 'multipart/form-data; boundary=golem-test',
        };
      },
    },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      advancedRequest = captureRequest(url, init);
      return new Response(null, { status: 204 });
    },
  });
  await advancedClient.advancedUpload().execute({ body: { metadata: { name: 'proof' } } });
  assert.ok(encoderContext);
  assert.equal(encoderContext.contentType, 'multipart/form-data');
  assert.equal(
    encoderContext.encoding?.metadata?.headers?.['X-Part-Version']?.schema?.type,
    'string',
  );
  assert.ok(advancedRequest);
  assert.equal(
    advancedRequest.init.headers.get('content-type'),
    'multipart/form-data; boundary=golem-test',
  );

  const missingStreamDecoderClient = new MediaClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response('{"id":1}', {
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=fixture' },
    }),
  });
  await assert.rejects(
    () => missingStreamDecoderClient.multipartEvents().execute({}),
    /No stream decoder configured/,
  );

  const invalidStreamClient = new MediaClient({
    baseUrl: 'https://api.example',
    operationValidators: new Map([[
      'multipartEvents',
      {
        input: () => [],
        responses: new Map([[
          '200:multipart/mixed',
          (value: unknown) => value && typeof value === 'object' && 'id' in value ? [] : [{ code: 'custom' as const, path: [] }],
        ]]),
      },
    ]]),
    streamDecoders: {
      'multipart/mixed': async function* () {
        yield {};
      },
    },
    fetchImpl: async () => new Response('invalid', {
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=fixture' },
    }),
  });
  const invalidStream = (await invalidStreamClient.multipartEvents().execute({})).body;
  assert.equal(isAsyncIterable(invalidStream), true);
  if (!isAsyncIterable(invalidStream)) throw new TypeError('invalid stream');
  await assert.rejects(
    async () => {
      for await (const item of invalidStream) void item;
    },
    /API data validation failed/,
  );
});
