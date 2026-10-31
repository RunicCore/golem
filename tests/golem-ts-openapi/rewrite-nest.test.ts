// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { applyRewrites } from '#golem/rewrite';
import { scanProject, type ProgramScan } from '#golem/rewrite-scan';
import { generate } from '#model/generator';
import { readFixture, writeGeneratedArtifacts } from '../fixture-project.js';
import { NEST_INTERCEPTOR_SOURCE, createControllerFixture } from '../fixture-templates/controllers/project.js';
import { paymentModelSource } from '../fixture-templates/controllers/payment-model.js';
import { defaultModelOutput } from '#golem/generated-paths';

const PLUGIN = 'controllers/nest-plugin';
const FORMS = `${PLUGIN}/rewrite-covers-qualified-array-and-serde-forms`;
const CONTROLLERS_JOB = `${PLUGIN}/rewrite-scans-a-controllers-job-project`;
const CONTROLLER = 'src/payments.controller.ts';
/** The load of the module that registers the payment codecs, added for any codec the controller names. */
const PAYMENT_MODULE = "import './payment.model.generated.js';";
const NEST_IMPORT = "import { nestModelCodec as __golem_nestModelCodec, nestModelReturn as __golem_nestModelReturn } from '@exprtlabs/golem/internal/nest-runtime';";

/** A project of the named source files (under `src/`) with the models job's generated files written. */
function project(t: TestContext, files: Readonly<Record<string, string>>): string {
  const root = createControllerFixture(t, {
    prefix: 'golem-rewrite-nest-',
    links: 'workspace',
    files: { 'golem.yaml': 'version: 1\nmodels: { root: . }\n', 'src/interceptor.ts': NEST_INTERCEPTOR_SOURCE, ...files },
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

function scan(root: string, nonModelInputs?: 'error' | 'warn'): ProgramScan {
  return scanProject({ root, boundary: { root, directory: root, output: defaultModelOutput(root) }, configFile: path.join(root, 'tsconfig.json'), nonModelInputs, codecKeysFile: path.join(root, '.golem/codec-keys.json') });
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
    { from: '@exprtlabs/golem/internal/nest-runtime', names: ['nestModelCodec', 'nestModelReturn'] },
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

test('a program that imports nothing from @exprtlabs/golem/nest gets no stamps and no RUNM1081', (t) => {
  // protects: T-761 a plain Nest app without golem's interceptor gets neither the stamps nor the checks
  const root = paymentsProject(t, { 'src/interceptor.ts': 'export {};\n', 'src/plain.controller.ts': "import { Body, Controller, Post } from '@nestjs/common';\ninterface Note { text: string }\n@Controller('notes')\nexport class PlainController {\n  @Post() create(@Body() note: Note): void {}\n}\n" });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.get(CONTROLLER), undefined);
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

/** The edit that stamps the parameter written as `parameter` (its name and type) in the source of `file` with the codec `id`. */
function stampOf(root: string, file: string, parameter: string, id: string): { readonly start: number; readonly end: number; readonly expect: string; readonly text: string } {
  const start = fs.readFileSync(path.join(root, file), 'utf8').indexOf(parameter);
  return { start, end: start, expect: '', text: `@__golem_nestModelCodec("${id}") ` };
}

test('a @Body() or @Query() imported under another name, through a re-export or from a vendored copy of NestJS is stamped, and a local decorator of that name is not', (t) => {
  // protects: T-757 the scan finds a parameter decorator by its resolved symbol and the package that owns its file, not by the name it is written under
  const root = paymentsProject(t, {
    'src/decorators.ts': "export { Query as Filter } from '@nestjs/common';\nexport { Body as Vendored } from '../vendor/nest-common/index.js';\nexport function Body(): ParameterDecorator { return () => undefined; }\n",
    'vendor/nest-common/package.json': '{ "name": "@nestjs/common", "version": "0.0.0" }',
    'vendor/nest-common/index.ts': 'export declare function Body(key?: string): ParameterDecorator;\n',
    'src/aliased.controller.ts': [
      "import { Body as Input, Controller, Post } from '@nestjs/common';",
      "import { Filter, Body, Vendored } from './decorators.js';",
      "import type { TPaymentFilter, TPaymentInput } from './payment.model.js';",
      "@Controller('aliased')",
      'export class AliasedController {',
      '  @Post() create(@Input() input: TPaymentInput, @Filter() filter: TPaymentFilter): number { return 1; }',
      '  @Post() vendored(@Vendored() copy: TPaymentInput): number { return 1; }',
      '  @Post() local(@Body() text: string): number { return 1; }',
      '}',
    ].join('\n'),
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const file = 'src/aliased.controller.ts';
  assert.deepEqual(result.files.get(file)?.edits, [
    stampOf(root, file, 'input: TPaymentInput', idOf(root, 'TPaymentInput')),
    stampOf(root, file, 'filter: TPaymentFilter', idOf(root, 'TPaymentFilter')),
    stampOf(root, file, 'copy: TPaymentInput', idOf(root, 'TPaymentInput')),
  ]);
});

test('a local decorator named nestModelCodec does not count as the stamp golem adds', (t) => {
  // protects: T-757 an existing codec decorator is golem's by its resolved symbol and package, not by its name
  const root = paymentsProject(t, {
    'src/look-alike.controller.ts': [
      "import { Body, Controller, Post } from '@nestjs/common';",
      "import type { TPaymentInput } from './payment.model.js';",
      'declare function nestModelCodec(id: string): ParameterDecorator;',
      "@Controller('look-alike')",
      'export class LookAlikeController {',
      "  @Post() create(@nestModelCodec('mine') @Body() input: TPaymentInput): number { return 1; }",
      '}',
    ].join('\n'),
  });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const file = 'src/look-alike.controller.ts';
  assert.deepEqual(result.files.get(file)?.edits, [stampOf(root, file, 'input: TPaymentInput', idOf(root, 'TPaymentInput'))]);
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
    assert.deepEqual(scan(root, mode).diagnostics.map(({ code, severity, file, line, column, message }) => ({ code, severity, file, line, column, message })),
      sites.map(([decorator, type, line, column]) => ({ code: 'RUNM1081', severity, file: 'src/plain.controller.ts', line, column, message: notAModel(decorator, type, mode) })));
  });
}

const HANDLER_LIMITS_CONTROLLER = [
  "import { Body, Controller, Post, Query } from '@nestjs/common';",
  "import type { TPaymentFilter, TPaymentInput } from './payment.model.js';",
  "@Controller('limits')",
  'export class LimitsController {',
  "  @Post() optionalBody(@Body('input') input?: TPaymentInput): number { return 1; }",
  "  @Post() optionalQuery(@Query('filter') filter?: TPaymentFilter): number { return 1; }",
  '  @Post() twoWholes(@Body() first: TPaymentInput, @Body() second: TPaymentInput[]): number { return 1; }',
  "  @Post() wholeAndField(@Body() whole: TPaymentInput, @Body('input') input: TPaymentInput): number { return 1; }",
  "  @Post() queryAndWhole(@Query('filter') filter: TPaymentFilter, @Query() whole: TPaymentFilter): number { return 1; }",
  '  @Post() optionalWhole(@Body() body?: TPaymentInput): number { return 1; }',
  '  @Post() queryArray(@Query() filters: TPaymentFilter[]): number { return 1; }',
  "  @Post() sameField(@Body('input') first: TPaymentInput, @Body('input') second: TPaymentInput[]): number { return 1; }",
  "  @Post() everyConflict(@Body() whole: TPaymentInput, @Body('a') a: TPaymentInput, @Body('b') b: TPaymentInput): number { return 1; }",
  '  @Post() sameWholes(@Body() first: TPaymentInput, @Body() second: TPaymentInput): number { return 1; }',
  '  @Post() optionalQueryWhole(@Query() filter?: TPaymentFilter): number { return 1; }',
  "  @Post() sources(@Body('input') input: TPaymentInput, @Query() filter: TPaymentFilter): number { return 1; }",
  "  @Post() fields(@Body('input') input: TPaymentInput, @Body('other') other: TPaymentInput): number { return 1; }",
  '}',
].join('\n');

for (const mode of ['error', 'warn'] as const) {
  test(`NestModelInterceptor limits of one handler give RUNM1081 at the parameter, ${mode === 'warn' ? 'a warning with nonModelInputs: warn' : 'an error by default'}; valid combinations are silent`, (t) => {
    // protects: T-755 R-92 each limit the interceptor sets on the inputs of one handler stops the build here, not only in the controllers job
    const root = paymentsProject(t, { 'src/limits.controller.ts': HANDLER_LIMITS_CONTROLLER });
    const severity = mode === 'warn' ? 'warning' : 'error';
    const advice = mode === 'warn' ? 'Generation continues, because golem.yaml sets nonModelInputs: warn.' : 'An app with its own interceptor can set nonModelInputs: warn in golem.yaml.';
    assert.deepEqual(scan(root, mode).diagnostics.map(({ code, severity, file, line, column, message }) => ({ code, severity, file, line, column, message })), [
      { line: 5, column: 24, message: `@Body('input') input is an optional one-field model, and NestModelInterceptor answers HTTP 400 for a request that omits the field. Make the parameter required, or declare the field optional in a whole @Body() model. ${advice}` },
      { line: 6, column: 25, message: `@Query('filter') filter is an optional one-field model, and NestModelInterceptor answers HTTP 400 for a request that omits the field. Make the parameter required, or declare the field optional in a whole @Query() model. ${advice}` },
      { line: 7, column: 51, message: `@Body() second takes another model than @Body() first: NestModelInterceptor throws a TypeError for whole @Body() parameters of different types, and Nest answers HTTP 500. Give them one model type, or declare one whole body. ${advice}` },
      { line: 8, column: 55, message: `@Body('input') input cannot share a handler with @Body() whole: NestModelInterceptor throws a TypeError for a whole and a one-field @Body() together, and Nest answers HTTP 500. Declare the whole body as one model, or use one-field parameters only. ${advice}` },
      { line: 9, column: 66, message: `@Query() whole cannot share a handler with @Query('filter') filter: NestModelInterceptor throws a TypeError for a whole and a one-field @Query() together, and Nest answers HTTP 500. Declare the whole query as one model, or use one-field parameters only. ${advice}` },
      { line: 10, column: 25, message: `@Body() body is an optional whole body, and NestModelInterceptor answers HTTP 400 for a request without a body. Make the parameter required. ${advice}` },
      { line: 11, column: 22, message: `@Query() filters is an array of models, and NestModelInterceptor throws a TypeError for a whole @Query() array, and Nest answers HTTP 500: a query is an object. Declare the query as one model. ${advice}` },
      { line: 12, column: 58, message: `@Body('input') second takes another model than @Body('input') first: NestModelInterceptor throws a TypeError for @Body('input') parameters of different types, and Nest answers HTTP 500. Give them one model type, or declare one parameter. ${advice}` },
      { line: 13, column: 55, message: `@Body('a') a cannot share a handler with @Body() whole: NestModelInterceptor throws a TypeError for a whole and a one-field @Body() together, and Nest answers HTTP 500. Declare the whole body as one model, or use one-field parameters only. ${advice}` },
      { line: 13, column: 84, message: `@Body('b') b cannot share a handler with @Body() whole: NestModelInterceptor throws a TypeError for a whole and a one-field @Body() together, and Nest answers HTTP 500. Declare the whole body as one model, or use one-field parameters only. ${advice}` },
    ].map((expected) => ({ code: 'RUNM1081', severity, file: 'src/limits.controller.ts', ...expected })));
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
    { from: '@exprtlabs/golem/internal/model-runtime', names: ['requireObjectCodec'] },
    { from: '@exprtlabs/golem/internal/nest-runtime', names: ['nestModelCodec', 'nestModelReturn'] },
  ]);
  assert.deepEqual(
    result.files.get('src/mixed.controller.ts')?.edits.map(edit => /^@?(__golem_\w+)/.exec(edit.text)?.[1]),
    ['__golem_nestModelReturn', '__golem_nestModelCodec', '__golem_requireObjectCodec'],
    'edits are in source order',
  );
  assert.deepEqual(code.split('\n').slice(0, 3), [
    PAYMENT_MODULE,
    "import { requireObjectCodec as __golem_requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';",
    "import { nestModelCodec as __golem_nestModelCodec, nestModelReturn as __golem_nestModelReturn } from '@exprtlabs/golem/internal/nest-runtime';",
  ]);
  assertLines(code, [
    `  @__golem_nestModelReturn("${payment}") @Post()`,
    `  create(@Body() @__golem_nestModelCodec("${input}") input: TPaymentInput): TPayment { return __golem_requireObjectCodec("${payment}").parse(JSON.stringify(input)); }`,
  ]);
});

/** A project over the payments controller whose golem.yaml has the models job and, with `controllersJob`, a controllers (doc) job. The `interceptor` source imports golem's NestModelInterceptor. */
function nestAppProject(t: TestContext, options: { readonly controllersJob: boolean; readonly interceptor: boolean }): string {
  return createControllerFixture(t, {
    prefix: 'golem-rewrite-nest-pipeline-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': readFixture(`${PLUGIN}/project/payment.model.ts`),
      [CONTROLLER]: readFixture(`${CONTROLLERS_JOB}/payments.controller.ts`),
      ...(options.interceptor ? { 'src/interceptor.ts': NEST_INTERCEPTOR_SOURCE } : {}),
      'golem.yaml': [
        'version: 1',
        'mobx: false',
        'validation: true',
        ...(options.controllersJob ? ['controllers:', '  - root: .', '    sources:', `      - ${CONTROLLER}`, '    output: generated/api.json', '    info: { title: Test API, version: "1" }'] : []),
        'models:',
        '  root: .',
        '',
      ].join('\n'),
    },
  });
}

const NOTE_CONTROLLER = [
  "import { Body, Controller, Post, Query } from '@nestjs/common';",
  'interface Note { text: string }',
  "@Controller('notes')",
  'export class NoteController {',
  "  @Post() create(@Body() note: Note, @Query('page') page: number): number { return page; }",
  '}',
].join('\n');

test('golem check stops on a body or query parameter that is no model, and nonModelInputs: warn reports it and continues', async (t) => {
  // protects: T-258 R-13 the user's choice: error by default, a golem.yaml setting makes it a warning
  // protects: T-761 the checks run for a models job and the interceptor, with no controllers job in golem.yaml
  const root = nestAppProject(t, { controllersJob: false, interceptor: true });
  const config = path.join(root, 'golem.yaml');
  const site = path.relative(process.cwd(), path.join(root, 'src/note.controller.ts'));
  await runPipeline(config);
  fs.writeFileSync(path.join(root, 'src/note.controller.ts'), NOTE_CONTROLLER);
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

test('golem check runs no NestJS checks for a controllers job when no source imports @exprtlabs/golem/nest', async (t) => {
  // protects: T-761 R-92 the doc job is separate from the NestJS side: the doc job alone does not turn the checks on
  const root = nestAppProject(t, { controllersJob: true, interceptor: false });
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  fs.writeFileSync(path.join(root, 'src/note.controller.ts'), NOTE_CONTROLLER);
  await runPipeline(config, { check: true });
});

const SHAPES_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
export type TCircle = IModel<{ kind: 'circle'; radius: number }>;
export type TRect = IModel<{ kind: 'rect'; width: number }>;
export type TPlain = IModel<{ width: number }>;
export type TShape = (TCircle | TRect) & Discriminator<'kind'>;
export type TNumberTag = IModel<{ v: 1 }>;
export type TTextTag = IModel<{ v: '1' }>;
`;

const SHAPES_CONTROLLER = [
  "import { Body, Controller, Post, Query } from '@nestjs/common';",
  "import type { Discriminator } from '@exprtlabs/golem/tags';",
  "import type { TCircle, TNumberTag, TPlain, TRect, TShape, TTextTag } from './shapes.model.js';",
  "@Controller('shapes')",
  'export class ShapesController {',
  '  @Post() written(@Body() shape: (TCircle | TRect) & Discriminator<\'kind\'>): number { return 1; }',
  '  @Post() aliased(@Body() shape: TShape): number { return 1; }',
  '  @Post() query(@Query() shape: (TCircle | TRect) & Discriminator<\'kind\'>): number { return 1; }',
  '  @Post() untagged(@Body() shape: TCircle | TPlain): number { return 1; }',
  '  @Post() undeclared(@Body() shape: TCircle | TRect): number { return 1; }',
  "  @Post() missing(@Body() shape: (TCircle | TPlain) & Discriminator<'kind'>): number { return 1; }",
  '  @Post() list(@Body() shapes: TShape[]): number { return 1; }',
  "  @Post() field(@Body('shape') shape: TShape): number { return 1; }",
  '  @Post() bodyMixed(@Body() tag: (TNumberTag | TTextTag) & Discriminator<\'v\'>): number { return 1; }',
  '  @Post() queryMixed(@Query() tag: (TNumberTag | TTextTag) & Discriminator<\'v\'>): number { return 1; }',
  "  @Post() defaulted(@Body() shape: (TCircle | TPlain) & Discriminator<'kind', TPlain>): number { return 1; }",
  '}',
].join('\n');

const shapeId = (root: string, name: string): string => {
  const id = new RegExp(`src/shapes\\.model\\.ts#${name}": "([^"]+)"`).exec(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8'))?.[1];
  assert.ok(id, `${name} has a key`);
  return id;
};

test('a union whose tag is written through an alias of the tag gets RUNM1081 with the cause and the forms that work', (t) => {
  // protects: fixed message, RUNM1081 for (A | B) & Kind named no cause ("is not a golem model") and gave a misleading fix
  const controller = [
    "import { Body, Controller, Post } from '@nestjs/common';",
    "import type { Discriminator } from '@exprtlabs/golem/tags';",
    "import type { TCircle, TRect } from './shapes.model.js';",
    "type Kind = Discriminator<'kind'>;",
    "@Controller('shapes')",
    'export class ShapesController {',
    '  @Post() aliased(@Body() shape: (TCircle | TRect) & Kind): number { return 1; }',
    '}',
  ].join('\n');
  const root = project(t, { 'src/shapes.model.ts': SHAPES_MODEL, 'src/shapes.controller.ts': controller });
  const result = scan(root);
  const fix = "Write the tag on the union itself, (A | B) & Discriminator<'kind'>, or give the whole tagged union a type alias: type TShape = (A | B) & Discriminator<'kind'>.";
  const refused = (type: string, reason: string): string => `${type} ${reason}, and NestModelInterceptor answers HTTP 500 for a @Body() parameter of that type. ${fix} An app with its own interceptor can set nonModelInputs: warn in golem.yaml.`;
  assert.deepEqual(result.diagnostics.map(({ code, line, message }) => ({ code, line, message })), [
    { code: 'RUNM1081', line: 7, message: refused('(TCircle | TRect) & Kind', 'is a union whose Discriminator tag is written through the alias Kind, which golem does not read') },
  ]);
});

test('a generic wrapper that adds more than the tag to a @Body() union gets RUNM1081 with the cause, not the bare "not a golem model"', (t) => {
  // protects: R-57 review finding 7 - a wrapper U & Discriminator<'kind'> & { x: string } is not a pure tag wrapper and stops with a message that names what is wrong
  const controller = [
    "import { Body, Controller, Post } from '@nestjs/common';",
    "import type { Discriminator } from '@exprtlabs/golem/tags';",
    "import type { TCircle, TRect } from './shapes.model.js';",
    "type Wrapped<U> = U & Discriminator<'kind'> & { x: string };",
    "@Controller('shapes')",
    'export class ShapesController {',
    '  @Post() wrapped(@Body() shape: Wrapped<TCircle | TRect>): number { return 1; }',
    '}',
  ].join('\n');
  const root = project(t, { 'src/shapes.model.ts': SHAPES_MODEL, 'src/shapes.controller.ts': controller });
  assert.deepEqual(scan(root).diagnostics.map(({ code, line, message }) => ({ code, line, message })), [
    { code: 'RUNM1081', line: 7, message: "Wrapped<TCircle | TRect> is a generic wrapper of a union that holds more than the type parameter and its Discriminator tag, which golem does not read, and NestModelInterceptor answers HTTP 500 for a @Body() parameter of that type. Use a wrapper that is only U & Discriminator<'kind'>, or write the tag on the union itself, (A | B) & Discriminator<'kind'>. An app with its own interceptor can set nonModelInputs: warn in golem.yaml." },
  ]);
});

test('a generic tag wrapper Tagged<A | B> on a @Body() or @Query() union is stamped like the written form, and the existing refusals still apply through it', (t) => {
  // protects: T-619 the wrapper binds like the written tag; a member without the key, shared values and a default stay RUNM1081
  const controller = [
    "import { Body, Controller, Post, Query } from '@nestjs/common';",
    "import type { Discriminator } from '@exprtlabs/golem/tags';",
    "import type { TCircle, TNumberTag, TPlain, TRect, TTextTag } from './shapes.model.js';",
    "type Tagged<U> = U & Discriminator<'kind'>;",
    "type TaggedV<U> = U & Discriminator<'v'>;",
    "type Defaulted<U> = U & Discriminator<'kind', TPlain>;",
    "@Controller('shapes')",
    'export class ShapesController {',
    '  @Post() body(@Body() shape: Tagged<TCircle | TRect>): number { return 1; }',
    '  @Post() query(@Query() shape: Tagged<TCircle | TRect>): number { return 1; }',
    '  @Post() missing(@Body() shape: Tagged<TCircle | TPlain>): number { return 1; }',
    '  @Post() shared(@Query() tag: TaggedV<TNumberTag | TTextTag>): number { return 1; }',
    '  @Post() defaulted(@Body() shape: Defaulted<TCircle | TPlain>): number { return 1; }',
    '}',
  ].join('\n');
  const root = project(t, { 'src/shapes.model.ts': SHAPES_MODEL, 'src/shapes.controller.ts': controller });
  const result = scan(root);
  assert.deepEqual(result.diagnostics.map(({ code, line, message }) => ({ code, line, reason: / (has the member TPlain with no required literal property "kind"|has the members TNumberTag and TTextTag that share the "v" value "1"|declares a default variant)/.exec(message)?.[1] })), [
    { code: 'RUNM1081', line: 11, reason: 'has the member TPlain with no required literal property "kind"' },
    { code: 'RUNM1081', line: 12, reason: 'has the members TNumberTag and TTextTag that share the "v" value "1"' },
    { code: 'RUNM1081', line: 13, reason: 'declares a default variant' },
  ]);
  const [circle, rect] = [shapeId(root, 'TCircle'), shapeId(root, 'TRect')];
  const variants = `[[["circle"],"${circle}"],[["rect"],"${rect}"]]`;
  assertLines(rewritten(root, result, 'src/shapes.controller.ts'), [
    `  @Post() body(@Body() @__golem_nestModelUnion("kind", ${variants}) shape: Tagged<TCircle | TRect>): number { return 1; }`,
    `  @Post() query(@Query() @__golem_nestModelUnion("kind", ${variants}) shape: Tagged<TCircle | TRect>): number { return 1; }`,
  ]);
});

test('a whole @Body() or @Query() union of tagged models is stamped with its tag and variants, and an untagged, array or one-field union gets RUNM1081', (t) => {
  // protects: T-390 E-50 a tagged union binds a union codec; an untagged union (T-258, T-377) and the forms golem does not describe still stop the build
  const root = project(t, { 'src/shapes.model.ts': SHAPES_MODEL, 'src/shapes.controller.ts': SHAPES_CONTROLLER });
  const result = scan(root);
  const refused = (type: string, decorator: string, reason: string, advice: string): string => `${type} ${reason}, and NestModelInterceptor answers HTTP 500 for a @${decorator}() parameter of that type. ${advice} An app with its own interceptor can set nonModelInputs: warn in golem.yaml.`;
  const addTag = "Declare the tag key on the union: (A | B) & Discriminator<'kind'>, and give each model a required literal field kind with a value of its own, such as kind: 'circle'. Or bind one field of a model type.";
  const whole = 'is a union of golem models, which NestModelInterceptor converts only as a whole input';
  const wholeAdvice = 'Declare the parameter as the union itself in a whole @Body(), or as one model.';
  assert.deepEqual(result.diagnostics.map(({ code, line, message }) => ({ code, line, message })), [
    { code: 'RUNM1081', line: 9, message: refused('TCircle | TPlain', 'Body', 'is a union of golem models with no declared tag', addTag) },
    // Two models that share a field named kind are no tagged union until the union declares the key: golem does not find it.
    { code: 'RUNM1081', line: 10, message: refused('TCircle | TRect', 'Body', 'is a union of golem models with no declared tag', addTag) },
    { code: 'RUNM1081', line: 11, message: refused("(TCircle | TPlain) & Discriminator<'kind'>", 'Body', `has the member TPlain with no required literal property "kind", the tag key that Discriminator<'kind'> declares`, `Give TPlain a required "kind" property with a literal type, such as kind: 'a'.`) },
    { code: 'RUNM1081', line: 12, message: refused('TShape', 'Body', whole, wholeAdvice) },
    { code: 'RUNM1081', line: 13, message: refused('TShape', 'Body', whole, wholeAdvice) },
    // A query string carries the tag as text, so the number 1 and the text '1' pick the same model there; a JSON body tells them apart.
    { code: 'RUNM1081', line: 15, message: refused("(TNumberTag | TTextTag) & Discriminator<'v'>", 'Query', 'has the members TNumberTag and TTextTag that share the "v" value "1"', 'Give each model its own "v" value.') },
    // A declared default is a variant NestModelInterceptor does not pick, so the build stops on it.
    { code: 'RUNM1081', line: 16, message: refused("(TCircle | TPlain) & Discriminator<'kind', TPlain>", 'Body', "declares a default variant with Discriminator<'kind', ...>, which NestModelInterceptor does not pick", 'Remove the default type from the tag, or bind one model.') },
  ]);
  const [circle, rect] = [shapeId(root, 'TCircle'), shapeId(root, 'TRect')];
  const variants = `[[["circle"],"${circle}"],[["rect"],"${rect}"]]`;
  assertLines(rewritten(root, result, 'src/shapes.controller.ts'), [
    `  @Post() written(@Body() @__golem_nestModelUnion("kind", ${variants}) shape: (TCircle | TRect) & Discriminator<'kind'>): number { return 1; }`,
    `  @Post() aliased(@Body() @__golem_nestModelUnion("kind", ${variants}) shape: TShape): number { return 1; }`,
    `  @Post() query(@Query() @__golem_nestModelUnion("kind", ${variants}) shape: (TCircle | TRect) & Discriminator<'kind'>): number { return 1; }`,
    `  @Post() bodyMixed(@Body() @__golem_nestModelUnion("v", [[[1],"${shapeId(root, 'TNumberTag')}"],[["1"],"${shapeId(root, 'TTextTag')}"]]) tag: (TNumberTag | TTextTag) & Discriminator<'v'>): number { return 1; }`,
  ]);
});
