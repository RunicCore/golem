import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { applyRewrites } from '#golem/rewrite';
import { checkNestCodecs, scanProject, type ProgramScan } from '#golem/rewrite-scan';
import { generate } from '#model/generator';
import { readFixture, writeGeneratedArtifacts } from '../fixture-project.js';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { paymentModelSource } from '../fixture-templates/controllers/payment-model.js';

const PLUGIN = 'controllers/nest-plugin';
const FORMS = `${PLUGIN}/rewrite-covers-qualified-array-and-serde-forms`;
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

function scan(root: string, nest = true): ProgramScan {
  return scanProject({ root, directory: root, modelsRoot: root, configFile: path.join(root, 'tsconfig.json'), nest, codecKeysFile: path.join(root, '.golem/codec-keys.json') });
}

function rewritten(root: string, result: ProgramScan, relative: string): string {
  const entry = result.files.get(relative);
  assert.ok(entry, `${relative} has rewrites`);
  return applyRewrites(fs.readFileSync(path.join(root, relative), 'utf8'), entry).code;
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
  assert.deepEqual(result.files.get(CONTROLLER)?.imports, [{ from: '@exprtlabs/golem/nest', names: ['nestModelCodec', 'nestModelReturn'] }]);

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
  // An array @Body() is stamped with the element codec and the array flag; a pipe passed to @Body() or @Query() is kept.
  assert.match(method(code, 'createBatch').signature, /@Body\(\) @__golem_nestModelCodec\("TPaymentInput_[0-9a-f]{8}", true\) inputs: TPaymentInput\[\]/);
  assert.match(method(code, 'createPiped').signature, /@Body\(customPipe\) @__golem_nestModelCodec\("TPaymentInput_[0-9a-f]{8}"\) input:/);
  assert.match(method(code, 'listPiped').signature, /@Query\(customPipe\) @__golem_nestModelCodec\("TPaymentFilter_[0-9a-f]{8}"\) filter:/);

  assert.equal(code.match(/__golem_nestModelReturn\(/g)?.length, 4);
  assert.equal(code.match(/__golem_nestModelCodec\(/g)?.length, 6);
});

test('without nest the controller is not rewritten', (t) => {
  const root = paymentsProject(t);
  const result = scan(root, false);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.get(CONTROLLER), undefined);
  assert.deepEqual(result.nestCodecSites, []);
});

test('a decorator that is already present, plain, through a namespace or aliased, is kept and adds no edit', (t) => {
  const root = paymentsProject(t, {
    'src/plain.controller.ts': readFixture(`${PLUGIN}/rewrite-keeps-existing-codec-decorators/plain.controller.ts`),
    'src/aliased.controller.ts': readFixture(`${PLUGIN}/rewrite-keeps-existing-codec-decorators/aliased.controller.ts`),
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.get('src/plain.controller.ts'), undefined);
  assert.equal(result.files.get('src/aliased.controller.ts'), undefined);
});

test('a primitive @Body() and a type that is not a golem model are not rewritten, even when a model of the same name has keys', (t) => {
  const primitive = paymentsProject(t, {
    'src/notes.controller.ts': readFixture(`${PLUGIN}/rewrite-skips-a-primitive-body/notes.controller.ts`),
  });
  // The key table names a `Payment` model; this controller's `Payment` is a plain interface of its own file.
  const plain = paymentsProject(t, {
    'src/notes.controller.ts': readFixture(`${PLUGIN}/rewrite-skips-a-body-type-no-model-table-names/notes.controller.ts`),
  });
  for (const root of [primitive, plain]) {
    const result = scan(root);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.files.get('src/notes.controller.ts'), undefined);
    assert.deepEqual(result.nestCodecSites.filter(site => site.file === 'src/notes.controller.ts'), []);
  }
});

test('two Payment contracts keep distinct ids in their controllers', (t) => {
  const root = project(t, {
    'src/billing/payment.model.ts': paymentModelSource({ field: 'amount', fieldType: 'number' }).text,
    'src/payout/payment.model.ts': paymentModelSource({ field: 'destination', fieldType: 'string' }).text,
    'src/billing.controller.ts': readFixture(`${PLUGIN}/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids/billing.controller.ts`),
    'src/payout.controller.ts': readFixture(`${PLUGIN}/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids/payout.controller.ts`),
  });
  const keys = fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8');
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

test('a golem model that no key names fails with its position and what to run, as an alias and as a class', (t) => {
  // The model is added after golem generate ran, as when a dev server runs: no key table or manifest holds it.
  const root = paymentsProject(t);
  fs.writeFileSync(path.join(root, 'src/fresh.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TFreshBaseModel } from './fresh.model.generated.js';
export type TFresh = IModel<{ note: string }>;
export class Fresh extends TFreshBaseModel {}
`);
  fs.writeFileSync(path.join(root, 'src/fresh.model.generated.ts'), 'export class TFreshBaseModel {}\n');
  fs.writeFileSync(path.join(root, 'src/fresh.controller.ts'), `import { Body, Controller, Post } from '@nestjs/common';
import { Fresh, type TFresh } from './fresh.model.js';
@Controller('fresh')
export class FreshController {
  @Post()
  create(@Body() input: TFresh): number { return 1; }
  @Post('class')
  createAsClass(@Body() input: Fresh): number { return 1; }
}
`);
  const result = scan(root);
  assert.deepEqual(result.diagnostics.map(({ code, file, line, column, message }) => ({ code, file, line, column, message })), [
    { code: 'RUNM1071', file: 'src/fresh.controller.ts', line: 6, column: 25, message: '@Body() type TFresh has no unique codec id; run golem generate' },
    { code: 'RUNM1071', file: 'src/fresh.controller.ts', line: 8, column: 32, message: '@Body() type Fresh has no unique codec id; run golem generate' },
  ]);
  assert.equal(result.files.get('src/fresh.controller.ts'), undefined);
});

test('a method that a decorator cannot decorate is not rewritten: an object literal, an abstract method, an overload signature', (t) => {
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

/** The hashed codec id the models job wrote for a model of `src/payment.model.ts`. */
function idOf(root: string, name: string): string {
  const keys = fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8');
  const id = new RegExp(`src/payment\\.model\\.ts#${name}": "([^"]+)"`).exec(keys)?.[1];
  assert.ok(id, `${name} has a key`);
  return id;
}

function assertLines(code: string, expected: readonly string[]): void {
  const lines = code.split('\n').map(line => line.trimEnd());
  for (const line of expected) assert.ok(lines.includes(line), `missing line ${line}\n${code}`);
}

test('a parameter decorator reached through a namespace import is stamped', (t) => {
  const root = paymentsProject(t, { 'src/namespaced.controller.ts': readFixture(`${FORMS}/namespaced.controller.ts`) });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const input = idOf(root, 'TPaymentInput');
  const filter = idOf(root, 'TPaymentFilter');
  assertLines(rewritten(root, result, 'src/namespaced.controller.ts'), [
    `  create(@nest.Body() @__golem_nestModelCodec("${input}") input: TPaymentInput, @nest.Query() @__golem_nestModelCodec("${filter}") filter: TPaymentFilter): number { return input.note.length + (filter.limit?.length ?? 0); }`,
  ]);
});

test('Array<T> and Promise<T[]> returns record an array, and an Array<T> body takes the element codec', (t) => {
  const root = paymentsProject(t, { 'src/arrays.controller.ts': readFixture(`${FORMS}/arrays.controller.ts`) });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const payment = idOf(root, 'TPayment');
  const input = idOf(root, 'TPaymentInput');
  const code = rewritten(root, result, 'src/arrays.controller.ts');
  assertLines(code, [
    `  @__golem_nestModelReturn("${payment}", true) @Get('generic')`,
    `  @__golem_nestModelReturn("${payment}", true) @Get('promised')`,
    `  batch(@Body() @__golem_nestModelCodec("${input}", true) inputs: Array<TPaymentInput>): number { return inputs.length; }`,
  ]);
  assert.equal(code.match(/__golem_nestModelReturn\(/g)?.length, 2);
});

test('a method that calls parse and carries nest decorators gets both rewrites and both imports', (t) => {
  const root = paymentsProject(t, { 'src/mixed.controller.ts': readFixture(`${FORMS}/mixed.controller.ts`) });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const payment = idOf(root, 'TPayment');
  const input = idOf(root, 'TPaymentInput');
  const code = rewritten(root, result, 'src/mixed.controller.ts');
  assert.deepEqual(result.files.get('src/mixed.controller.ts')?.imports, [
    { from: '@exprtlabs/golem/nest', names: ['nestModelCodec', 'nestModelReturn'] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
  assert.deepEqual(
    result.files.get('src/mixed.controller.ts')?.edits.map(edit => /^@?(__golem_\w+)/.exec(edit.text)?.[1]),
    ['__golem_nestModelReturn', '__golem_nestModelCodec', '__golem_requireObjectCodec'],
    'edits are in source order',
  );
  assert.deepEqual(code.split('\n').slice(0, 2), [
    "import { nestModelCodec as __golem_nestModelCodec, nestModelReturn as __golem_nestModelReturn } from '@exprtlabs/golem/nest';",
    "import { requireObjectCodec as __golem_requireObjectCodec } from '@exprtlabs/golem/serde';",
  ]);
  assertLines(code, [
    `  @__golem_nestModelReturn("${payment}") @Post()`,
    `  create(@Body() @__golem_nestModelCodec("${input}") input: TPaymentInput): TPayment { return __golem_requireObjectCodec("${payment}").parse(JSON.stringify(input)); }`,
  ]);
});

test('the operation-codec check passes when the registry holds every id the scan found, and fails when it does not', (t) => {
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
  await runPipeline(config, { check: true });

  // A method outside the controllers job's sources is stamped by the scan but is in no generated operation.
  fs.writeFileSync(path.join(root, 'src/helper.controller.ts'), readFixture(`${CHECKS}/helper.controller.ts`));
  await runPipeline(config);
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1072 \(src\/helper\.controller\.ts:4:\d+\): @Query\(\) type TPaymentFilter disagrees with generated operation keys/);
});
