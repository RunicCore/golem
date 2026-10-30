import { copyFixtureFile, createFixtureProject, readFixture, linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { parse } from 'yaml';
import test, { type TestContext } from 'node:test';

import { generate as generateModels } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import {
  compileGeneratedSdk,
  repoRoot,
  requireRecord,
  sdkBodyCodec,
  withRootOperations,
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

/** An operation factory run against a fetch that answers with the request body. */
function echoOperation(factory: unknown, name: string): Operation {
  if (typeof factory !== 'function') throw new TypeError(`${name} factory is missing`);
  return factory({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => new Response(String(init?.body), {
      headers: { 'content-type': 'application/json' },
    }),
  }) as Operation;
}

/** The one validators module of an SDK: its models and its operations share it. */
function sdkValidatorArtifacts(artifacts: readonly { readonly path: string; readonly content: string }[]): readonly { readonly path: string; readonly content: string }[] {
  return artifacts.filter((artifact) => path.basename(artifact.path) === 'validators.generated.ts');
}

test('a direct operation entrypoint loads only its generated closure', async t => {
  const { source } = fixture(t);
  writeGeneratedSdk(writeSdk, moduleDocument(), {
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

  const operationModule = requireRecord(
    await import(pathToFileURL(path.join(source, 'dist/operations/echoTree.js')).href),
    'direct operation module',
  );
  assert.equal(typeof operationModule.echoTree, 'function');
  const operationFactory = operationModule.echoTree;
  const operation = echoOperation(operationFactory, 'echoTree');
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
  const operation = echoOperation(operationFactory, 'submitPayload');
  const payload = { first: { first: 'one' }, second: { second: 2 } };
  assert.deepEqual((await operation.execute({ body: payload })).body, payload);
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

test('a model with a constant field only and a model with no field compile under noUnusedParameters and still write their JSON', async t => {
  // protects: T-295 a stringify core that reads no value declares it as _value
  // protects: T-319 a model class with no field, base or additional property declares its constructor and encode parameters as _values and _model
  const { source } = fixture(t);
  const operation = (operationId: string, schema: Record<string, unknown>) => ({
    post: {
      operationId,
      requestBody: { required: true, content: { 'application/json': { schema } } },
      responses: { 200: { description: 'echo', content: { 'application/json': { schema } } } },
    },
  });
  writeGeneratedSdk(writeSdk, {
    openapi: '3.1.0',
    info: { title: 'Fieldless Models', version: '1' },
    components: { schemas: {
      Fixed: { type: 'object', required: ['kind'], properties: { kind: { const: 'only' } }, additionalProperties: false },
      Empty: { type: 'object', properties: {}, additionalProperties: false },
    } },
    paths: {
      '/fixed': operation('putFixed', { $ref: '#/components/schemas/Fixed' }),
      '/empty': operation('putEmpty', { type: 'object', properties: {}, additionalProperties: false }),
      '/empty-model': operation('putEmptyModel', { $ref: '#/components/schemas/Empty' }),
    },
  }, { output: source, name: 'Fieldless', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(source, [], STRICT_OPTIONS);
  const fixed = await loadOperation(source, 'putFixed');
  await fixed.operation.execute({ body: { kind: 'only' } });
  const empty = await loadOperation(source, 'putEmpty');
  await empty.operation.execute({ body: {} });
  const emptyModel = await loadOperation(source, 'putEmptyModel');
  await emptyModel.operation.execute({ body: {} });
  assert.deepEqual([fixed.requests, empty.requests, emptyModel.requests], [['{"kind":"only"}'], ['{}'], ['{}']]);
});

test('the SDK validators module exports one named function per root and no record', async t => {
  const { source } = fixture(t);
  const result = writeGeneratedSdk(writeSdk, contextDocument('alpha'), { output: source, name: 'Context', profile: { mobx: false, validation: true } });
  assert.equal(sdkValidatorArtifacts(result.artifacts).length, 1);
  compileGeneratedSdk(source, [], STRICT_OPTIONS);
  const module = requireRecord(await import(pathToFileURL(path.join(source, 'dist/validators.generated.js')).href), 'validators module');
  // The operation roots get no fast check; the model of this document converts nothing, so no group reads its root and the module holds none.
  assert.deepEqual(Object.keys(module).map(name => name.replace(/_[0-9a-f]{8}$/, '_<hash>')).sort(), [
    'validate_putEnvelope_input',
    'validate_putEnvelope_response_200_application_json',
  ]);
  assert.ok(Object.values(module).every(value => typeof value === 'function'), 'every export is a function, not a record');
});

function shortenedDocument(schemas: Record<string, unknown>): Record<string, unknown> {
  return withRootOperations({ openapi: '3.1.0', info: { title: 'Shortened', version: '1' }, paths: {}, components: { schemas } }, ...Object.keys(schemas));
}

const AT = '2024-05-06T07:08:09.000Z';
const at = { type: 'string', format: 'date-time' };
const idObject = { type: 'object', properties: { id: { type: 'string' }, at }, required: ['id'] };
const amountObject = { type: 'object', properties: { amount: { type: 'number' }, at }, required: ['amount'] };

async function generateShortened(t: TestContext, schemas: Record<string, unknown>) {
  const { source } = fixture(t);
  writeGeneratedSdk(writeSdk, shortenedDocument(schemas), { output: source, name: 'Shortened', profile: { mobx: false, validation: false } });
  compileGeneratedSdk(source, [], STRICT_OPTIONS);
  return source;
}

/** Decodes `wire` of the schema `root` to `value` (its dates are Date) and encodes `value` back to `wire`. */
async function roundTrip(source: string, root: string, wire: unknown, value: unknown): Promise<void> {
  const codec = await sdkBodyCodec(source, 'Shortened', root);
  assert.deepEqual(await codec.decode(wire), value, `${root} decodes`);
  assert.deepEqual(await codec.encode(value), wire, `${root} encodes`);
}

test('a model that references schemas with shortened names converts each by its own schema', async t => {
  const holder = { type: 'object', properties: { a: { $ref: '#/components/schemas/PaymentModel' }, b: { $ref: '#/components/schemas/Pay$ment' } }, required: ['a', 'b'] };
  const source = await generateShortened(t, { PaymentModel: idObject, 'Pay$ment': amountObject, Holder: holder });
  await roundTrip(source, 'Holder', { a: { id: 'a', at: AT }, b: { amount: 2, at: AT } }, { a: { id: 'a', at: new Date(AT) }, b: { amount: 2, at: new Date(AT) } });
});

test('a single schema with a dollar sign in its name generates and round-trips', async t => {
  const source = await generateShortened(t, { 'Pay$ment': amountObject });
  await roundTrip(source, 'Pay$ment', { amount: 1, at: AT }, { amount: 1, at: new Date(AT) });
});

test('two schemas of equal shape whose names once shortened alike each convert on their own', async t => {
  const source = await generateShortened(t, { PaymentModel: idObject, TPayment: idObject });
  await roundTrip(source, 'PaymentModel', { id: 'a', at: AT }, { id: 'a', at: new Date(AT) });
  await roundTrip(source, 'TPayment', { id: 'b', at: AT }, { id: 'b', at: new Date(AT) });
});

function holderOf(...targets: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(targets.map((target, index) => [`f${index}`, { $ref: `#/components/schemas/${target}` }])),
    required: targets.map((_, index) => `f${index}`),
  };
}

test('a holder of PaymentModel and TPayment compiles and converts both', async t => {
  const source = await generateShortened(t, { PaymentModel: idObject, TPayment: amountObject, Holder: holderOf('PaymentModel', 'TPayment') });
  await roundTrip(source, 'PaymentModel', { id: 'a', at: AT }, { id: 'a', at: new Date(AT) });
  await roundTrip(source, 'TPayment', { amount: 3, at: AT }, { amount: 3, at: new Date(AT) });
  await roundTrip(source, 'Holder', { f0: { id: 'a', at: AT }, f1: { amount: 2, at: AT } }, { f0: { id: 'a', at: new Date(AT) }, f1: { amount: 2, at: new Date(AT) } });
});

test('a holder of Payment and TPayment compiles and converts both', async t => {
  const source = await generateShortened(t, { Payment: idObject, TPayment: amountObject, Holder: holderOf('Payment', 'TPayment') });
  await roundTrip(source, 'Holder', { f0: { id: 'a', at: AT }, f1: { amount: 2, at: AT } }, { f0: { id: 'a', at: new Date(AT) }, f1: { amount: 2, at: new Date(AT) } });
});

function optionalRef(target: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${target}` };
}

test('a cycle through a schema whose name shortens like another compiles and converts', async t => {
  const holder = { type: 'object', properties: { t: optionalRef('TPayment') } };
  const tPayment = { ...amountObject, properties: { amount: { type: 'number' }, at, h: optionalRef('Holder') } };
  const source = await generateShortened(t, { Payment: idObject, TPayment: tPayment, Holder: holder });
  await roundTrip(source, 'Payment', { id: 'a', at: AT }, { id: 'a', at: new Date(AT) });
  await roundTrip(source, 'TPayment', { amount: 1, h: { t: { amount: 2, at: AT } } }, { amount: 1, h: { t: { amount: 2, at: new Date(AT) } } });
});

test('a cycle through schemas that shorten alike with a Model suffix compiles and converts', async t => {
  const holder = { type: 'object', properties: { t: optionalRef('TPaymentModel') } };
  const tPayment = { type: 'object', properties: { flag: { type: 'boolean' }, at, h: optionalRef('Holder') }, required: ['flag'] };
  const source = await generateShortened(t, { PaymentModel: idObject, TPaymentModel: tPayment, Holder: holder });
  await roundTrip(source, 'PaymentModel', { id: 'a', at: AT }, { id: 'a', at: new Date(AT) });
  await roundTrip(source, 'TPaymentModel', { flag: true, h: { t: { flag: false, at: AT } } }, { flag: true, h: { t: { flag: false, at: new Date(AT) } } });
});

test('two schemas that once shortened alike and reference each other compile and convert', async t => {
  const payment = { type: 'object', properties: { id: { type: 'string' }, at, t: optionalRef('TPayment') }, required: ['id'] };
  const tPayment = { type: 'object', properties: { amount: { type: 'number' }, at, p: optionalRef('Payment') }, required: ['amount'] };
  const source = await generateShortened(t, { Payment: payment, TPayment: tPayment });
  await roundTrip(source, 'Payment', { id: 'a', t: { amount: 1, p: { id: 'b', at: AT } } }, { id: 'a', t: { amount: 1, p: { id: 'b', at: new Date(AT) } } });
  await roundTrip(source, 'TPayment', { amount: 2, p: { id: 'c', at: AT } }, { amount: 2, p: { id: 'c', at: new Date(AT) } });
});
