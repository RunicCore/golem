import { copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { parse } from 'yaml';
import test, { type TestContext } from 'node:test';

import { getValidator } from '@exprtlabs/codegen/validation';
import { generate as generateModels } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import {
  compileGeneratedSdk,
  compileStrictUnusedSdk,
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
  const root = createFixtureProject(t, 'runic-openapi-modules-');
  const source = path.join(root, 'src');
  mkdirSync(source, { recursive: true });
  linkProjectPackages(root, { '@exprtlabs/codegen': path.join(repoRoot(), 'packages/codegen') });
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

function schemaClosureArtifacts(artifacts: readonly { readonly path: string; readonly content: string }[]): readonly { readonly path: string; readonly content: string }[] {
  return artifacts.filter((artifact) => artifact.path.includes(`${path.sep}validation-schemas${path.sep}`));
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
  assert.ok(operationInputs.some(value => value.includes('/validation-schemas/')));
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

test('compact OpenAPI schema closure feeds standalone nested model first/all validation and rejects missing closure only for standalone', async t => {
  const { root, source } = fixture(t);
  const sdk = source;
  const sdkResult = writeGeneratedSdk(writeSdk, nestedValidationDocument(), {
    output: sdk,
    name: 'NestedStandalone',
    profile: { mobx: false, validation: true, ajvStandalone: true },
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
  const generateCompanion = (ajvStandalone: boolean) => generateModels({
    root,
    sources: [purchaseSource],
    manifestInputs: [manifestPath],
    profile: { mobx: false, validation: true, ajvStandalone },
  });
  const standalone = generateCompanion(true);
  const standaloneValidator = standalone.artifacts.find(artifact => artifact.path.endsWith('/models.validators.generated.js'));
  assert.ok(standaloneValidator, 'standalone model-codegen consumes the transitive OpenAPI closure in one validator module');
  writeGeneratedArtifacts(standalone.artifacts);
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
  const captureStandaloneDiagnostic = (): string => {
    try {
      generateCompanion(true);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('standalone generation unexpectedly accepted a missing OpenAPI validation schema closure');
  };
  const missingClosureError = captureStandaloneDiagnostic();
  assert.match(missingClosureError, /Regenerate the referenced model manifest with standalone schema closure metadata/);
  assert.equal(captureStandaloneDiagnostic(), missingClosureError, 'missing closure diagnostics are deterministic across generation jobs');

  writeGeneratedSdk(writeSdk, nestedValidationDocument(), {
    output: sdk,
    name: 'NestedStandalone',
    profile: { mobx: false, validation: true, ajvStandalone: false },
  });
  const runtimeManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    source: { digest: string };
    validationSchemaClosure?: readonly unknown[];
  };
  delete (runtimeManifest as { validationSchemaClosure?: unknown }).validationSchemaClosure;
  writeFileSync(manifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  const runtimeAjv = generateCompanion(false);
  assert.ok(runtimeAjv.artifacts.some(artifact => artifact.path.endsWith('/purchase.model.generated.ts')),
    'legacy non-standalone model companion generates without OpenAPI closure metadata');
  assert.equal(runtimeAjv.artifacts.some(artifact => artifact.path.endsWith('/models.validators.generated.js')), false,
    'legacy runtime-backed companion does not require standalone validator artifacts');
  writeGeneratedArtifacts(runtimeAjv.artifacts);
  compileGeneratedSdk(source, [purchaseSource], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });
  copyFixtureFile(source, 'openapi/modular-generation/verify-legacy-runtime.mjs', 'verify-legacy-runtime.mjs');
  const legacyRuntime = spawnSync(process.execPath, ['verify-legacy-runtime.mjs'], { cwd: source, encoding: 'utf8' });
  assert.equal(legacyRuntime.status, 0,
    `legacy runtime subprocess failed:\n${legacyRuntime.stdout}\n${legacyRuntime.stderr}`);
  assert.equal(runtimeManifest.source.digest.length, 64);
});

test('maintained Nest Payment keeps canonical codec identity across repeated compact SDK closure candidates', t => {
  const { root, source } = fixture(t);
  const configPath = path.join(root, 'tsconfig.json');
  const projectConfig = requireRecord(JSON.parse(readFileSync(configPath, 'utf8')), 'fixture TypeScript config');
  const compilerOptions = requireRecord(projectConfig.compilerOptions, 'fixture compiler options');
  // The isolated source retains TPaymentInput and TPaymentFilter but omits the
  // controllers that consume their generated conversion helpers. The maintained
  // Nest project does not enable noUnusedLocals; keep strict typechecking here.
  compilerOptions.noUnusedLocals = false;
  writeFileSync(configPath, JSON.stringify(projectConfig));
  const nestExample = path.join(repoRoot(), 'examples/nest-openapi');
  const document = parse(readFileSync(path.join(nestExample, 'api/openapi.yaml'), 'utf8'));
  const sdk = path.join(root, 'sdk');
  const sdkResult = writeSdk(document, {
    output: sdk,
    name: 'Payments',
    profile: { mobx: false, validation: true, ajvStandalone: true },
  });
  writeGeneratedArtifacts(sdkResult.artifacts);

  const paymentSource = path.join(source, 'payment.model.ts');
  copyFileSync(path.join(nestExample, 'src/payment.model.ts'), paymentSource);
  copyFileSync(path.join(nestExample, 'src/payment-status.ts'), path.join(source, 'payment-status.ts'));

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
    profile: { mobx: false, validation: true, ajvStandalone: true },
  });
  writeGeneratedArtifacts(secondSdkResult.artifacts);
  const secondManifest = JSON.parse(readFileSync(path.join(secondSdk, 'model-manifest.json'), 'utf8')) as {
    validationSchemaClosure: { codecId: string; aliases?: readonly string[] }[];
  };
  const secondPaymentClosure = secondManifest.validationSchemaClosure.find(entry => entry.aliases?.includes('Payment'));
  assert.ok(secondPaymentClosure);
  assert.equal(secondPaymentClosure.codecId, paymentClosure.codecId,
    'the maintained SDK preserves its canonical Payment codec ID across repeated generations');

  // A second imported closure can carry the same shared component identity.
  // The local full graph plus this compact entry exercise two equal
  // candidates while keeping each payload paired with its own graph context.
  manifest.validationSchemaClosure.push(structuredClone(paymentClosure));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const generatePayment = () => generateModels({
    root,
    sources: [paymentSource],
    manifestInputs: [manifestPath],
    profile: { mobx: false, validation: true, ajvStandalone: true },
  });
  const result = generatePayment();
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('/payment.model.generated.ts')));
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('/models.validators.generated.js')));

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
      && error.message === `Conflicting standalone schema identity "${moneyClosure.codecId}".`,
    'two closure entries with one codec id and different schemas remain rejected',
  );
});

test('an SDK has no client-runtime.ts whatever its operation count', () => {
  for (const count of [1, 20]) {
    const result = writeSdk(scaleDocument(count), {
      output: path.join(tmpdir(), `openapi-no-runtime-${count}`),
      name: 'Scale',
      profile: { mobx: false, validation: true },
    });
    assert.equal(result.artifacts.some(artifact => artifact.path.endsWith(`${path.sep}client-runtime.ts`)), false);
  }
});

test('10, 100, and 500 operations share one nested schema closure and grow linearly', () => {
  const sizes: number[] = [];
  const closureCounts: number[] = [];
  const closureBytes: number[] = [];
  for (const count of [10, 100, 500]) {
    const output = path.join(tmpdir(), `openapi-scale-${count}`);
    const result = writeSdk(scaleDocument(count), {
      output,
      name: 'Scale',
      profile: { mobx: false, validation: true },
    });
    const operationArtifacts = result.artifacts.filter(artifact => artifact.path.includes(`${path.sep}operations${path.sep}`)
      && artifact.path.endsWith('.ts') && !artifact.path.endsWith('.d.ts'));
    const shared = schemaClosureArtifacts(result.artifacts);
    assert.equal(operationArtifacts.length, count);
    assert.ok(shared.length >= 2, 'nested component dependencies are extracted into shared modules');
    sizes.push(result.artifacts.reduce((total, artifact) => total + Buffer.byteLength(artifact.content), 0));
    closureCounts.push(shared.length);
    closureBytes.push(shared.reduce((total, artifact) => total + Buffer.byteLength(artifact.content), 0));
  }
  assert.ok(sizes[1] !== undefined && sizes[0] !== undefined && sizes[1] <= sizes[0] * 12,
    `100-operation source set remains proportional to 10 operations: ${sizes.join(', ')}`);
  assert.ok(sizes[2] !== undefined && sizes[1] !== undefined && sizes[2] <= sizes[1] * 6,
    `500-operation source set remains proportional to 100 operations: ${sizes.join(', ')}`);
  assert.equal(new Set(closureCounts).size, 1, 'operation count does not duplicate shared nested component modules');
  assert.equal(new Set(closureBytes).size, 1, 'shared component schema bytes stay constant as endpoints grow');
});

test('sequential same-title generation jobs keep schema and resource contexts isolated', () => {
  const first = writeSdk(contextDocument('alpha'), {
    output: path.join(tmpdir(), 'openapi-context-alpha'),
    name: 'Context',
    profile: { mobx: false, validation: true },
  });
  const second = writeSdk(contextDocument('beta'), {
    output: path.join(tmpdir(), 'openapi-context-beta'),
    name: 'Context',
    profile: { mobx: false, validation: true },
  });
  const firstShared = schemaClosureArtifacts(first.artifacts);
  const secondShared = schemaClosureArtifacts(second.artifacts);
  assert.ok(firstShared.length > 0);
  assert.ok(secondShared.length > 0);
  assert.ok(firstShared.every(artifact => !artifact.content.includes('beta')));
  assert.ok(secondShared.every(artifact => !artifact.content.includes('alpha')));
  assert.ok(firstShared.some(artifact => artifact.content.includes('alpha')));
  assert.ok(secondShared.some(artifact => artifact.content.includes('beta')));
  const firstOperation = first.artifacts.find(artifact => artifact.path.endsWith('/operations/putEnvelope.ts'))?.content ?? '';
  const secondOperation = second.artifacts.find(artifact => artifact.path.endsWith('/operations/putEnvelope.ts'))?.content ?? '';
  assert.notEqual(firstOperation, secondOperation, 'operation references carry each job’s digest-qualified schema context');
});

test('schemas whose names the codec rule shortens still get output files and exports', t => {
  const { source } = fixture(t);
  const object = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  const operation = (name: string) => ({ operationId: `get${name.replace(/[^A-Za-z]/g, '')}`, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } } });
  const names = ['PaymentModel', 'TPayment', 'Pay$ment'];
  const document = {
    openapi: '3.1.0',
    info: { title: 'Shortened', version: '1' },
    paths: Object.fromEntries(names.map((name, index) => [`/p${index}`, { get: operation(name) }])),
    components: { schemas: { PaymentModel: object, TPayment: { ...object, properties: { amount: { type: 'number' } }, required: ['amount'] }, 'Pay$ment': object } },
  };
  const result = writeGeneratedSdk(writeSdk, document, { output: source, name: 'Shortened', profile: { mobx: false, validation: false } });
  compileStrictUnusedSdk(source);
  const files = new Set(result.artifacts.map((artifact) => artifact.path));
  const index = result.artifacts.find((artifact) => artifact.path.endsWith(`${path.sep}index.ts`))?.content ?? '';
  const exported = [...index.matchAll(/from '\.\/models\/([^']+)\.js'/g)].map((match) => match[1]!);
  assert.ok(exported.length > 0, 'the index re-exports models');
  for (const name of exported) assert.ok(files.has(path.join(source, 'models', `${name}.ts`)), `models/${name}.ts is written`);
});

const SHORTENED_OPTIONS = { strict: true, noUnusedLocals: true, noUnusedParameters: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } as const;

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
  compileGeneratedSdk(source, [], SHORTENED_OPTIONS);
  const sdk = requireRecord(await import(pathToFileURL(path.join(source, 'dist/index.js')).href), 'shortened sdk');
  return { result, sdk };
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

test('schemas that shorten alike but differ in shape keep separate codecs', async t => {
  const { result, sdk } = await generateShortened(t, { PaymentModel: idObject, TPayment: amountObject });
  const keys = result.artifacts.find((artifact) => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
  const entries = [...keys.matchAll(/"([^"]+)#(\w+)": "(Payment_[0-9a-f]+)"/g)];
  assert.deepEqual(entries.map((entry) => entry[2]).sort(), ['Payment', 'PaymentModel'], 'keys use the names the plugin derives from PaymentModelModel and TPaymentModel');
  assert.equal(new Set(entries.map((entry) => entry[1])).size, 2, 'two files');
  assert.equal(new Set(entries.map((entry) => entry[3])).size, 2, 'two codec ids');
  for (const entry of entries) {
    const declaring = result.artifacts.find((artifact) => artifact.path.endsWith(`/${entry[1]}`))?.content ?? '';
    assert.match(declaring, entry[2] === 'Payment' ? /export class TPaymentModel\b/ : /export class PaymentModelModel\b/);
  }
  roundTrip(sdk, 'PaymentModel', 'PaymentModelModel', { id: 'a' });
  roundTrip(sdk, 'TPayment', 'TPaymentModel', { amount: 3 });
});

test('a model that references schemas with shortened names imports their own classes', async t => {
  const holder = { type: 'object', properties: { a: { $ref: '#/components/schemas/PaymentModel' }, b: { $ref: '#/components/schemas/Pay$ment' } }, required: ['a', 'b'] };
  const { sdk } = await generateShortened(t, { PaymentModel: idObject, 'Pay$ment': amountObject, Holder: holder });
  roundTrip(sdk, 'Holder', 'HolderModel', { a: { id: 'a' }, b: { amount: 2 } });
});

test('a single schema with a shortened name generates and round-trips', async t => {
  const model = await generateShortened(t, { PaymentModel: idObject });
  roundTrip(model.sdk, 'PaymentModel', 'PaymentModelModel', { id: 'a' });
});

test('a single schema with a dollar sign in its name generates and round-trips', async t => {
  const model = await generateShortened(t, { 'Pay$ment': amountObject });
  roundTrip(model.sdk, 'Pay$ment', 'Pay$mentModel', { amount: 1 });
});

test('two schemas of equal shape that shorten alike are rejected with both names', t => {
  const { source } = fixture(t);
  assert.throws(
    () => writeGeneratedSdk(writeSdk, shortenedDocument({ PaymentModel: idObject, TPayment: idObject }), { output: source, name: 'Shortened', profile: { mobx: false, validation: false } }),
    /OpenAPI components "PaymentModel" and "TPayment" both map to the model name "Payment"\. Rename one of them\./,
  );
});
