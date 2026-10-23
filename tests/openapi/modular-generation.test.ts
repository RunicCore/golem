import { copyFixtureFile, createFixtureProject, readFixture, linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { parse } from 'yaml';
import test, { type TestContext } from 'node:test';

import { getValidator } from '@exprtlabs/golem/validation';
import { generate as generateModels } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import {
  compileGeneratedSdk,
  isGeneratedModelClass,
  repoRoot,
  requireRecord,
  writeGeneratedSdk,
} from './helpers.js';

interface Fixture {
  readonly root: string;
  readonly source: string;
}

function fixture(t: TestContext): Fixture {
  const root = createFixtureProject(t, 'golem-openapi-modules-');
  const source = path.join(root, 'src');
  mkdirSync(source, { recursive: true });
  linkProjectPackages(root, { '@exprtlabs/golem': path.join(repoRoot(), 'packages/golem') });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowJs: true,
      skipLibCheck: true,
      rootDir: 'src',
      outDir: 'src/dist',
    },
    include: ['src/**/*.ts', 'src/**/*.js'],
  }));
  return { root, source };
}

function moduleDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Modular API', version: '1' },
    components: { schemas: {
      Tree: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          children: { type: 'array', items: { $ref: '#/components/schemas/Tree' } },
        },
      },
      BaseRecord: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      Record: {
        allOf: [
          { $ref: '#/components/schemas/BaseRecord' },
          { type: 'object', properties: { note: { type: 'string' } } },
        ],
      },
      Payload: {
        type: 'object',
        additionalProperties: false,
        required: ['tree', 'record'],
        properties: {
          tree: { $ref: '#/components/schemas/Tree' },
          record: { $ref: '#/components/schemas/Record' },
        },
      },
    } },
    paths: {
      '/tree': { post: {
        operationId: 'echoTree',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } },
        responses: {
          200: {
            description: 'echo',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } },
          },
        },
      } },
      '/record': { get: {
        operationId: 'getOther',
        responses: {
          200: {
            description: 'other',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } },
          },
        },
      } },
    },
  };
}

function nestedValidationDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Nested Standalone', version: '1' },
    components: { schemas: {
      LineItem: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'quantity'],
        properties: {
          sku: { type: 'string', minLength: 3 },
          quantity: { type: 'integer', minimum: 1 },
        },
      },
      Order: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'lines'],
        properties: {
          id: { type: 'string', minLength: 3 },
          lines: { type: 'array', items: { $ref: '#/components/schemas/LineItem' } },
        },
      },
    } },
    paths: {
      '/orders': {
        post: {
          operationId: 'submitOrder',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          responses: {
            200: {
              description: 'accepted',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
            },
          },
        },
      },
    },
  };
}

function resourceAliasCollisionDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Resource Alias Collision', version: '1' },
    components: { schemas: {
      FirstResource: {
        $id: 'urn:example',
        type: 'object',
        additionalProperties: false,
        required: ['first'],
        properties: { first: { type: 'string' } },
      },
      SecondResource: {
        $id: 'urn:example:input',
        type: 'object',
        additionalProperties: false,
        required: ['second'],
        properties: { second: { type: 'number' } },
      },
      Payload: {
        type: 'object',
        additionalProperties: false,
        required: ['first', 'second'],
        properties: {
          first: { $ref: 'urn:example' },
          second: { $ref: 'urn:example:input' },
        },
      },
    } },
    paths: {
      '/payload': { post: {
        operationId: 'submitPayload',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } },
        responses: {
          200: {
            description: 'accepted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } },
          },
        },
      } },
    },
  };
}

function crossGroupDiscriminatorDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Cross Group Discriminator', version: '1' },
    components: { schemas: {
      BaseRecord: {
        type: 'object',
        required: ['kind'],
        properties: { kind: { type: 'string' } },
      },
      Alpha: {
        allOf: [
          { $ref: '#/components/schemas/BaseRecord' },
          { type: 'object', required: ['alpha'], properties: { kind: { const: 'alpha' }, alpha: { type: 'string' } } },
        ],
      },
      Beta: {
        allOf: [
          { $ref: '#/components/schemas/BaseRecord' },
          { type: 'object', required: ['beta'], properties: { kind: { const: 'beta' }, beta: { type: 'string' } } },
        ],
      },
      Choice: {
        oneOf: [
          { $ref: '#/components/schemas/Alpha' },
          { $ref: '#/components/schemas/Beta' },
        ],
        discriminator: {
          propertyName: 'kind',
          mapping: {
            alpha: '#/components/schemas/Alpha',
            beta: '#/components/schemas/Beta',
          },
        },
      },
      Parent: {
        type: 'object',
        required: ['choice'],
        properties: { choice: { $ref: '#/components/schemas/Choice' } },
      },
    } },
  };
}

function scaleDocument(count: number): Record<string, unknown> {
  const paths: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < count; index += 1) {
    paths[`/entries/${index}`] = {
      post: {
        operationId: `sendEntry${index}`,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
        responses: {
          200: {
            description: 'accepted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Shared Closure Scale', version: '1' },
    components: { schemas: {
      Leaf: { type: 'object', required: ['label'], properties: { label: { type: 'string' } } },
      Group: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Leaf' } } },
      },
      Envelope: {
        type: 'object',
        required: ['group', 'history'],
        properties: {
          group: { $ref: '#/components/schemas/Group' },
          history: { type: 'array', items: { $ref: '#/components/schemas/Group' } },
        },
      },
    } },
    paths,
  };
}

function contextDocument(marker: string): Record<string, unknown> {
  const sharedId = 'https://schemas.example.test/context/shared';
  return {
    openapi: '3.1.0',
    info: { title: 'Repeated Generation Context', version: '1' },
    components: { schemas: {
      Envelope: {
        type: 'object',
        required: ['value'],
        properties: { value: { $ref: sharedId } },
      },
      Shared: {
        $id: sharedId,
        type: 'string',
        const: marker,
      },
    } },
    paths: {
      '/envelope': {
        post: {
          operationId: 'putEnvelope',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
          responses: {
            200: {
              description: 'echo',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
            },
          },
        },
      },
    },
  };
}

const STRICT_OPTIONS = { strict: true, noUnusedLocals: true, noUnusedParameters: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } as const;

type Operation = { execute(input: unknown): Promise<{ readonly body: unknown }> };

/** An operation factory of the compiled SDK, run against a fetch that records the requests it gets and answers with the request body. */
async function loadOperation(source: string, name: string): Promise<{ operation: Operation; requests: string[] }> {
  const module = requireRecord(await import(pathToFileURL(path.join(source, `dist/operations/${name}.js`)).href), `${name} operation`);
  const factory = module[name];
  if (typeof factory !== 'function') throw new TypeError(`${name} factory is missing`);
  const requests: string[] = [];
  const operation = factory({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      return new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });
    },
  }) as Operation;
  return { operation, requests };
}

/** The one validators module of an SDK: its models and its operations share it. */
function sdkValidatorArtifacts(artifacts: readonly { readonly path: string; readonly content: string }[]): readonly { readonly path: string; readonly content: string }[] {
  return artifacts.filter((artifact) => path.basename(artifact.path) === 'validators.generated.ts');
}

test('direct operation and model entrypoints load only their generated closures and share canonical model exports', async t => {
  const { source } = fixture(t);
  const result = writeGeneratedSdk(writeSdk, moduleDocument(), {
    output: source,
    name: 'Modular',
    profile: { mobx: false, validation: true },
  });
  compileGeneratedSdk(source, [], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });

  const models = requireRecord(await import(pathToFileURL(path.join(source, 'dist/index.js')).href), 'models facade');
  const directTree = requireRecord(await import(pathToFileURL(path.join(source, 'dist/models/Tree.js')).href), 'Tree module');
  assert.ok(isGeneratedModelClass(models.TreeModel));
  assert.strictEqual(directTree.TreeModel, models.TreeModel);
  assert.strictEqual(directTree.stringifyTree, models.stringifyTree);
  assert.strictEqual(directTree.toWireFormatTree, models.toWireFormatTree);
  const TreeModel = models.TreeModel;
  const stringifyTree = directTree.stringifyTree;
  assert.equal(typeof TreeModel, 'function');
  assert.equal(typeof stringifyTree, 'function');
  if (typeof TreeModel !== 'function' || typeof stringifyTree !== 'function') throw new TypeError('Tree exports are missing');
  const tree = new (TreeModel as new (values?: Record<string, unknown>) => object)({
    name: 'root',
    children: [{ name: 'leaf' }],
  });
  assert.deepEqual(JSON.parse((stringifyTree as (value: object) => string)(tree)), {
    name: 'root', children: [{ name: 'leaf' }],
  });

  const operationModule = requireRecord(
    await import(pathToFileURL(path.join(source, 'dist/operations/echoTree.js')).href),
    'direct operation module',
  );
  assert.equal(typeof operationModule.echoTree, 'function');
  const operationFactory = operationModule.echoTree;
  if (typeof operationFactory !== 'function') throw new TypeError('echoTree factory is missing');
  const operation = operationFactory({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => new Response(String(init?.body), {
      headers: { 'content-type': 'application/json' },
    }),
  }) as { execute(input: unknown): Promise<{ readonly body: unknown }> };
  const payload = { tree: { name: 'root' }, record: { id: 'r1', note: 'hello' } };
  assert.deepEqual((await operation.execute({ body: payload })).body, payload);

  const operationBundle = await bundle({
    entryPoints: [path.join(source, 'dist/operations/echoTree.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
  });
  const operationInputs = Object.keys(operationBundle.metafile.inputs).map(value => value.replaceAll('\\', '/'));
  const operationInputSet = operationInputs.join('\n');
  assert.ok(operationInputs.some(value => value.endsWith('/operations/echoTree.js')));
  assert.ok(operationInputs.some(value => value.endsWith('/validators.generated.js')));
  assert.doesNotMatch(operationInputSet, /\/src\/dist\/(?:client|models|schemas)\.js(?:\s|$)/);
  assert.doesNotMatch(operationInputSet, /\/operations\/getOther\.js(?:\s|$)/);

  const modelBundle = await bundle({
    entryPoints: [path.join(source, 'dist/models/Tree.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
  });
  const modelInputs = Object.keys(modelBundle.metafile.inputs).map(value => value.replaceAll('\\', '/'));
  const modelInputSet = modelInputs.join('\n');
  assert.ok(modelInputs.some(value => value.endsWith('/models/Tree.js')));
  assert.doesNotMatch(modelInputSet, /\/src\/dist\/(?:client|schemas)\.js(?:\s|$)/);
  assert.doesNotMatch(modelInputSet, /\/operations\/[^/]+\.js(?:\s|$)/);
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('/models/Tree.ts')));
});

test('directional resource aliases never shadow another exact resource ID in generated operations', async t => {
  const { source } = fixture(t);
  writeGeneratedSdk(writeSdk, resourceAliasCollisionDocument(), {
    output: source,
    name: 'ResourceAliases',
    profile: { mobx: false, validation: true },
  });
  compileGeneratedSdk(source, [], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });

  const operationModule = requireRecord(
    await import(pathToFileURL(path.join(source, 'dist/operations/submitPayload.js')).href),
    'submitPayload operation',
  );
  const operationFactory = operationModule.submitPayload;
  assert.equal(typeof operationFactory, 'function');
  if (typeof operationFactory !== 'function') throw new TypeError('submitPayload factory is missing');
  const operation = operationFactory({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => new Response(String(init?.body), {
      headers: { 'content-type': 'application/json' },
    }),
  }) as { execute(input: unknown): Promise<{ readonly body: unknown }> };
  const payload = { first: { first: 'one' }, second: { second: 2 } };
  assert.deepEqual((await operation.execute({ body: payload })).body, payload);
});

test('cross-group discriminator initializer is emitted by its defining model group', async t => {
  const { source } = fixture(t);
  writeGeneratedSdk(writeSdk, crossGroupDiscriminatorDocument(), {
    output: source,
    name: 'CrossGroupDiscriminator',
    profile: { mobx: false, validation: false },
  });
  compileGeneratedSdk(source, [], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });

  const parentModule = requireRecord(
    await import(pathToFileURL(path.join(source, 'dist/models/Parent.js')).href),
    'Parent model',
  );
  const alphaModule = requireRecord(
    await import(pathToFileURL(path.join(source, 'dist/models/Alpha.js')).href),
    'Alpha model',
  );
  const ParentModel = parentModule.ParentModel;
  const AlphaModel = alphaModule.AlphaModel;
  assert.equal(typeof ParentModel, 'function');
  assert.equal(typeof AlphaModel, 'function');
  if (typeof ParentModel !== 'function' || typeof AlphaModel !== 'function') throw new TypeError('generated model export is missing');
  const parent = new (ParentModel as new (values?: Record<string, unknown>) => object)({
    choice: { kind: 'alpha', alpha: 'selected' },
  });
  const choice = Reflect.get(parent, 'choice');
  assert.ok(choice instanceof AlphaModel);
  assert.equal(Reflect.get(choice, 'alpha'), 'selected');
});

test('compact OpenAPI schema closure feeds nested model first/all validation and a missing closure is rejected', async t => {
  const { root, source } = fixture(t);
  const sdk = source;
  const sdkResult = writeGeneratedSdk(writeSdk, nestedValidationDocument(), {
    output: sdk,
    name: 'NestedStandalone',
    profile: { mobx: false, validation: true },
  });
  const manifestPath = path.join(sdk, 'model-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    source: { digest: string };
    validationSchemaClosure?: readonly { codecId: string; modelSchema: unknown; wireSchema?: unknown; aliases?: readonly string[] }[];
  };
  const closure = manifest.validationSchemaClosure;
  assert.ok(closure && closure.length >= 2, 'OpenAPI emits model validation schemas once in the manifest closure');
  const codecIds = new Set(closure?.map(entry => entry.codecId));
  assert.equal(codecIds.size, closure?.length, 'the closure has one entry per canonical codec identity');
  const schemaRefs: string[] = [];
  const collectRefs = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectRefs(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') schemaRefs.push(item);
      else collectRefs(item);
    }
  };
  for (const entry of closure ?? []) {
    collectRefs(entry.modelSchema);
    collectRefs(entry.wireSchema);
  }
  assert.ok(schemaRefs.some(reference => [...codecIds].some(id => reference === id || reference === `${id}#wire`)),
    'nested manifest schemas point to canonical closure entries instead of embedding repeated child schemas');
  assert.ok(sdkResult.artifacts.some(artifact => artifact.path.endsWith('/models/Order.ts')));

  const purchaseSource = path.join(source, 'purchase.model.ts');
  copyFixtureFile(source, "openapi/modular-generation/purchase.model.ts", "purchase.model.ts");
  const generateCompanion = () => generateModels({
    root,
    sources: [purchaseSource],
    manifestInputs: [manifestPath],
    profile: { mobx: false, validation: true },
  });
  const companion = generateCompanion();
  const validatorModule = companion.artifacts.find(artifact => artifact.path.endsWith('/models.validators.generated.ts'));
  assert.ok(validatorModule, 'golem-model consumes the transitive OpenAPI closure in one validator module');
  writeGeneratedArtifacts(companion.artifacts);
  // The model file imports its validators, so tsc emits them with it.
  compileGeneratedSdk(source, [purchaseSource], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });

  const sdkModels = requireRecord(await import(pathToFileURL(path.join(source, 'dist/index.js')).href), 'SDK models');
  const purchaseModule = requireRecord(await import(pathToFileURL(path.join(source, 'dist/purchase.model.js')).href), 'Purchase model');
  const Purchase = purchaseModule.Purchase;
  const OrderModel = sdkModels.OrderModel;
  const LineItemModel = sdkModels.LineItemModel;
  for (const [name, value] of [['Purchase', Purchase], ['OrderModel', OrderModel], ['LineItemModel', LineItemModel]] as const) {
    assert.equal(typeof value, 'function', `${name} class export`);
    if (typeof value !== 'function') throw new TypeError(`${name} class export`);
  }
  const PurchaseClass = Purchase as new (values?: Record<string, unknown>) => object;
  const OrderClass = OrderModel as new (values?: Record<string, unknown>) => object;
  const LineItemClass = LineItemModel as new (values?: Record<string, unknown>) => object;
  const validOrder = new OrderClass({ id: 'ORD-1', lines: [new LineItemClass({ sku: 'sku-1', quantity: 1 })] });
  const validPurchase = new PurchaseClass({ order: validOrder });
  const validValidator = getValidator(validPurchase);
  assert.equal(await validValidator.validate({ failFast: true }), true);

  const invalidOrder = new OrderClass({ id: '', lines: [new LineItemClass({ sku: 'x', quantity: 0 })] });
  const invalidPurchase = new PurchaseClass({ order: invalidOrder });
  const invalidValidator = getValidator(invalidPurchase);
  assert.equal(await invalidValidator.validate({ failFast: true }), false);
  assert.equal(invalidValidator.issues.length, 1, 'first mode reads the closure set first-validator binding');
  assert.equal(await invalidValidator.validate({ failFast: false }), false);
  assert.ok(invalidValidator.issues.length >= 3, 'all mode reads the closure set all-validator binding');
  assert.ok(invalidValidator.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['order', 'lines', 0, 'sku'])));

  delete (manifest as { validationSchemaClosure?: unknown }).validationSchemaClosure;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const captureMissingClosureDiagnostic = (): string => {
    try {
      generateCompanion();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('generation unexpectedly accepted a missing OpenAPI validation schema closure');
  };
  const missingClosureError = captureMissingClosureDiagnostic();
  assert.match(missingClosureError, /Regenerate the referenced model manifest with schema closure metadata/);
  assert.equal(captureMissingClosureDiagnostic(), missingClosureError, 'missing closure diagnostics are deterministic across generation jobs');
});

test('a Nest-style Payment keeps canonical codec identity across repeated compact SDK closure candidates', t => {
  const { root, source } = fixture(t);
  const configPath = path.join(root, 'tsconfig.json');
  const projectConfig = requireRecord(JSON.parse(readFileSync(configPath, 'utf8')), 'fixture TypeScript config');
  const compilerOptions = requireRecord(projectConfig.compilerOptions, 'fixture compiler options');
  // The isolated source retains TPaymentInput and TPaymentFilter but omits the
  // controllers that consume their generated conversion helpers, so unused
  // locals are allowed; the rest of strict typechecking stays on.
  compilerOptions.noUnusedLocals = false;
  writeFileSync(configPath, JSON.stringify(projectConfig));
  const document = parse(readFixture('openapi/canonical-codec-identity/openapi.yaml'));
  const sdk = path.join(root, 'sdk');
  const sdkResult = writeSdk(document, {
    output: sdk,
    name: 'Payments',
    profile: { mobx: false, validation: true },
  });
  writeGeneratedArtifacts(sdkResult.artifacts);

  const paymentSource = path.join(source, 'payment.model.ts');
  copyFixtureFile(root, 'openapi/canonical-codec-identity/payment.model.ts', 'src/payment.model.ts');
  copyFixtureFile(root, 'openapi/canonical-codec-identity/payment-status.ts', 'src/payment-status.ts');

  const manifestPath = path.join(sdk, 'model-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    validationSchemaClosure: {
      codecId: string;
      aliases?: readonly string[];
      modelSchema: unknown;
      wireSchema?: unknown;
    }[];
  };
  const paymentClosure = manifest.validationSchemaClosure.find(entry => entry.aliases?.includes('Payment'));
  const moneyClosure = manifest.validationSchemaClosure.find(entry => entry.aliases?.includes('Money'));
  assert.ok(paymentClosure);
  assert.ok(moneyClosure);
  assert.match(paymentClosure.codecId, /^Payment_[0-9a-f]{8}$/, 'the codec ID follows the name_digest format');

  const secondSdk = path.join(root, 'sdk-2');
  const secondSdkResult = writeSdk(document, {
    output: secondSdk,
    name: 'Payments',
    profile: { mobx: false, validation: true },
  });
  writeGeneratedArtifacts(secondSdkResult.artifacts);
  const secondManifest = JSON.parse(readFileSync(path.join(secondSdk, 'model-manifest.json'), 'utf8')) as {
    validationSchemaClosure: { codecId: string; aliases?: readonly string[] }[];
  };
  const secondPaymentClosure = secondManifest.validationSchemaClosure.find(entry => entry.aliases?.includes('Payment'));
  assert.ok(secondPaymentClosure);
  assert.equal(secondPaymentClosure.codecId, paymentClosure.codecId,
    'the SDK preserves its canonical Payment codec ID across repeated generations');

  // A second imported closure can carry the same shared component identity.
  // The local full graph plus this compact entry exercise two equal
  // candidates while keeping each payload paired with its own graph context.
  manifest.validationSchemaClosure.push(structuredClone(paymentClosure));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const generatePayment = () => generateModels({
    root,
    sources: [paymentSource],
    manifestInputs: [manifestPath],
    profile: { mobx: false, validation: true },
  });
  const result = generatePayment();
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('/payment.model.generated.ts')));
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('/models.validators.generated.ts')));

  const conflictingMoneySchema = {
    ...requireRecord(moneyClosure.modelSchema, 'Money model schema'),
    maxProperties: 1,
  };
  // The hand-written Payment and the SDK no longer share Money's codec id, so the
  // conflict is two closure entries that claim the SDK's Money id with different schemas.
  manifest.validationSchemaClosure.push({ ...moneyClosure, modelSchema: conflictingMoneySchema });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    generatePayment,
    error => error instanceof TypeError
      && error.message === `Conflicting schema identity "${moneyClosure.codecId}".`,
    'two closure entries with one codec id and different schemas remain rejected',
  );
});

test('10 and 100 operations share one validators module and the generated source grows linearly', async t => {
  const { root } = fixture(t);
  const sizes: number[] = [];
  for (const count of [10, 100]) {
    const result = writeGeneratedSdk(writeSdk, scaleDocument(count), {
      output: path.join(root, `src-${count}`),
      name: 'Scale',
      profile: { mobx: false, validation: true },
    });
    const operationArtifacts = result.artifacts.filter(artifact => artifact.path.includes(`${path.sep}operations${path.sep}`)
      && artifact.path.endsWith('.ts'));
    assert.equal(operationArtifacts.length, count);
    assert.equal(sdkValidatorArtifacts(result.artifacts).length, 1, 'one validators module');
    // Only the size of the emitted source shows that it grows in proportion to the operations.
    sizes.push(result.artifacts.reduce((total, artifact) => total + Buffer.byteLength(artifact.content), 0));
  }
  assert.ok(sizes[1] !== undefined && sizes[0] !== undefined && sizes[1] <= sizes[0] * 12,
    `100-operation source set remains proportional to 10 operations: ${sizes.join(', ')}`);

  // Each of the ten operations checks its own input against the shared module.
  const source = path.join(root, 'src-10');
  compileGeneratedSdk(source, [], STRICT_OPTIONS);
  const valid = { group: { items: [{ label: 'a' }] }, history: [] };
  const runs = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const { operation, requests } = await loadOperation(source, `sendEntry${index}`);
    await assert.rejects(operation.execute({ body: { group: { items: [] } } }), { name: 'LibError', causedByInput: true });
    const rejected = requests.length;
    await operation.execute({ body: valid });
    return { rejected, sent: requests.length };
  }));
  assert.deepEqual(runs, Array.from({ length: 10 }, () => ({ rejected: 0, sent: 1 })));
});

test('sequential same-title generation jobs keep schema and resource contexts isolated', async t => {
  // protects: T-295 a stringify core of a const-only model compiles under noUnusedParameters
  const alpha = fixture(t).source;
  const beta = fixture(t).source;
  const sdks = [
    writeGeneratedSdk(writeSdk, contextDocument('alpha'), { output: alpha, name: 'Context', profile: { mobx: false, validation: true } }),
    writeGeneratedSdk(writeSdk, contextDocument('beta'), { output: beta, name: 'Context', profile: { mobx: false, validation: true } }),
  ];
  assert.deepEqual(sdks.map(sdk => sdkValidatorArtifacts(sdk.artifacts).length), [1, 1]);
  compileGeneratedSdk(alpha, [], STRICT_OPTIONS);
  compileGeneratedSdk(beta, [], STRICT_OPTIONS);
  // An operation module imports its validators by operation and slot, so it carries no schema context of the job.
  const accepted = async (source: string, value: string): Promise<boolean> => {
    const { operation } = await loadOperation(source, 'putEnvelope');
    return operation.execute({ body: { value } }).then(() => true, () => false);
  };
  assert.deepEqual(
    [await accepted(alpha, 'alpha'), await accepted(alpha, 'beta'), await accepted(beta, 'alpha'), await accepted(beta, 'beta')],
    [true, false, false, true],
  );
});

test('the SDK validators module exports one named function per root and no record', async t => {
  const { source } = fixture(t);
  const result = writeGeneratedSdk(writeSdk, contextDocument('alpha'), { output: source, name: 'Context', profile: { mobx: false, validation: true } });
  assert.equal(sdkValidatorArtifacts(result.artifacts).length, 1);
  compileGeneratedSdk(source, [], STRICT_OPTIONS);
  const module = requireRecord(await import(pathToFileURL(path.join(source, 'dist/validators.generated.js')).href), 'validators module');
  // A model root's fast check is exported as the function itself; the operation roots get none.
  assert.deepEqual(Object.keys(module).map(name => name.replace(/_[0-9a-f]{8}$/, '_<hash>')).sort(), [
    'is_Envelope_<hash>',
    'validate_Envelope_<hash>',
    'validate_putEnvelope_input',
    'validate_putEnvelope_response_200_application_json',
  ]);
  assert.ok(Object.values(module).every(value => typeof value === 'function'), 'every export is a function, not a record');
});

function shortenedDocument(schemas: Record<string, unknown>): Record<string, unknown> {
  const operation = (name: string) => ({
    operationId: `get${name.replace(/[^A-Za-z]/g, '')}`,
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Shortened', version: '1' },
    paths: Object.fromEntries(Object.keys(schemas).map((name, index) => [`/p${index}`, { get: operation(name) }])),
    components: { schemas },
  };
}

const idObject = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const amountObject = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] };

async function generateShortened(t: TestContext, schemas: Record<string, unknown>) {
  const { source } = fixture(t);
  const result = writeGeneratedSdk(writeSdk, shortenedDocument(schemas), { output: source, name: 'Shortened', profile: { mobx: false, validation: false } });
  compileGeneratedSdk(source, [], STRICT_OPTIONS);
  const sdk = requireRecord(await import(pathToFileURL(path.join(source, 'dist/index.js')).href), 'shortened sdk');
  return { result, sdk, source };
}

function roundTrip(sdk: Record<string, unknown>, model: string, klass: string, value: Record<string, unknown>): void {
  const stringify = sdk[`stringify${model}`] as (value: unknown) => string;
  const parse = sdk[`parse${model}`] as (text: string, options?: { readonly construct?: abstract new (values?: never) => object }) => unknown;
  const Model = sdk[klass] as new (values?: never) => object;
  const text = stringify(new Model(value as never));
  assert.deepEqual(JSON.parse(text), value);
  const parsed = parse(text, { construct: Model });
  assert.ok(parsed instanceof Model, `${model} parses into ${klass}`);
  assert.deepEqual(JSON.parse(stringify(parsed)), value);
}

test('schemas whose names the codec rule shortens still get output files and exports', async t => {
  const { result, sdk, source } = await generateShortened(t, { PaymentModel: idObject, TPayment: amountObject, 'Pay$ment': idObject });
  const written = new Set(result.artifacts.map(artifact => artifact.path));
  const assertExported = async (schema: string, klass: string): Promise<void> => {
    assert.ok(written.has(path.join(source, 'models', `${schema}.ts`)), `models/${schema}.ts is written`);
    const direct = requireRecord(await import(pathToFileURL(path.join(source, `dist/models/${schema}.js`)).href), `${schema} module`);
    assert.ok(isGeneratedModelClass(sdk[klass]), `${klass} is exported by the SDK entry`);
    assert.strictEqual(sdk[klass], direct[klass]);
  };
  await assertExported('PaymentModel', 'PaymentModelModel');
  await assertExported('TPayment', 'TPaymentModel');
  await assertExported('Pay$ment', 'Pay$mentModel');
});

test('a model that references schemas with shortened names imports their own classes', async t => {
  const holder = { type: 'object', properties: { a: { $ref: '#/components/schemas/PaymentModel' }, b: { $ref: '#/components/schemas/Pay$ment' } }, required: ['a', 'b'] };
  const { sdk } = await generateShortened(t, { PaymentModel: idObject, 'Pay$ment': amountObject, Holder: holder });
  roundTrip(sdk, 'Holder', 'HolderModel', { a: { id: 'a' }, b: { amount: 2 } });
});

test('a single schema with a dollar sign in its name generates and round-trips', async t => {
  const model = await generateShortened(t, { 'Pay$ment': amountObject });
  roundTrip(model.sdk, 'Pay$ment', 'Pay$mentModel', { amount: 1 });
});

test('two schemas of equal shape whose names once shortened alike each keep their own class', async t => {
  const { sdk } = await generateShortened(t, { PaymentModel: idObject, TPayment: idObject });
  roundTrip(sdk, 'PaymentModel', 'PaymentModelModel', { id: 'a' });
  roundTrip(sdk, 'TPayment', 'TPaymentModel', { id: 'b' });
});

function holderOf(...targets: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(targets.map((target, index) => [`f${index}`, { $ref: `#/components/schemas/${target}` }])),
    required: targets.map((_, index) => `f${index}`),
  };
}

function assertHolderRoundTrip(
  sdk: Record<string, unknown>,
  classes: string[],
  values: Record<string, unknown>[],
): void {
  const value = Object.fromEntries(values.map((item, index) => [`f${index}`, item]));
  roundTrip(sdk, 'Holder', 'HolderModel', value);
  const parsed = (sdk.parseHolder as (text: string, options: { construct: unknown }) => Record<string, unknown>)(JSON.stringify(value), { construct: sdk.HolderModel });
  classes.forEach((klass, index) => {
    assert.ok(parsed[`f${index}`] instanceof (sdk[klass] as new () => object), `f${index} is a ${klass}`);
  });
}

test('a holder of both compiles and round-trips its nested classes', async t => {
  const { result, sdk, source } = await generateShortened(t, { PaymentModel: idObject, TPayment: amountObject, Holder: holderOf('PaymentModel', 'TPayment') });
  const manifest = JSON.parse(result.artifacts.find((artifact) => artifact.path.endsWith('/model-manifest.json'))?.content ?? '{}') as { models: { codecId: string; generated: { export: string } }[] };
  const classes = manifest.models.map((model) => model.generated.export).sort();
  assert.deepEqual(classes, ['HolderModel', 'PaymentModelModel', 'TPaymentModel'], 'the manifest names the emitted class of each exact component name');
  assert.equal(new Set(manifest.models.map((model) => model.codecId)).size, 3, 'three codec ids');
  const groupDirectory = path.join(source, 'dist/models');
  const groups = await Promise.all(readdirSync(groupDirectory).filter(file => /^_group-[0-9a-f]+\.js$/.test(file))
    .map(async file => requireRecord(await import(pathToFileURL(path.join(groupDirectory, file)).href), file)));
  assert.deepEqual(classes.map(name => groups.filter(group => typeof group[name] === 'function').length), [1, 1, 1], 'each class is declared in one group module');
  roundTrip(sdk, 'PaymentModel', 'PaymentModelModel', { id: 'a' });
  roundTrip(sdk, 'TPayment', 'TPaymentModel', { amount: 3 });
  assertHolderRoundTrip(sdk, ['PaymentModelModel', 'TPaymentModel'], [{ id: 'a' }, { amount: 2 }]);
});

test('a holder of Payment and TPayment compiles and round-trips its nested classes', async t => {
  const { sdk } = await generateShortened(t, { Payment: idObject, TPayment: amountObject, Holder: holderOf('Payment', 'TPayment') });
  assertHolderRoundTrip(sdk, ['PaymentModel', 'TPaymentModel'], [{ id: 'a' }, { amount: 2 }]);
});

function optionalRef(target: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${target}` };
}

test('a cycle through a schema whose name shortens like another compiles and round-trips', async t => {
  const holder = { type: 'object', properties: { t: optionalRef('TPayment') } };
  const tPayment = { ...amountObject, properties: { amount: { type: 'number' }, h: optionalRef('Holder') } };
  const { sdk } = await generateShortened(t, { Payment: idObject, TPayment: tPayment, Holder: holder });
  roundTrip(sdk, 'Payment', 'PaymentModel', { id: 'a' });
  roundTrip(sdk, 'TPayment', 'TPaymentModel', { amount: 1, h: { t: { amount: 2 } } });
  const parsed = (sdk.parseTPayment as (text: string, options: { construct: unknown }) => { h: { t: unknown } })(
    JSON.stringify({ amount: 1, h: { t: { amount: 2 } } }),
    { construct: sdk.TPaymentModel },
  );
  assert.ok(parsed.h instanceof (sdk.HolderModel as new () => object), 'h is a HolderModel');
  assert.ok(parsed.h.t instanceof (sdk.TPaymentModel as new () => object), 't is a TPaymentModel');
});

test('a cycle through schemas that shorten alike with a Model suffix compiles and round-trips', async t => {
  const holder = { type: 'object', properties: { t: optionalRef('TPaymentModel') } };
  const tPayment = { type: 'object', properties: { flag: { type: 'boolean' }, h: optionalRef('Holder') }, required: ['flag'] };
  const { sdk } = await generateShortened(t, { PaymentModel: idObject, TPaymentModel: tPayment, Holder: holder });
  roundTrip(sdk, 'PaymentModel', 'PaymentModelModel', { id: 'a' });
  roundTrip(sdk, 'TPaymentModel', 'TPaymentModelModel', { flag: true, h: { t: { flag: false } } });
});

test('two schemas that once shortened alike and reference each other compile and round-trip', async t => {
  const payment = { type: 'object', properties: { id: { type: 'string' }, t: optionalRef('TPayment') }, required: ['id'] };
  const tPayment = { type: 'object', properties: { amount: { type: 'number' }, p: optionalRef('Payment') }, required: ['amount'] };
  const { sdk } = await generateShortened(t, { Payment: payment, TPayment: tPayment });
  const wire = { id: 'a', t: { amount: 1, p: { id: 'b' } } };
  roundTrip(sdk, 'Payment', 'PaymentModel', wire);
  const parsed = (sdk.parsePayment as (text: string, options: { construct: unknown }) => { t: { p: unknown } })(JSON.stringify(wire), { construct: sdk.PaymentModel });
  assert.ok(parsed.t instanceof (sdk.TPaymentModel as new () => object), 't is a TPaymentModel');
  assert.ok(parsed.t.p instanceof (sdk.PaymentModel as new () => object), 'p is a PaymentModel');
  roundTrip(sdk, 'TPayment', 'TPaymentModel', { amount: 2, p: { id: 'c' } });
});
