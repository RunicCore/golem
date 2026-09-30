import { readFixture, writeGeneratedArtifacts } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#model/generator';
import { command, workspace } from '../support/process.js';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { paymentModelSource } from '../fixture-templates/controllers/payment-model.js';

function fixture(t: TestContext): string {
  return createControllerFixture(t, {
    prefix: 'runic-nest-plugin-',
    links: 'workspace',
    tsconfig: {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
        outDir: 'build',
        rootDir: 'src',
        types: ['node'],
        plugins: [{ transform: '@exprtlabs/ts-to-openapi/ttsc-plugin' }],
      },
      include: ['src/**/*.ts'],
    },
    files: {
      'src/payment.model.ts': readFixture('controllers/nest-plugin/project/payment.model.ts'),
      'src/payments.controller.ts': readFixture('controllers/nest-plugin/project/payments.controller.ts'),
      'runic-codegen.yaml': 'version: 1\nmodels: { root: . }\n',
    },
  });
}


// The decorators TypeScript emits for one controller method.
function decoratorsOf(emitted: string, method: string): string {
  const block = new RegExp(`__decorate\\(\\[((?:(?!__decorate\\()[\\s\\S])*?)\\], PaymentsController\\.prototype, "${method}"`);
  const match = emitted.match(block);
  assert.ok(match?.[1], `${method} has emitted decorators`);
  return match[1];
}

test('ttsc nest plugin registers nestModelCodec and nestModelReturn metadata, keeps custom pipes, and does not attach pipes or interceptors', async (t) => {
  const root = fixture(t);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
  const emitted = fs.readFileSync(path.join(root, 'build/payments.controller.js'), 'utf8');
  const model = /nestModelReturn\("Payment_[0-9a-f]{8}"\)/;
  const modelArray = /nestModelReturn\("Payment_[0-9a-f]{8}", true\)/;

  const create = decoratorsOf(emitted, 'create');
  assert.match(create, /__param\(0, Body\(\)\)/);
  assert.match(create, /__param\(0, nestModelCodec\("PaymentInput_[0-9a-f]{8}"\)\)/);
  assert.match(create, model);
  const createAsClass = decoratorsOf(emitted, 'createAsClass');
  assert.match(createAsClass, /__param\(0, Body\(\)\)/);
  assert.match(createAsClass, /__param\(0, nestModelCodec\("Payment_[0-9a-f]{8}"\)\)/);
  const list = decoratorsOf(emitted, 'list');
  assert.match(list, /__param\(0, Query\(\)\)/);
  assert.match(list, /__param\(0, nestModelCodec\("PaymentFilter_[0-9a-f]{8}"\)\)/);
  assert.match(list, modelArray);

  // Promise-wrapped model returns are recorded like direct ones.
  assert.match(decoratorsOf(emitted, 'createAsync'), model);
  assert.match(decoratorsOf(emitted, 'listAsync'), modelArray);
  // A non-model return, and a union that includes a model, are left alone.
  assert.doesNotMatch(decoratorsOf(emitted, 'count'), /nestModelReturn/);
  assert.doesNotMatch(decoratorsOf(emitted, 'either'), /nestModelReturn/);
  assert.equal(emitted.match(/nestModelReturn\(/g)?.length, 4);

  // An array @Body() is stamped with the element codec.
  const createBatch = decoratorsOf(emitted, 'createBatch');
  assert.match(createBatch, /__param\(0, Body\(\)\)/);
  assert.match(createBatch, /__param\(0, nestModelCodec\("PaymentInput_[0-9a-f]{8}"\)\)/);

  // A pipe already passed to @Body()/@Query() is kept and the codec metadata is still registered.
  const createPiped = decoratorsOf(emitted, 'createPiped');
  assert.match(createPiped, /Body\(customPipe\)/);
  assert.match(createPiped, /nestModelCodec\("PaymentInput_[0-9a-f]{8}"\)/);
  const listPiped = decoratorsOf(emitted, 'listPiped');
  assert.match(listPiped, /Query\(customPipe\)/);
  assert.match(listPiped, /nestModelCodec\("PaymentFilter_[0-9a-f]{8}"\)/);

  assert.doesNotMatch(emitted, /nestModelCodec\("[^"]+"\)\),,/);
  assert.doesNotMatch(emitted, /nestModelPipe/);
  assert.doesNotMatch(emitted, /UseInterceptors|NestModelInterceptor|nestModelStringifyInterceptor/);
  assert.match(emitted, /from '@exprtlabs\/codegen\/nest'/);
  assert.doesNotMatch(emitted, /OPERATION_CODECS/);
});

test('two Payment contracts keep distinct hashed nestModelCodec ids', async (t) => {
  const root = fixture(t);
  writeGeneratedArtifacts([
    { path: path.join(root, 'src/billing/payment.model.ts'), content: paymentModelSource({ field: 'amount', fieldType: 'number' }).text },
    { path: path.join(root, 'src/payout/payment.model.ts'), content: paymentModelSource({ field: 'destination', fieldType: 'string' }).text },
    {
      path: path.join(root, 'src/billing.controller.ts'),
      content: readFixture('controllers/nest-plugin/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids/billing.controller.ts'),
    },
    {
      path: path.join(root, 'src/payout.controller.ts'),
      content: readFixture('controllers/nest-plugin/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids/payout.controller.ts'),
    },
  ]);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const keys = result.artifacts.find((artifact) => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
  const billingId = keys.match(/src\/billing\/payment\.model\.ts#Payment": "([^"]+)"/)?.[1];
  const payoutId = keys.match(/src\/payout\/payment\.model\.ts#Payment": "([^"]+)"/)?.[1];
  assert.ok(billingId);
  assert.ok(payoutId);
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
  const billing = fs.readFileSync(path.join(root, 'build/billing.controller.js'), 'utf8');
  const payout = fs.readFileSync(path.join(root, 'build/payout.controller.js'), 'utf8');
  assert.match(billing, new RegExp(`nestModelCodec\\("${billingId}"\\)`));
  assert.match(payout, new RegExp(`nestModelCodec\\("${payoutId}"\\)`));
  assert.doesNotMatch(billing, new RegExp(`nestModelCodec\\("${payoutId}"\\)`));
  assert.doesNotMatch(payout, new RegExp(`nestModelCodec\\("${billingId}"\\)`));
});

test('ttsc fails when a table-known @Body() Payment cannot bind to one hashed id', async (t) => {
  const root = fixture(t);
  writeGeneratedArtifacts([
    { path: path.join(root, 'src/billing/payment.model.ts'), content: paymentModelSource({ field: 'amount', fieldType: 'number' }).text },
    { path: path.join(root, 'src/payout/payment.model.ts'), content: paymentModelSource({ field: 'destination', fieldType: 'string' }).text },
    {
      path: path.join(root, 'src/notes.controller.ts'),
      content: readFixture('controllers/nest-plugin/ttsc-fails-when-a-table-known-body-payment-cannot-bind-to-one-hashed-id/notes.controller.ts'),
    },
  ]);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const failed = await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ], { allowFailure: true });
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /src\/notes\.controller\.ts:\d+:\d+: @Body\(\) type Payment has no unique hashed codec id/);
});

test('ttsc compiles a primitive @Body() and fails parse of a missing model', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'src/notes.controller.ts'), readFixture("controllers/nest-plugin/ttsc-compiles-a-primitive-body-and-fails-parse-of-a-missing-model/notes.controller.ts"));
  const generated = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(generated.artifacts);
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
  const emitted = fs.readFileSync(path.join(root, 'build/notes.controller.js'), 'utf8');
  assert.match(emitted, /__param\(0, Body\(\)\)/);
  assert.doesNotMatch(emitted, /nestModelCodec/);

  fs.writeFileSync(
    path.join(root, 'src/missing.ts'),
    readFixture('controllers/nest-plugin/ttsc-compiles-a-primitive-body-and-fails-parse-of-a-missing-model/missing.ts'),
  );
  const failed = await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ], { allowFailure: true });
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /parse<MissingModel> has no unique hashed codec id/);
  assert.match(failed.stderr, /src\/missing\.ts/);
});

test('serde rewrite and nest codec metadata share one ttsc emit', async (t) => {
  const root = fixture(t);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { plugins: { transform: string }[] };
  };
  tsconfig.compilerOptions.plugins = [
    { transform: '@exprtlabs/codegen/ttsc-plugin' },
    { transform: '@exprtlabs/ts-to-openapi/ttsc-plugin' },
  ];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  fs.writeFileSync(
    path.join(root, 'src/read.ts'),
    readFixture('controllers/nest-plugin/project/read.ts'),
  );
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const compiled = await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ], { allowFailure: true });
  assert.equal(compiled.stderr.includes('multiple transform native backends'), false, compiled.stderr);
  assert.equal(compiled.code, 0, compiled.stderr);
  const controller = fs.readFileSync(path.join(root, 'build/payments.controller.js'), 'utf8');
  const reader = fs.readFileSync(path.join(root, 'build/read.js'), 'utf8');
  assert.match(controller, /nestModelCodec\("PaymentInput_[0-9a-f]{8}"\)/);
  assert.match(reader, /requireObjectCodec\("PaymentInput_[0-9a-f]{8}"\)\.parse\(/);
});
