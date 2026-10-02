import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { applyRewrites, readRewriteIndex } from '#golem/rewrite';
import { checkNestCodecs, scanProjectRewrites, type ScanResult } from '#golem/rewrite-scan';
import { generate } from '#model/generator';
import { readFixture, writeGeneratedArtifacts } from '../fixture-project.js';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { paymentModelSource } from '../fixture-templates/controllers/payment-model.js';

const PLUGIN = 'controllers/nest-plugin';
const CHECKS = `${PLUGIN}/rewrite-checks-parameters-against-operation-codecs`;
const CONTROLLER = 'src/payments.controller.ts';
const NEST_IMPORT = "import { nestModelCodec as __golem_nestModelCodec, nestModelReturn as __golem_nestModelReturn } from '@exprtlabs/golem/nest';";

/** A project of the named source files (under `src/`) with the models job's generated files written. */
function project(t: TestContext, files: Readonly<Record<string, string>>): string {
  const root = createControllerFixture(t, {
    prefix: 'golem-rewrite-nest-',
    links: 'workspace',
    files: { 'golem.yaml': 'version: 1\nmodels: { root: . }\n', ...files },
  });
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  return root;
}

function paymentsProject(t: TestContext, extra: Readonly<Record<string, string>> = {}): string {
  return project(t, {
    'src/payment.model.ts': readFixture(`${PLUGIN}/project/payment.model.ts`),
    [CONTROLLER]: readFixture(`${PLUGIN}/project/payments.controller.ts`),
    ...extra,
  });
}

function scan(root: string, nest = true): ScanResult {
  return scanProjectRewrites({ root, nest });
}

function rewritten(root: string, result: ScanResult, relative: string): string {
  const output = applyRewrites(relative, fs.readFileSync(path.join(root, relative), 'utf8'), result.index);
  assert.ok(output, `${relative} has an index entry`);
  return output.code;
}

/** The decorator lines above a method and its signature line, as the controller fixture lays them out. */
function method(code: string, name: string): { readonly decorators: string; readonly signature: string } {
  const match = new RegExp(`((?:  @[^\\n]*\\n)+)  ${name}\\(([^\\n]*)`).exec(code);
  assert.ok(match?.[1] !== undefined && match[2] !== undefined, `${name} is in the rewritten controller`);
  return { decorators: match[1], signature: match[2] };
}

test('with nest on, a model @Body() or @Query() parameter and a model return gain codec decorators', (t) => {
  const root = paymentsProject(t);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, CONTROLLER);
  assert.equal(code.split('\n')[0], NEST_IMPORT);
  assert.deepEqual(result.index.files[CONTROLLER]?.imports, [{ from: '@exprtlabs/golem/nest', names: ['nestModelCodec', 'nestModelReturn'] }]);

  const model = /@__golem_nestModelReturn\("TPayment_[0-9a-f]{8}"\) @Post\(\)/;
  const modelArray = /@__golem_nestModelReturn\("TPayment_[0-9a-f]{8}", true\) @Get\(\)/;
  const input = /@Body\(\) @__golem_nestModelCodec\("TPaymentInput_[0-9a-f]{8}"\) input: TPaymentInput/;

  const create = method(code, 'create');
  assert.match(create.decorators, model);
  assert.match(create.signature, input);
  const createAsClass = method(code, 'createAsClass');
  assert.match(createAsClass.signature, /@Body\(\) @__golem_nestModelCodec\("TPayment_[0-9a-f]{8}"\) input: Payment/);
  assert.doesNotMatch(createAsClass.decorators, /nestModelReturn/, 'a number return is not a model');
  const list = method(code, 'list');
  assert.match(list.decorators, modelArray);
  assert.match(list.signature, /@Query\(\) @__golem_nestModelCodec\("TPaymentFilter_[0-9a-f]{8}"\) filter: TPaymentFilter/);

  // A Promise-wrapped return records like a direct one, and a readonly array of models records as an array.
  assert.match(method(code, 'createAsync').decorators, /@__golem_nestModelReturn\("TPayment_[0-9a-f]{8}"\) @Post\("async"\)/);
  assert.match(method(code, 'listAsync').decorators, /@__golem_nestModelReturn\("TPayment_[0-9a-f]{8}", true\) @Get\("async"\)/);
  // A non-model return, and a union that includes a model, are left alone.
  assert.doesNotMatch(method(code, 'count').decorators, /nestModelReturn/);
  assert.doesNotMatch(method(code, 'either').decorators, /nestModelReturn/);
  // An array @Body() is stamped with the element codec; a pipe passed to @Body() or @Query() is kept.
  assert.match(method(code, 'createBatch').signature, /@Body\(\) @__golem_nestModelCodec\("TPaymentInput_[0-9a-f]{8}"\) inputs: TPaymentInput\[\]/);
  assert.match(method(code, 'createPiped').signature, /@Body\(customPipe\) @__golem_nestModelCodec\("TPaymentInput_[0-9a-f]{8}"\) input:/);
  assert.match(method(code, 'listPiped').signature, /@Query\(customPipe\) @__golem_nestModelCodec\("TPaymentFilter_[0-9a-f]{8}"\) filter:/);

  assert.equal(code.match(/__golem_nestModelReturn\(/g)?.length, 4);
  assert.equal(code.match(/__golem_nestModelCodec\(/g)?.length, 6);
});

test('without nest the controller is not indexed', (t) => {
  const root = paymentsProject(t);
  const result = scan(root, false);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.index.files[CONTROLLER], undefined);
  assert.deepEqual(result.nestCodecSites, []);
});

test('a decorator that is already present, plain, through a namespace or aliased, is kept and adds no edit', (t) => {
  const root = paymentsProject(t, {
    'src/plain.controller.ts': readFixture(`${PLUGIN}/rewrite-keeps-existing-codec-decorators/plain.controller.ts`),
    'src/aliased.controller.ts': readFixture(`${PLUGIN}/rewrite-keeps-existing-codec-decorators/aliased.controller.ts`),
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.index.files['src/plain.controller.ts'], undefined);
  assert.equal(result.index.files['src/aliased.controller.ts'], undefined);
});

test('a primitive @Body() and a type no model table names are not indexed', (t) => {
  const primitive = project(t, {
    'src/notes.controller.ts': readFixture(`${PLUGIN}/ttsc-compiles-a-primitive-body-and-fails-parse-of-a-missing-model/notes.controller.ts`),
  });
  const unknown = project(t, {
    'src/notes.controller.ts': readFixture(`${PLUGIN}/ttsc-fails-when-a-table-known-body-payment-cannot-bind-to-one-hashed-id/notes.controller.ts`),
  });
  for (const root of [primitive, unknown]) {
    const result = scan(root);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.index.files['src/notes.controller.ts'], undefined);
    assert.deepEqual(result.nestCodecSites, []);
  }
});

test('two Payment contracts keep distinct ids in their controllers', (t) => {
  const root = project(t, {
    'src/billing/payment.model.ts': paymentModelSource({ field: 'amount', fieldType: 'number' }).text,
    'src/payout/payment.model.ts': paymentModelSource({ field: 'destination', fieldType: 'string' }).text,
    'src/billing.controller.ts': readFixture(`${PLUGIN}/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids/billing.controller.ts`),
    'src/payout.controller.ts': readFixture(`${PLUGIN}/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids/payout.controller.ts`),
  });
  const keys = fs.readFileSync(path.join(root, 'src/generated/models/iobject-plugin-keys.ts'), 'utf8');
  const billingId = keys.match(/src\/billing\/payment\.model\.ts#TPayment": "([^"]+)"/)?.[1];
  const payoutId = keys.match(/src\/payout\/payment\.model\.ts#TPayment": "([^"]+)"/)?.[1];
  assert.ok(billingId && payoutId && billingId !== payoutId);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const billing = rewritten(root, result, 'src/billing.controller.ts');
  const payout = rewritten(root, result, 'src/payout.controller.ts');
  assert.ok(billing.includes(`@__golem_nestModelCodec("${billingId}") input`), billing);
  assert.ok(payout.includes(`@__golem_nestModelCodec("${payoutId}") input`), payout);
  assert.ok(!billing.includes(payoutId) && !payout.includes(billingId));
});

test('a table-known @Body() type that binds to no single id fails with its position', (t) => {
  // The payments fixture's Payment class puts the name in the tables, so the interface below is known but binds to no id.
  const root = paymentsProject(t, {
    'src/billing/payment.model.ts': paymentModelSource({ field: 'amount', fieldType: 'number' }).text,
    'src/payout/payment.model.ts': paymentModelSource({ field: 'destination', fieldType: 'string' }).text,
    'src/notes.controller.ts': readFixture(`${PLUGIN}/ttsc-fails-when-a-table-known-body-payment-cannot-bind-to-one-hashed-id/notes.controller.ts`),
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics.map(({ code, file, line, column, message }) => ({ code, file, line, column, message })), [{
    code: 'RUNM1071',
    file: 'src/notes.controller.ts',
    line: 6,
    column: 25,
    message: '@Body() type Payment has no unique codec id',
  }]);
});

test('a method that a decorator cannot decorate is not indexed: an object literal, an abstract method, an overload signature', (t) => {
  const root = paymentsProject(t, {
    'src/loose.ts': readFixture(`${PLUGIN}/rewrite-skips-methods-a-decorator-cannot-reach/loose.ts`),
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, 'src/loose.ts');
  assert.equal(code.match(/__golem_nestModelReturn\(/g)?.length, 1, code);
  assert.match(code, /@__golem_nestModelReturn\("TPayment_[0-9a-f]{8}"\) find\(id: string \| number\): TPayment \{/);
  assert.ok(code.includes('  find(id: string): TPayment;\n'), 'the overload signature is untouched');
  assert.ok(code.includes('  load(): TPayment {'), 'the object literal method is untouched');
});

test('the operation-codec check passes when the registry holds every id the scan indexed, and fails when it does not', (t) => {
  const root = paymentsProject(t);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const registry = path.join(root, 'src/generated/operation-codecs.ts');

  assert.equal(result.nestCodecSites.length, 6, 'one site for each parameter that gained a codec');
  const { id, label, decorator } = result.nestCodecSites[0]!;
  assert.deepEqual(result.nestCodecSites.map(site => site.file), Array(6).fill(CONTROLLER));
  assert.match(id, /^TPaymentInput_[0-9a-f]{8}$/);
  assert.equal(label, 'TPaymentInput');
  assert.equal(decorator, 'Body');

  const ids = [...new Set(result.nestCodecSites.map(site => site.id))];
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, `export const OPERATION_CODECS = {\n${ids.map((each, index) => `  "POST /${index}": "${each}",\n`).join('')}};\n`);
  assert.deepEqual(checkNestCodecs(root, result), []);

  fs.writeFileSync(registry, fs.readFileSync(registry, 'utf8').replace(id, 'TPaymentInput_00000000'));
  const failures = checkNestCodecs(root, result);
  assert.deepEqual(failures.map(({ code, file, message }) => ({ code, file, message })), [
    ...Array(3).fill({ code: 'RUNM1072', file: CONTROLLER, message: '@Body() type TPaymentInput disagrees with generated operation keys' }),
  ]);
  assert.deepEqual([failures[0]?.line, failures[0]?.column], [7, 25]);

  fs.rmSync(registry);
  assert.equal(checkNestCodecs(root, result).length, 6, 'a missing registry disagrees with every site');
});

test('the operation-codec check has nothing to compare when the project has no nest sites', (t) => {
  const root = paymentsProject(t);
  assert.deepEqual(checkNestCodecs(root, scan(root, false)), [], 'no registry is needed when nest is off');
});

test('a controllers job turns nest on, and golem check fails a parameter the generated operations do not hold', async (t) => {
  const root = createControllerFixture(t, {
    prefix: 'golem-rewrite-nest-pipeline-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': readFixture(`${PLUGIN}/project/payment.model.ts`),
      [CONTROLLER]: readFixture(`${CHECKS}/payments.controller.ts`),
      'golem.yaml': [
        'version: 1',
        'mobx: false',
        'validation: true',
        'controllers:',
        '  - root: .',
        '    sources:',
        `      - ${CONTROLLER}`,
        '    output: generated/api.json',
        '    info: { title: Test API, version: "1" }',
        'models:',
        '  root: .',
        '',
      ].join('\n'),
    },
  });
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  assert.deepEqual(readRewriteIndex(root)?.files[CONTROLLER]?.imports, [{ from: '@exprtlabs/golem/nest', names: ['nestModelCodec', 'nestModelReturn'] }]);
  await runPipeline(config, { check: true });

  // A method outside the controllers job's sources is stamped by the scan but is in no generated operation.
  fs.writeFileSync(path.join(root, 'src/helper.controller.ts'), readFixture(`${CHECKS}/helper.controller.ts`));
  await runPipeline(config);
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1072 \(src\/helper\.controller\.ts:4:\d+\): @Query\(\) type TPaymentFilter disagrees with generated operation keys/);
});
