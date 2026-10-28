// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
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
/** The load of the module that registers the payment codecs, added for any codec the controller names. */
const PAYMENT_MODULE = "import './payment.model.generated.js';";
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

const notAModel = (decorator: string, type: string, mode: 'error' | 'warn' = 'error'): string => `${type} is not a golem model, and NestModelInterceptor answers HTTP 500 for a @${decorator}() parameter of that type. Declare the input as a golem model (IModel or IObject), or bind one field of a model type. ${mode === 'warn' ? 'Generation continues, because golem.yaml sets nonModelInputs: warn.' : 'An app with its own interceptor can set nonModelInputs: warn in golem.yaml.'}`;

function scan(root: string, nest = true, nonModelInputs?: 'error' | 'warn'): ProgramScan {
  return scanProject({ root, directory: root, modelsRoot: root, configFile: path.join(root, 'tsconfig.json'), nest, nonModelInputs, codecKeysFile: path.join(root, '.golem/codec-keys.json') });
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

test('a golem model named like a library type (Record, Map) binds as a model for a @Body() and a return', (t) => {
  // protects: round-2 finding 1: the written label Record was tested against the primitive type names before the symbol was resolved
  const root = project(t, {
    'src/record.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TRecordBaseModel } from './record.model.generated.js';
export type TRecord = IModel<{ id: string }>;
export class Record extends TRecordBaseModel {}
`,
    'src/record.controller.ts': `import { Body, Controller, Get, Post } from '@nestjs/common';
import { Record } from './record.model.js';
@Controller('records')
export class RecordController {
  @Post()
  create(@Body() r: Record): number { return 1; }
  @Get()
  async get(): Promise<Record> { throw new Error('unused'); }
}
`,
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, 'src/record.controller.ts');
  assert.match(method(code, 'create').signature, /@Body\(\) @__golem_nestModelCodec\("TRecord_[0-9a-f]{8}"\) r: Record/);
  assert.match(method(code, 'async get').decorators, /@__golem_nestModelReturn\("TRecord_[0-9a-f]{8}"\) @Get\(\)/);
});

test('with nest on, a model @Body() or @Query() parameter and a model return gain codec decorators', (t) => {
  const root = paymentsProject(t);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, CONTROLLER);
  assert.deepEqual(code.split('\n').slice(0, 2), [PAYMENT_MODULE, NEST_IMPORT]);
  assert.deepEqual(result.files.get(CONTROLLER)?.imports, [
    { from: './payment.model.generated.js', names: [] },
    { from: '@exprtlabs/golem/nest', names: ['nestModelCodec', 'nestModelReturn'] },
  ]);

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

// The key table names a `Payment` model; the `Payment` of the second controller is a plain interface of its own file.
for (const { name, fixture, type } of [
  { name: 'a primitive @Body()', fixture: 'rewrite-skips-a-primitive-body', type: 'string' },
  { name: 'a @Body() type that is not a golem model, even when a model of the same name has keys', fixture: 'rewrite-skips-a-body-type-no-model-table-names', type: 'Payment' },
]) {
  test(`${name} is not rewritten and gets RUNM1081`, (t) => {
    // protects: T-258 R-13 a body type the interceptor rejects is reported, and its controller is not rewritten
    const root = paymentsProject(t, { 'src/notes.controller.ts': readFixture(`${PLUGIN}/${fixture}/notes.controller.ts`) });
    const result = scan(root);
    assert.deepEqual(result.diagnostics.map(({ code, severity, file, message }) => ({ code, severity, file, message })), [
      { code: 'RUNM1081', severity: 'error', file: 'src/notes.controller.ts', message: notAModel('Body', type) },
    ]);
    assert.equal(result.files.get('src/notes.controller.ts'), undefined);
    assert.deepEqual(result.nestCodecSites.filter(site => site.file === 'src/notes.controller.ts'), []);
  });
}

const PLAIN_CONTROLLER = [
  "import { Body, Controller, Post, Query } from '@nestjs/common';",
  "import type { TPaymentInput } from './payment.model.js';",
  'class PlainInput { note = ""; }',
  "@Controller('plain')",
  'export class PlainController {',
  '  @Post() plain(@Body() input: PlainInput): number { return 1; }',
  '  @Post() query(@Query() filter: { page: number }): number { return 1; }',
  '  @Post() nested(@Body() inputs: TPaymentInput[][]): number { return 1; }',
  '  @Post() model(@Body() input: TPaymentInput): number { return 1; }',
  "  @Post() modelField(@Body('input') input: TPaymentInput): number { return 1; }",
  "  @Post() field(@Body('note') note: string, @Query('page') page: number): number { return 1; }",
  '  @Post() either(@Query() filter: TPaymentInput | { page: number }): number { return 1; }',
  '}',
].join('\n');

for (const mode of ['error', 'warn'] as const) {
  test(`a @Body() or @Query() parameter that is not a golem model, whole or one field, gets RUNM1081 with its position, ${mode === 'warn' ? 'a warning with nonModelInputs: warn' : 'an error by default'}; a model and a model field are silent`, (t) => {
    // protects: T-258 R-13 a body or query input the interceptor rejects is reported at build, a union-typed @Query() (T-377) included
    const root = paymentsProject(t, { 'src/plain.controller.ts': PLAIN_CONTROLLER });
    const severity = mode === 'warn' ? 'warning' : 'error';
    const sites = [['Body', 'PlainInput', 6, 32], ['Query', '{ page: number }', 7, 34], ['Body', 'TPaymentInput[][]', 8, 34], ['Body', 'string', 11, 37], ['Query', 'number', 11, 66], ['Query', 'TPaymentInput | { page: number }', 12, 35]] as const;
    assert.deepEqual(scan(root, true, mode).diagnostics.map(({ code, severity, file, line, column, message }) => ({ code, severity, file, line, column, message })),
      sites.map(([decorator, type, line, column]) => ({ code: 'RUNM1081', severity, file: 'src/plain.controller.ts', line, column, message: notAModel(decorator, type, mode) })));
  });
}

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

test('Array<T> and Promise<T[]> returns record an array, and an Array<T> or readonly T[] body takes the element codec', (t) => {
  const root = paymentsProject(t, { 'src/arrays.controller.ts': readFixture(`${FORMS}/arrays.controller.ts`) });
  const result = scan(root);
  // An array of arrays has no one element codec, so it is left unstamped and stops as a non-model.
  assert.deepEqual(result.diagnostics.map(({ code, message }) => ({ code, message })), [{ code: 'RUNM1081', message: notAModel('Body', 'TPaymentInput[][]') }]);
  const payment = idOf(root, 'TPayment');
  const input = idOf(root, 'TPaymentInput');
  const code = rewritten(root, result, 'src/arrays.controller.ts');
  assertLines(code, [
    `  @__golem_nestModelReturn("${payment}", true) @Get('generic')`,
    `  @__golem_nestModelReturn("${payment}", true) @Get('promised')`,
    `  batch(@Body() @__golem_nestModelCodec("${input}", true) inputs: Array<TPaymentInput>): number { return inputs.length; }`,
    `  readonlyBatch(@Body() @__golem_nestModelCodec("${input}", true) inputs: readonly TPaymentInput[]): number { return inputs.length; }`,
    '  nestedBatch(@Body() inputs: TPaymentInput[][]): number { return inputs.length; }',
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
    { from: './payment.model.generated.js', names: [] },
    { from: '@exprtlabs/golem/nest', names: ['nestModelCodec', 'nestModelReturn'] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
  assert.deepEqual(
    result.files.get('src/mixed.controller.ts')?.edits.map(edit => /^@?(__golem_\w+)/.exec(edit.text)?.[1]),
    ['__golem_nestModelReturn', '__golem_nestModelCodec', '__golem_requireObjectCodec'],
    'edits are in source order',
  );
  assert.deepEqual(code.split('\n').slice(0, 3), [
    PAYMENT_MODULE,
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
  const { ids, label, decorator } = result.nestCodecSites[0]!;
  assert.deepEqual(result.nestCodecSites.map(site => site.file), Array(6).fill(CONTROLLER));
  assert.equal(ids.length, 1);
  assert.match(ids[0]!, /^TPaymentInput_[0-9a-f]{8}$/);
  assert.equal(label, 'TPaymentInput');
  assert.equal(decorator, 'Body');

  const slotOf = (site: { readonly method: string | undefined; readonly slot: string }): string => `${site.method}:${site.slot}`;
  assert.deepEqual(result.nestCodecSites.map(slotOf), ['create:input', 'createAsClass:input', 'list:query', 'createBatch:input', 'createPiped:input', 'listPiped:query']);
  const methods = (replaced?: string, misplaced?: string): string => `export const OPERATION_METHOD_KEYS = ${JSON.stringify(Object.fromEntries(result.nestCodecSites.map(site => [
    `PaymentsController.${site.method}`, { [site.method === misplaced ? 'input' : site.slot]: site.method === 'create' && replaced ? replaced : site.ids[0] },
  ])), null, 2)} as const;\n`;
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, methods());
  assert.deepEqual(checkNestCodecs(root, result), []);

  // Each site is compared with the slot of its own method: three methods hold the same id, and only the one that now holds another id fails.
  fs.writeFileSync(registry, methods('TPaymentInput_00000000'));
  const failures = checkNestCodecs(root, result);
  assert.deepEqual(failures.map(({ code, file, message }) => ({ code, file, message })), [
    { code: 'RUNM1072', file: CONTROLLER, message: '@Body() type TPaymentInput disagrees with generated operation keys' },
  ]);
  assert.deepEqual([failures[0]?.line, failures[0]?.column], [7, 25]);

  // The method matches, but its registry entry holds the id in another slot: `list` is a @Query() site and its model sits under `input`.
  fs.writeFileSync(registry, methods(undefined, 'list'));
  assert.deepEqual(checkNestCodecs(root, result).map(({ message }) => message), ['@Query() type TPaymentFilter disagrees with generated operation keys']);

  fs.rmSync(registry);
  assert.equal(checkNestCodecs(root, result).length, 6, 'a missing registry disagrees with every site');
});

test('a registry that cannot be read is reported once with its file, not as a disagreement of every site', (t) => {
  // protects: T-490 only a missing registry means "no keys yet"; a read error such as EACCES must not become six RUNM1072 sites
  const root = paymentsProject(t);
  const result = scan(root);
  const registry = path.join(root, 'src/generated/operation-codecs.ts');
  fs.mkdirSync(registry, { recursive: true });
  const failures = checkNestCodecs(root, result);
  assert.equal(result.nestCodecSites.length, 6);
  assert.deepEqual(failures.map(({ code, file }) => ({ code, file })), [{ code: 'RUNM1072', file: registry }]);
  assert.match(failures[0]!.message, /^the generated operation keys cannot be read \(EISDIR/);
});

test('the operation-codec check has nothing to compare when the project has no nest sites', (t) => {
  const root = paymentsProject(t);
  assert.deepEqual(checkNestCodecs(root, scan(root, false)), [], 'no registry is needed when nest is off');
});

/** A project whose golem.yaml has a controllers job over the payments controller, so the scan runs with nest on. */
function controllersJobProject(t: TestContext): string {
  return createControllerFixture(t, {
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
}

test('a controllers job turns nest on, and golem check fails a parameter the generated operations do not hold', async (t) => {
  const root = controllersJobProject(t);
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });

  // A method outside the controllers job's sources is stamped by the scan but is in no generated operation.
  fs.writeFileSync(path.join(root, 'src/helper.controller.ts'), readFixture(`${CHECKS}/helper.controller.ts`));
  await runPipeline(config);
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1072 \(.*src\/helper\.controller\.ts:4:\d+\): @Query\(\) type TPaymentFilter disagrees with generated operation keys/);
});

test('golem check stops on a body or query parameter that is no model, and nonModelInputs: warn reports it and continues', async (t) => {
  // protects: T-258 R-13 the user's choice: error by default, a golem.yaml setting makes it a warning
  const root = controllersJobProject(t);
  const config = path.join(root, 'golem.yaml');
  const site = path.relative(process.cwd(), path.join(root, 'src/note.controller.ts'));
  await runPipeline(config);
  fs.writeFileSync(path.join(root, 'src/note.controller.ts'), [
    "import { Body, Controller, Post, Query } from '@nestjs/common';",
    'interface Note { text: string }',
    "@Controller('notes')",
    'export class NoteController {',
    "  @Post() create(@Body() note: Note, @Query('page') page: number): number { return page; }",
    '}',
  ].join('\n'));
  await assert.rejects(runPipeline(config, { check: true }), (error: Error) => error.message.includes(`RUNM1081 (${site}:5:32): ${notAModel('Body', 'Note')}`) && error.message.includes(`RUNM1081 (${site}:5:59): ${notAModel('Query', 'number')}`));

  fs.writeFileSync(config, `nonModelInputs: warn\n${fs.readFileSync(config, 'utf8')}`);
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  await runPipeline(config, { check: true });
  assert.deepEqual(written.filter(line => line.startsWith('RUNM1081')), [
    `RUNM1081 (${site}:5:32): ${notAModel('Body', 'Note', 'warn')}\n`,
    `RUNM1081 (${site}:5:59): ${notAModel('Query', 'number', 'warn')}\n`,
  ]);
});

const SHAPES_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
export type TCircle = IModel<{ kind: 'circle'; radius: number }>;
export type TRect = IModel<{ kind: 'rect'; width: number }>;
export type TPlain = IModel<{ width: number }>;
export type TShape = TCircle | TRect;
export type TNumberTag = IModel<{ v: 1 }>;
export type TTextTag = IModel<{ v: '1' }>;
`;

const SHAPES_CONTROLLER = [
  "import { Body, Controller, Post, Query } from '@nestjs/common';",
  "import type { TCircle, TNumberTag, TPlain, TRect, TShape, TTextTag } from './shapes.model.js';",
  "@Controller('shapes')",
  'export class ShapesController {',
  '  @Post() written(@Body() shape: TCircle | TRect): number { return 1; }',
  '  @Post() aliased(@Body() shape: TShape): number { return 1; }',
  '  @Post() query(@Query() shape: TCircle | TRect): number { return 1; }',
  '  @Post() untagged(@Body() shape: TCircle | TPlain): number { return 1; }',
  '  @Post() list(@Body() shapes: TShape[]): number { return 1; }',
  "  @Post() field(@Body('shape') shape: TShape): number { return 1; }",
  '  @Post() bodyMixed(@Body() tag: TNumberTag | TTextTag): number { return 1; }',
  '  @Post() queryMixed(@Query() tag: TNumberTag | TTextTag): number { return 1; }',
  '}',
].join('\n');

const shapeId = (root: string, name: string): string => {
  const id = new RegExp(`src/shapes\\.model\\.ts#${name}": "([^"]+)"`).exec(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8'))?.[1];
  assert.ok(id, `${name} has a key`);
  return id;
};

test('a whole @Body() or @Query() union of tagged models is stamped with its tag and variants, and an untagged, array or one-field union gets RUNM1081', (t) => {
  // protects: T-390 E-50 a tagged union binds a union codec; an untagged union (T-258, T-377) and the forms golem does not describe still stop the build
  const root = project(t, { 'src/shapes.model.ts': SHAPES_MODEL, 'src/shapes.controller.ts': SHAPES_CONTROLLER });
  const result = scan(root);
  const refused = (type: string, decorator: string, reason: string, advice: string): string => `${type} ${reason}, and NestModelInterceptor answers HTTP 500 for a @${decorator}() parameter of that type. ${advice} An app with its own interceptor can set nonModelInputs: warn in golem.yaml.`;
  assert.deepEqual(result.diagnostics.map(({ code, line, message }) => ({ code, line, message })), [
    { code: 'RUNM1081', line: 8, message: refused('TCircle | TPlain', 'Body', 'is a union of golem models with no tag', "Give each model a required literal field with a value of its own, such as kind: 'circle', or bind one field of a model type.") },
    { code: 'RUNM1081', line: 9, message: refused('TShape', 'Body', 'is a union of golem models, which NestModelInterceptor converts only as a whole input', 'Declare the parameter as the union itself in a whole @Body(), or as one model.') },
    { code: 'RUNM1081', line: 10, message: refused('TShape', 'Body', 'is a union of golem models, which NestModelInterceptor converts only as a whole input', 'Declare the parameter as the union itself in a whole @Body(), or as one model.') },
    // A query string carries the tag as text, so the number 1 and the text '1' pick the same model there; a JSON body tells them apart.
    { code: 'RUNM1081', line: 12, message: refused('TNumberTag | TTextTag', 'Query', 'is a union of golem models with no tag', "Give each model a required literal field with a value of its own, such as kind: 'circle', or bind one field of a model type.") },
  ]);
  const [circle, rect] = [shapeId(root, 'TCircle'), shapeId(root, 'TRect')];
  const variants = `[[["circle"],"${circle}"],[["rect"],"${rect}"]]`;
  assertLines(rewritten(root, result, 'src/shapes.controller.ts'), [
    `  @Post() written(@Body() @__golem_nestModelUnion("kind", ${variants}) shape: TCircle | TRect): number { return 1; }`,
    `  @Post() aliased(@Body() @__golem_nestModelUnion("kind", ${variants}) shape: TShape): number { return 1; }`,
    `  @Post() query(@Query() @__golem_nestModelUnion("kind", ${variants}) shape: TCircle | TRect): number { return 1; }`,
    `  @Post() bodyMixed(@Body() @__golem_nestModelUnion("v", [[[1],"${shapeId(root, 'TNumberTag')}"],[["1"],"${shapeId(root, 'TTextTag')}"]]) tag: TNumberTag | TTextTag): number { return 1; }`,
  ]);
  assert.deepEqual(result.nestCodecSites.map(({ method, slot, ids }) => ({ method, slot, ids })), [
    { method: 'written', slot: 'input', ids: [circle, rect] },
    { method: 'aliased', slot: 'input', ids: [circle, rect] },
    { method: 'query', slot: 'query', ids: [circle, rect] },
    { method: 'bodyMixed', slot: 'input', ids: [shapeId(root, 'TNumberTag'), shapeId(root, 'TTextTag')] },
  ]);

  // The registry holds the variants of a union as a list: the check compares them as a set, in any order.
  const registry = path.join(root, 'src/generated/operation-codecs.ts');
  const methods = (input: readonly string[]): string => `export const OPERATION_METHOD_KEYS = { 'ShapesController.written': { input: ${JSON.stringify(input)} }, 'ShapesController.aliased': { input: ${JSON.stringify(input)} }, 'ShapesController.query': { query: ${JSON.stringify(input)} }, 'ShapesController.bodyMixed': { input: ${JSON.stringify([shapeId(root, 'TTextTag'), shapeId(root, 'TNumberTag')])} } } as const;\n`;
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, methods([rect, circle]));
  assert.deepEqual(checkNestCodecs(root, result), []);
  fs.writeFileSync(registry, methods([rect]));
  assert.equal(checkNestCodecs(root, result).length, 3, 'a registry that lacks a variant disagrees with every union site');
});
