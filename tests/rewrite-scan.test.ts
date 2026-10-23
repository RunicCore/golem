import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { runPipeline } from '#golem/cli';
import { applyRewrites } from '#golem/rewrite';
import { RewriteScanner, type FileScanResult } from '#golem/rewrite-scan';
import { decodeMappings } from '#golem/source-map';
import { createProjectProgram } from '@exprtlabs/golem/internal/type-analysis';
import { writeSdk } from '#openapi/generator';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { writeFixture } from './support/consumer.js';
import { workspace } from './support/process.js';

const BASE = ['payment.model.ts', 'payment.model.generated.ts'];
const CODEC_KEYS = '.golem/codec-keys.json';

/** A project of the shared model fixtures plus the named fixture files, all under `src/`. */
function project(t: TestContext, files: readonly string[] = []): string {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-scan-', linkTypescript: true });
  for (const file of [...BASE, ...files]) copyFixtureFile(root, `rewrite/${file}`, `src/${file}`);
  copyFixtureFile(root, 'rewrite/codec-keys.json', CODEC_KEYS);
  return root;
}

type ProgramScan = ReturnType<RewriteScanner['scanProgram']>;

/** The scanner's answer for every file of the project's own program. */
function scan(root: string, nest = false): ProgramScan {
  return withScanner(root, (scanner) => scanner.scanProgram(), nest);
}

/** Run `use` against a scanner of the project's own program, which closes with it. */
function withScanner<T>(root: string, use: (scanner: RewriteScanner) => T, nest = false): T {
  const info = createProjectProgram(root, undefined, undefined, path.join(root, 'tsconfig.json'));
  using program = info.program;
  return use(new RewriteScanner({ root, directory: root, modelsRoot: root, program, checker: program.getTypeChecker(), codecKeysFile: path.join(root, CODEC_KEYS), nest }));
}

function scanned(result: ProgramScan, file: string): FileScanResult {
  const entry = result.files.get(`src/${file}`);
  assert.ok(entry, `src/${file} has rewrites`);
  return entry;
}

/** The file after `applyRewrites`, as a host would see it. */
function rewritten(root: string, result: ProgramScan, file: string): string {
  return applyRewrites(fs.readFileSync(path.join(root, 'src', file), 'utf8'), scanned(result, file)).code;
}

function assertLines(code: string, expected: readonly string[]): void {
  const lines = code.split('\n');
  for (const line of expected) assert.ok(lines.includes(line), `missing line ${line}\n${code}`);
}

function position(source: string, needle: string): { line: number; column: number } {
  const offset = source.indexOf(needle);
  assert.notEqual(offset, -1, needle);
  const before = source.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

const SERDE = "import { requireObjectCodec as __golem_requireObjectCodec } from '@exprtlabs/golem/serde';";
/** The load of the module that registers the payment codecs, added for any call on a payment model. */
const PAYMENT_MODULE = "import './payment.model.generated.js';";

test('each serde call with a type argument becomes a call on its codec', (t) => {
  const root = project(t, ['calls.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, 'calls.ts');
  assert.deepEqual(code.split('\n').slice(0, 2), [PAYMENT_MODULE, SERDE]);
  assertLines(code, [
    'export const written = __golem_requireObjectCodec("TMoney_11111111").stringify(money);',
    'export const parsed = __golem_requireObjectCodec("TMoney_11111111").parse(text);',
    'export const checked = __golem_requireObjectCodec("TMoney_11111111").validate(money);',
    'export const asserted = __golem_requireObjectCodec("TMoney_11111111").assert(money);',
    'export const wire = __golem_requireObjectCodec("TMoney_11111111").toWireFormat(money);',
    'export const read = __golem_requireObjectCodec("TMoney_11111111").fromWireFormat(text);',
  ]);
  assert.deepEqual(result.files.get('src/calls.ts')?.imports, [
    { from: './payment.model.generated.js', names: [] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
});

test('a callee reached through an alias, a namespace or a re-export is rewritten, any other callee is not', (t) => {
  const root = project(t, ['import-forms.ts', 'index.ts', 'write.ts', 'not-serde.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assertLines(rewritten(root, result, 'import-forms.ts'), [
    'export const namespaced = __golem_requireObjectCodec("TMoney_11111111").stringify(money);',
    'export const aliased = __golem_requireObjectCodec("TMoney_11111111").parse(text);',
    'export const reexported = __golem_requireObjectCodec("TMoney_11111111").parse(text);',
    'export const reexportedStar = __golem_requireObjectCodec("TMoney_11111111").stringify(money);',
  ]);
  assert.equal(result.files.get('src/not-serde.ts'), undefined, 'a local function, JSON.parse, a comment and a call without a type argument stay');
  assert.equal(result.files.get('src/index.ts'), undefined);
});

test('parse and fromWireFormat of a class construct it, and options that name construct are kept', (t) => {
  const root = project(t, ['construct.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, 'construct.ts');
  const parse = '__golem_requireObjectCodec("TPayment_22222222").parse';
  assertLines(code, [
    `export const one = ${parse}(text, { construct: Payment });`,
    `export const two = ${parse}(text, { construct: Payment, ...{ validate: false } });`,
    `export const present = ${parse}(text, { construct: Payment });`,
    `export const wire = __golem_requireObjectCodec("TPayment_22222222").fromWireFormat({ id: '1' }, { construct: Payment });`,
    `export const plain = ${parse}(text);`,
    `export const nested = ${parse}(text, { construct: Payment, ...{ validate: ${parse}(text) === undefined } });`,
  ]);
  assert.deepEqual(result.files.get('src/construct.ts')?.imports, [
    { from: './payment.model.generated.js', names: [] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
});

test('a construct option the user wrote is kept, and options held in a variable or a spread are spread after the default class', (t) => {
  // protects: T-170 a shorthand or quoted construct option must not be overridden by the default class
  const root = project(t, ['construct-options.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const parse = '__golem_requireObjectCodec("TPayment_22222222").parse';
  assertLines(rewritten(root, result, 'construct-options.ts'), [
    `export const shorthand = ${parse}(text, { construct });`,
    `export const quoted = ${parse}(text, { 'construct': Sub });`,
    `export const computed = ${parse}(text, { ['construct']: Sub });`,
    `export const parenthesized = ${parse}(text, ({ validate: false, construct: Sub }));`,
    `export const commented = ${parse}(text, { construct: Payment, ...{ validate: false /* construct: Sub */ } });`,
    `export const quotedText = ${parse}(text, { construct: Payment, ...{ validate: text === 'construct:' } });`,
    `export const variable = ${parse}(text, { construct: Payment, ...options });`,
    `export const spread = ${parse}(text, { construct: Payment, ...{ ...options, validate: false } });`,
    `export const called = ${parse}(text, { construct: Payment, ...pick() });`,
  ]);
});

test('a class named through a type-only namespace import is constructed through a value import of its member', (t) => {
  // protects: T-171 a type-only namespace import is erased, so the rewrite must import the class itself
  const root = project(t, ['type-only-namespace.ts', 'ledger.model.ts', 'ledger.model.generated.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.files.get('src/type-only-namespace.ts')?.imports, [
    { from: './ledger.model.generated.js', names: [] },
    { from: './ledger.model.js', names: ['Ledger'] },
    { from: './payment.model.generated.js', names: [] },
    { from: './payment.model.js', names: ['Payment'] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
  const code = rewritten(root, result, 'type-only-namespace.ts');
  assertLines(code, [
    "import { Payment as __golem_Payment } from './payment.model.js';",
    'export const payment = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: __golem_Payment });',
    'export const options = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: __golem_Payment, ...{ validate: false } });',
    'export const book = __golem_requireObjectCodec("TLedger_33333333").parse(text, { construct: __golem_Ledger });',
  ]);
  assert.ok(code.includes("import type * as models from './payment.model.js';"), 'the type-only import stays as the user wrote it');
});

test('a call on a model named only as a type imports the generated module that registers its codec, once', (t) => {
  // protects: T-190 / R-18 the rewrite names a codec id, so it also loads the module that registers it
  const root = project(t, ['load-codec.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.files.get('src/load-codec.ts')?.imports, [
    { from: './payment.model.generated.js', names: [] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
  const code = rewritten(root, result, 'load-codec.ts');
  assert.equal(code.split('\n').filter((line) => line === "import './payment.model.generated.js';").length, 1);
  assert.ok(code.includes("import type { TMoney } from './payment.model.js';"), 'the type-only import stays as the user wrote it');
});

test('a project reached through a folder link loads the generated module that registers the codec of its own model', (t) => {
  // protects: T-197 final review: own models regressed when the program spells files by the link and the codec keys by the real path
  const root = project(t, ['load-codec.ts']);
  const link = `${root}-link`;
  fs.symlinkSync(root, link, 'dir');
  t.after(() => fs.rmSync(link, { force: true }));

  const result = scan(link);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.files.get('src/load-codec.ts')?.imports, [
    { from: './payment.model.generated.js', names: [] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
});

test('a class imported only as a type is constructed through an aliased value import of its module', (t) => {
  const root = project(t, ['type-only.ts', 'ledger.model.ts', 'ledger.model.generated.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.files.get('src/type-only.ts')?.imports, [
    { from: './ledger.model.generated.js', names: [] },
    { from: './ledger.model.js', names: ['Ledger'] },
    { from: './payment.model.generated.js', names: [] },
    { from: './payment.model.js', names: ['Payment'] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
  const code = rewritten(root, result, 'type-only.ts');
  assertLines(code, [
    "import { Ledger as __golem_Ledger } from './ledger.model.js';",
    "import { Payment as __golem_Payment } from './payment.model.js';",
    'export const payment = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: __golem_Payment });',
    'export const book = __golem_requireObjectCodec("TLedger_33333333").parse(text, { construct: __golem_Ledger, ...{ validate: false } });',
    'export const again = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: __golem_Payment });',
  ]);
  assert.ok(code.includes("import type { Payment } from './payment.model.js';"), 'the type-only import stays as the user wrote it');
});

test('a model class registers once, several classes of one model register under their own keys, an existing statement is kept', (t) => {
  const root = project(t, ['ledger.model.ts', 'ledger.model.generated.ts', 'registered.model.ts', 'registered.model.generated.ts', 'rewritten.model.ts', 'rewritten.model.generated.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const ledger = rewritten(root, result, 'ledger.model.ts');
  assertLines(ledger, [
    'export class Ledger extends TLedgerBaseModel {}',
    '__golem_registerIModelClass("TLedger_33333333#Ledger", Ledger);',
    'export class AdminLedger extends TLedgerBaseModel {}',
    '__golem_registerIModelClass("TLedger_33333333#AdminLedger", AdminLedger);',
    'export class RushLedger extends AdminLedger {}',
  ]);
  assert.doesNotMatch(ledger, /RushLedger\)|"TLedger_33333333"/, 'a subclass and a default class do not register');
  assert.match(rewritten(root, result, 'payment.model.ts'), /\n__golem_registerIModelClass\("TPayment_22222222", Payment\);/);
  assert.deepEqual(result.files.get('src/ledger.model.ts')?.imports, [{ from: '@exprtlabs/golem/serde', names: ['registerIModelClass'] }]);
  assert.equal(result.files.get('src/registered.model.ts'), undefined, 'the plain statement exists');
  assert.equal(result.files.get('src/rewritten.model.ts'), undefined, 'the aliased statement exists');
});

test('classes of one model in several files register under <id>#<class>, and the model has no default class', (t) => {
  // protects: T-195 review: the default class of a model never depends on which file loads last
  const root = project(t);
  for (const name of ['A', 'B']) fs.writeFileSync(path.join(root, `src/${name.toLowerCase()}.ts`), `import { TPaymentBaseModel } from './payment.model.generated.js';\nexport class ${name} extends TPaymentBaseModel {}\n`);

  const result = scan(root);

  assert.deepEqual(result.diagnostics, []);
  assertLines(rewritten(root, result, 'payment.model.ts'), ['__golem_registerIModelClass("TPayment_22222222#Payment", Payment);']);
  assertLines(rewritten(root, result, 'a.ts'), ['__golem_registerIModelClass("TPayment_22222222#A", A);']);
  assertLines(rewritten(root, result, 'b.ts'), ['__golem_registerIModelClass("TPayment_22222222#B", B);']);
});

test('a class that reaches the generated base through a renamed re-export counts as a class of its model', (t) => {
  // protects: T-207 a class whose file never names the BaseModel was left out of the model's class count
  const root = project(t);
  fs.writeFileSync(path.join(root, 'src/base.ts'), "export { TPaymentBaseModel as PaymentBase } from './payment.model.generated.js';\n");
  fs.writeFileSync(path.join(root, 'src/a.ts'), "import { PaymentBase } from './base.js';\nexport class A extends PaymentBase {}\n");

  const result = scan(root);

  assert.deepEqual(result.diagnostics, []);
  assertLines(rewritten(root, result, 'payment.model.ts'), ['__golem_registerIModelClass("TPayment_22222222#Payment", Payment);']);
  assertLines(rewritten(root, result, 'a.ts'), ['__golem_registerIModelClass("TPayment_22222222#A", A);']);
});

test('a @Body() class that reaches the generated base through another class gets the codec of its model', (t) => {
  // protects: T-195 review: a chain class was a model in the document and had no codec at run time
  const root = project(t);
  fs.writeFileSync(path.join(root, 'src/rush.controller.ts'), 'import type { Payment } from \'./payment.model.js\';\nexport class RushPayment extends Payment {}\ndeclare const Body: () => ParameterDecorator;\nexport class RushController {\n  create(@Body() input: RushPayment): void {}\n}\n');

  const result = scan(root, true);

  assert.deepEqual(result.diagnostics, []);
  assert.ok(rewritten(root, result, 'rush.controller.ts').includes('@__golem_nestModelCodec("TPayment_22222222") input: RushPayment'));
});

test('a @Body() model that is a default export says to export the class by name', (t) => {
  // protects: T-195 review: "run golem generate" never fixes a default export, so the message names the fix
  const root = project(t, ['default-class.model.ts', 'default-class.model.generated.ts']);
  fs.writeFileSync(path.join(root, 'src/default.controller.ts'), 'import type DefaultClass from \'./default-class.model.js\';\ndeclare const Body: () => ParameterDecorator;\nexport class DefaultController {\n  create(@Body() input: DefaultClass): void {}\n}\n');

  const { diagnostics } = scan(root, true);

  assert.deepEqual(diagnostics.map(({ code, message }) => ({ code, message })), [{
    code: 'RUNM1071',
    message: '@Body() type DefaultClass is the default export of its file, which has no codec id; golem generate cannot add one. Export the class by name (export class DefaultClass) and import it by name.',
  }]);
});

/** Install a one-model SDK as `node_modules/sdk`; returns its directory. */
function installSdk(root: string): string {
  const sdk = path.join(root, 'node_modules/sdk');
  writeGeneratedArtifacts(writeSdk({
    openapi: '3.1.0',
    info: { title: 'Sdk', version: '1' },
    components: { schemas: { Money: { type: 'object', required: ['cents'], properties: { cents: { type: 'number' } } } } },
  }, { output: sdk, name: 'sdk', profile: { mobx: false, validation: false } }).artifacts);
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'sdk', type: 'module', types: './index.ts', main: './index.ts' }));
  return sdk;
}

/** The manifest of an installed SDK, parsed. */
function sdkManifest(sdk: string): { models: { id: string; codecId?: string; generated: { module: string; export: string } }[] } {
  return JSON.parse(fs.readFileSync(path.join(sdk, 'model-manifest.json'), 'utf8'));
}

/** The codec id the SDK's manifest gives `MoneyModel`. */
function sdkMoneyId(sdk: string): string {
  const id = sdkManifest(sdk).models.find((model) => model.generated.export === 'MoneyModel')?.codecId;
  assert.match(id ?? '', /^Money_[0-9a-f]{8}$/, 'the SDK manifest holds the codec id of MoneyModel');
  return id!;
}

const USE_SDK = `import { parse } from '@exprtlabs/golem/serde';
import type { MoneyModel } from 'sdk';
declare const text: string;
export const money = parse<MoneyModel>(text);
`;

test('a type from an installed SDK resolves through the codec id of its manifest, and constructs the SDK class', (t) => {
  const root = project(t);
  const sdk = installSdk(root);
  const id = sdkMoneyId(sdk);
  fs.writeFileSync(path.join(root, 'src/use-sdk.ts'), USE_SDK);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assertLines(rewritten(root, result, 'use-sdk.ts'), [
    `export const money = __golem_requireObjectCodec("${id}").parse(text, { construct: __golem_MoneyModel });`,
    "import { MoneyModel as __golem_MoneyModel } from 'sdk';",
  ]);
  assert.deepEqual(scanned(result, 'use-sdk.ts').dependencies, ['node_modules/sdk/model-manifest.json'], 'the manifest is what the edit was resolved from');
  assert.deepEqual([...result.files.keys()].filter((file) => file.includes('node_modules')), [], 'installed packages are not rewritten');
});

test('a call on a type of an installed SDK loads the module of the SDK that registers its codec', (t) => {
  // protects: T-190 / R-18 an SDK model has no companion in the project, so the SDK's generated module is what loads
  const root = project(t);
  installSdk(root);
  fs.writeFileSync(path.join(root, 'src/write-sdk.ts'), [
    "import { stringify } from '@exprtlabs/golem/serde';",
    "import type { MoneyModel } from 'sdk';",
    'declare const money: MoneyModel;',
    'export const text = stringify<MoneyModel>(money);',
    '',
  ].join('\n'));
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(scanned(result, 'write-sdk.ts').imports, [
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
    { from: 'sdk/models/Money.js', names: [] },
  ]);
  assert.ok(rewritten(root, result, 'write-sdk.ts').split('\n').includes("import 'sdk/models/Money.js';"));
});

test('a call on an SDK type that the file imports through a project re-export loads the module of the SDK that registers it', (t) => {
  // protects: T-190 a re-exporting project module compiles to an empty import, so the SDK's own module is what must load
  const root = project(t);
  installSdk(root);
  fs.writeFileSync(path.join(root, 'src/types.ts'), "export type { MoneyModel } from 'sdk';\n");
  fs.writeFileSync(path.join(root, 'src/write-sdk.ts'), [
    "import { stringify } from '@exprtlabs/golem/serde';",
    "import type { MoneyModel } from './types.js';",
    'declare const money: MoneyModel;',
    'export const text = stringify<MoneyModel>(money);',
    '',
  ].join('\n'));
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(scanned(result, 'write-sdk.ts').imports, [
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
    { from: 'sdk/models/Money.js', names: [] },
  ]);
});

test('two manifests that give one declaration different codec ids make a call on it fail instead of choosing one', (t) => {
  const root = project(t);
  const sdk = installSdk(root);
  const manifest = sdkManifest(sdk);
  for (const model of manifest.models) model.codecId = 'Money_00000000';
  fs.writeFileSync(path.join(sdk, 'other-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'src/other-manifest.ts'), '/* @golem-model-manifest ../node_modules/sdk/other-manifest.json */\nexport {};\n');
  fs.writeFileSync(path.join(root, 'src/use-sdk.ts'), USE_SDK);
  const { diagnostics, files } = scan(root);
  assert.deepEqual(diagnostics.map(({ code, message, file }) => ({ code, message, file })), [{ code: 'RUNM1067', message: 'parse<MoneyModel> has no unique codec id', file: 'src/use-sdk.ts' }]);
  assert.equal(files.get('src/use-sdk.ts'), undefined);
});

test('a user type that shares a file name and a type name with an SDK type never takes the SDK codec id', (t) => {
  const root = project(t);
  installSdk(root);
  fs.writeFileSync(path.join(root, 'src/use-sdk.ts'), USE_SDK);
  // Every SDK declares its types in types.ts; this project's own types.ts declares its own Money.
  fs.writeFileSync(path.join(root, 'src/types.ts'), 'export type Money = { amount: string };\n');
  fs.writeFileSync(path.join(root, 'src/use-own.ts'), "import { parse } from '@exprtlabs/golem/serde';\nimport type { Money } from './types.js';\ndeclare const text: string;\nexport const money = parse<Money>(text);\n");
  const { diagnostics, files } = scan(root);
  assert.deepEqual(diagnostics.map(({ code, message, file }) => ({ code, message, file })), [{ code: 'RUNM1067', message: 'parse<Money> has no unique codec id', file: 'src/use-own.ts' }]);
  assert.equal(files.get('src/use-own.ts'), undefined);
});

test('a regenerated codec key file changes what the next scan stamps', (t) => {
  const root = project(t, ['calls.ts']);
  assert.match(rewritten(root, scan(root), 'calls.ts'), /requireObjectCodec\("TMoney_11111111"\)\.stringify\(/);
  const file = path.join(root, CODEC_KEYS);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('TMoney_11111111', 'TMoney_99999999'));
  assert.match(rewritten(root, scan(root), 'calls.ts'), /requireObjectCodec\("TMoney_99999999"\)\.stringify\(/);
});

test('a codec key file that is not golem\'s fails the scan with the file and what to run', (t) => {
  const root = project(t, ['calls.ts']);
  fs.writeFileSync(path.join(root, CODEC_KEYS), '{ "keys": [] }\n');
  assert.throws(() => scan(root), /codec-keys\.json is not a golem codec key file; run golem generate\./);
});

test('a type argument that is not a type name, a type without a codec and a type parameter are reported with their position', (t) => {
  const root = project(t, ['bad-arguments.ts']);
  const source = readFixture('rewrite/bad-arguments.ts');
  const { diagnostics, files } = scan(root);
  const at = (needle: string): { line: number; column: number } => position(source, needle);
  const expected = (code: string, message: string, needle: string) => ({ code, severity: 'error', message, file: 'src/bad-arguments.ts', ...at(needle) });
  assert.deepEqual(diagnostics, [
    expected('RUNM1066', 'parse type argument must be a single type name or typeof expression', 'parse<TMoney | null>'),
    expected('RUNM1066', 'stringify type argument must be a single type name or typeof expression', 'stringify<Array<TMoney>>'),
    expected('RUNM1066', 'assert type argument must be a single type name or typeof expression', 'assertValue<TMoney, TMoney>'),
    expected('RUNM1067', 'parse<TUnkeyed> has no unique codec id', 'parse<TUnkeyed>'),
    expected('RUNM1067', 'parse<T> has no unique codec id', 'parse<T>(value)'),
  ]);
  assert.equal(files.get('src/bad-arguments.ts'), undefined);
});

test('parse<T> used as a value or with an optional call is reported with its position, and a direct call is rewritten', (t) => {
  // protects: F-36 an unrewritten serde call throws at run time, so the build reports each form it cannot rewrite
  const root = project(t, ['value-use.ts']);
  const source = readFixture('rewrite/value-use.ts');
  const { diagnostics, files } = scan(root);
  const expected = (message: string, needle: string) => ({ code: 'RUNM1079', severity: 'error', message, file: 'src/value-use.ts', ...position(source, needle) });
  assert.deepEqual(diagnostics, [
    expected('parse<TMoney> is used as a value, which golem cannot rewrite. Call parse<TMoney>(...) directly.', 'parse<TMoney>;'),
    expected('parse<TMoney> is used as a value, which golem cannot rewrite. Call parse<TMoney>(...) directly.', 'parse<TMoney>)'),
    expected('parse?.<TMoney>(...) is an optional call, which golem cannot rewrite. Call parse<TMoney>(...) directly.', 'parse?.<TMoney>'),
  ]);
  assertLines(rewritten(root, { diagnostics, files }, 'value-use.ts'), ['export const direct = __golem_requireObjectCodec("TMoney_11111111").parse(texts[0]!);']);
});

test('a file that gets a rewrite may not use a name that starts with the added import prefix', (t) => {
  const root = project(t, ['reserved-name.ts', 'reserved-name-unrewritten.ts', 'class-clash.ts', 'other/payment.model.ts', 'other/payment.model.generated.ts']);
  // The `other` Payment has a codec id of its own; the shared fixture names only the one in src/.
  const keysFile = path.join(root, CODEC_KEYS);
  const table: { version: number; keys: Record<string, string> } = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  fs.writeFileSync(keysFile, JSON.stringify({ ...table, keys: { ...table.keys, 'src/other/payment.model.ts#Payment': 'TPayment_66666666' } }));
  const { diagnostics } = scan(root);
  const reserved = readFixture('rewrite/reserved-name.ts');
  const clash = readFixture('rewrite/class-clash.ts');
  assert.deepEqual(diagnostics, [
    {
      code: 'RUNM1069',
      severity: 'error',
      message: '"Payment" is imported from both ./payment.model.js and ./other/payment.model.js; golem needs one module for each name it imports for a rewrite.',
      file: 'src/class-clash.ts',
      ...position(clash, 'Second>(text)'),
    },
    {
      code: 'RUNM1068',
      severity: 'error',
      message: '"__golem_requireObjectCodec" starts with __golem_, which golem reserves for the names it adds when it rewrites a file. Rename it.',
      file: 'src/reserved-name.ts',
      ...position(reserved, '__golem_requireObjectCodec'),
    },
  ]);
});

test('the scan lists files in path order and each file\'s edits in source order, the same way every time', (t) => {
  const root = project(t, ['calls.ts', 'construct.ts', 'ledger.model.ts', 'ledger.model.generated.ts']);
  const first = scan(root);
  assert.deepEqual(first.diagnostics, []);
  const files = [...first.files.keys()];
  assert.deepEqual(files, [...files].sort());
  for (const file of first.files.values()) {
    assert.deepEqual(file.edits.map(({ start, end }) => [start, end]), file.edits.map(({ start, end }) => [start, end]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
  }
  assert.deepEqual(scan(root), first);
});

test('a call whose type argument is parenthesised is rewritten in a file that shows no golem text', (t) => {
  const root = project(t, ['index.ts', 'write.ts', 'paren-type-argument.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assertLines(rewritten(root, result, 'paren-type-argument.ts'), [
    'export const parsed = __golem_requireObjectCodec("TMoney_11111111").parse(text);',
  ]);
});

/** A project whose `golem.yaml` has one models job, with `src/use.ts` parsing the generated class `Payment`. */
function generatedProject(t: TestContext): { root: string; config: string } {
  const { root } = createModelProject(t, {
    prefix: 'golem-rewrite-pipeline-',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  fs.writeFileSync(path.join(root, 'src/use.ts'), `import { parse } from '@exprtlabs/golem/serde';
import { Payment } from './money.model.js';
export const payment = parse<Payment>('{}');
`);
  return { root, config: path.join(root, 'golem.yaml') };
}

test('golem check reports the sites golem cannot rewrite with their code and position, and a rewritable project passes', async (t) => {
  const { root, config } = generatedProject(t);
  await runPipeline(config);
  await runPipeline(config, { check: true });

  fs.writeFileSync(path.join(root, 'src/use.ts'), "import { parse } from '@exprtlabs/golem/serde';\nexport const bad = parse<string | null>('{}');\n");
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1066 \(src\/use\.ts:2:20\): parse type argument must be a single type name or typeof expression/);
  fs.writeFileSync(path.join(root, 'src/use.ts'), "import { parse } from '@exprtlabs/golem/serde';\nimport { Payment } from './money.model.js';\nexport const payment = parse<Payment>('{}');\n");
  await runPipeline(config, { check: true });
});

test('a models job owns .golem/codec-keys.json, and the project it generates passes the check with its codec ids', async (t) => {
  const { root, config } = generatedProject(t);
  await runPipeline(config);
  const inventory: { files: Record<string, { job: string }> } = JSON.parse(fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8'));
  assert.equal(inventory.files['.golem/codec-keys.json']?.job, 'models:.', 'the codec key file is an owned output of the models job');
  const table: { version: number; keys: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8'));
  assert.equal(table.version, 1);
  assert.match(table.keys['src/money.model.ts#Payment'] ?? '', /^TPayment_[0-9a-f]{8}$/, 'keys name the source from the tsconfig directory');
  await runPipeline(config, { check: true });
});

/**
 * An app beside a shared folder whose own golem.yaml has a models job, and an installed package `@acme/money` whose declaration
 * file declares the IObject alias `TPkgMoney`. The app's golem.yaml has a models job, and `src/use.ts` is the app's own site.
 */
function appBesideForeignModels(t: TestContext, site: string): { readonly app: string; readonly shared: string; readonly declaration: string; readonly config: string } {
  const { root: outer } = createModelProject(t, {
    prefix: 'golem-rewrite-foreign-',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  const compilerOptions = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true };
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(outer, file)), { recursive: true });
    fs.writeFileSync(path.join(outer, file), text);
  };
  write('shared/package.json', JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }));
  write('shared/golem.yaml', 'version: 1\nmodels:\n  root: .\n');
  write('shared/tsconfig.json', JSON.stringify({ compilerOptions, include: ['src/**/*.ts'] }));
  write('shared/src/money.model.ts', "import type { IObject } from '@exprtlabs/golem/model';\nexport type TMoney = IObject<{ currency: string }>;\n");
  write('node_modules/@acme/money/package.json', JSON.stringify({ name: '@acme/money', version: '1.0.0', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }));
  write('node_modules/@acme/money/index.d.ts', "import type { IObject } from '@exprtlabs/golem/model';\nexport type TPkgMoney = IObject<{ currency: string }>;\n");
  write('app/package.json', JSON.stringify({ name: 'app', private: true, type: 'module' }));
  write('app/golem.yaml', 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  write('app/tsconfig.json', JSON.stringify({ compilerOptions, include: ['src/**/*.ts', '../shared/**/*.ts'] }));
  write('app/src/order.model.ts', "import type { IModel } from '@exprtlabs/golem/model';\nexport type TOrder = IModel<{ id: string }>;\n");
  write('app/src/use.ts', site);
  const app = path.join(outer, 'app');
  return {
    app,
    shared: path.join(outer, 'shared'),
    declaration: fs.realpathSync(path.join(outer, 'node_modules/@acme/money/index.d.ts')),
    config: path.join(app, 'golem.yaml'),
  };
}

test('golem check reports a serde call on a model of an installed package whose file has no model suffix, with the model and the suffix', async (t) => {
  // protects: R-20 RUNM1074 keeps one reason in golem check: the model file has no model suffix
  const { declaration, config } = appBesideForeignModels(t, `import { stringify } from '@exprtlabs/golem/serde';
import type { TPkgMoney } from '@acme/money';
declare const money: TPkgMoney;
export const text = stringify<TPkgMoney>(money);
`);
  await runPipeline(config);
  await assert.rejects(
    runPipeline(config, { check: true }),
    { message: `golem rewrite scan reported 1 error diagnostic:\n  RUNM1074 (src/use.ts:4:21): ${path.relative(process.cwd(), declaration)}#TPkgMoney is declared in a file whose name has no model suffix. Golem reads a model from a file whose name ends in .model.ts or .models.ts. Move the model into such a file.` },
  );
});

test('a config without a models or controllers job still checks the project that calls an SDK', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-rewrite-consumer-',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-openapi': path.join(workspace, 'packages/golem-openapi') },
  });
  writeFixture(root, { mobx: false, validation: false }, false);
  const use = path.join(root, 'src/use.ts');
  fs.writeFileSync(use, `import { parse } from '@exprtlabs/golem/serde';
import type { MoneyModel } from '../sdk/index.js';
declare const text: string;
export const money = parse<MoneyModel>(text);
`);
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });
  fs.appendFileSync(use, "export const bad = parse<string | null>('{}');\n");
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1066 \(src\/use\.ts:5:20\)/);
});

test('a file outside the project root with a rewrite site is rewritten by the project scan and by the per-file scan', (t) => {
  const { root: outer } = createModelProject(t, { prefix: 'golem-rewrite-outside-', linkTypescript: true });
  const root = path.join(outer, 'app');
  for (const file of BASE) copyFixtureFile(root, `rewrite/${file}`, `src/${file}`);
  copyFixtureFile(root, 'rewrite/codec-keys.json', CODEC_KEYS);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts', '../shared/**/*.ts'],
  }));
  fs.mkdirSync(path.join(outer, 'shared'));
  fs.writeFileSync(path.join(outer, 'shared/x.ts'), `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from '../app/src/payment.model.js';
declare const text: string;
export const money = parse<TMoney>(text);
`);
  fs.writeFileSync(path.join(outer, 'shared/payment.model.ts'), `import { TPaymentBaseModel } from '../app/src/payment.model.generated.js';
export class SharedPayment extends TPaymentBaseModel {}
`);
  fs.writeFileSync(path.join(outer, 'shared/plain.ts'), "export const plain = 1;\n");
  // Keys are exact paths from the tsconfig directory, so the class outside the root has a key of its own.
  const keysFile = path.join(root, CODEC_KEYS);
  const table: { version: number; keys: Record<string, string> } = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  fs.writeFileSync(keysFile, JSON.stringify({ ...table, keys: { ...table.keys, '../shared/payment.model.ts#SharedPayment': 'TPayment_22222222' } }));
  const { diagnostics, files } = scan(root);
  const xBefore = fs.readFileSync(path.join(outer, 'shared/x.ts'), 'utf8');
  const classBefore = fs.readFileSync(path.join(outer, 'shared/payment.model.ts'), 'utf8');
  const money = 'export const money = __golem_requireObjectCodec("TMoney_11111111").parse(text);';
  // The app's own Payment is a second class of the model, so each registers under its own key.
  const registration = '__golem_registerIModelClass("TPayment_22222222#SharedPayment", SharedPayment);';
  const outsideCode = (file: string, before: string, from: ProgramScan['files']): string => applyRewrites(before, from.get(file)!).code;
  assert.deepEqual(diagnostics, []);
  assert.deepEqual([...files.keys()], ['../shared/payment.model.ts', '../shared/x.ts', 'src/payment.model.ts']);
  assertLines(outsideCode('../shared/x.ts', xBefore, files), [SERDE, money]);
  assertLines(outsideCode('../shared/payment.model.ts', classBefore, files), [registration]);

  // A host scans one file at a time and rewrites the same sites. A class site is the end of the class, where its registration goes.
  withScanner(root, (scanner) => {
    const x = scanner.scanFile(path.join(outer, 'shared/x.ts'));
    assert.deepEqual(x?.diagnostics, []);
    assertLines(applyRewrites(xBefore, x!).code, [SERDE, money]);
    const model = scanner.scanFile(path.join(outer, 'shared/payment.model.ts'));
    assert.deepEqual(model?.diagnostics, []);
    assertLines(applyRewrites(classBefore, model!).code, [registration]);
    const plain = scanner.scanFile(path.join(outer, 'shared/plain.ts'));
    assert.deepEqual(plain?.diagnostics, []);
    assert.deepEqual(plain?.edits, []);
  });
});

test('typeof and a qualified name resolve like a plain type name; a default class import has no codec id', (t) => {
  const root = project(t, ['type-argument-forms.ts', 'default-class-import.ts', 'default-class.model.ts', 'default-class.model.generated.ts']);
  const result = scan(root);
  assertLines(rewritten(root, result, 'type-argument-forms.ts'), [
    'export const queried = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: Payment });',
    'export const qualified = __golem_requireObjectCodec("TMoney_11111111").parse(text);',
    'export const qualifiedClass = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: models.Payment });',
  ]);
  // The symbol of `export default class DefaultClass` is named "default", which no key table entry carries.
  assert.deepEqual(result.diagnostics, [{
    code: 'RUNM1067',
    severity: 'error',
    message: 'parse<DefaultClass> has no unique codec id',
    file: 'src/default-class-import.ts',
    ...position(readFixture('rewrite/default-class-import.ts'), 'parse<DefaultClass>'),
  }]);
  assert.equal(result.files.get('src/default-class-import.ts'), undefined);
});

/** A model project with an empty `src/` for tests that write their own key tables and sources. */
function bareProject(t: TestContext, files: Readonly<Record<string, string>>, keys?: Readonly<Record<string, string>>): string {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-scan-', linkTypescript: true });
  if (keys) writeGeneratedArtifacts([{ path: path.join(root, CODEC_KEYS), content: `${JSON.stringify({ version: 1, keys })}\n` }]);
  writeGeneratedArtifacts(Object.entries(files).map(([relative, content]) => ({ path: path.join(root, 'src', relative), content })));
  return root;
}

test('RUNM1067 for a model whose generated file is missing says to wait for golem generate or golem watch', (t) => {
  // protects: T-314 the hint says what to wait for when the generated file is not there yet
  const root = bareProject(t, {
    'a.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TA = IModel<{ id: string }>;\n",
    'use.ts': "import { parse } from '@exprtlabs/golem/serde';\nimport type { TA } from './a.model.js';\ndeclare const text: string;\nexport const a = parse<TA>(text);\n",
  });
  const messages = (): string[] => scan(root).diagnostics.map(({ message }) => message);

  assert.deepEqual(messages(), ['parse<TA> has no unique codec id. src/a.model.generated.ts is missing. Wait for golem generate or golem watch to write it.']);

  // A generated file that exists but lacks the key is not something to wait for, however old it is.
  const companion = path.join(root, 'src/a.model.generated.ts');
  fs.writeFileSync(companion, 'export {};\n');
  fs.utimesSync(companion, new Date(1_000_000), new Date(1_000_000));
  assert.deepEqual(messages(), ['parse<TA> has no unique codec id']);
});

test('a class registers under the id its own file keys, never under a same-named declaration of another file', (t) => {
  const root = bareProject(t, {
    // `Foo` is keyed only in b.model.ts; a.model.ts declares its own `Foo` and reads b's through a namespace.
    'b.model.ts': 'export type TFoo = { id: string };\nexport const Foo = 1;\n',
    'a.model.generated.ts': 'export abstract class TFooBaseModel {}\n',
    'a.model.ts': "import { TFooBaseModel } from './a.model.generated.js';\nimport * as b from './b.model.js';\nexport class Foo extends TFooBaseModel {}\nexport const other = b.Foo;\n",
    'c.model.generated.ts': 'export abstract class TBarBaseModel {}\n',
    'c.model.ts': "import { TBarBaseModel } from './c.model.generated.js';\nexport class Bar extends TBarBaseModel {}\n",
  }, { 'src/b.model.ts#Foo': 'TFoo_bbbbbbbb', 'src/b.model.ts#TFoo': 'TFoo_bbbbbbbb', 'src/c.model.ts#Bar': 'TBar_cccccccc' });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.get('src/a.model.ts'), undefined, 'a class with no key of its own is not registered');
  assert.match(rewritten(root, result, 'c.model.ts'), /\n__golem_registerIModelClass\("TBar_cccccccc", Bar\);/, 'a keyed class still registers');
});

test('createProjectProgram keeps its observer and session arguments, and takes the tsconfig as an optional last argument', (t) => {
  const root = project(t, ['calls.ts']);
  fs.writeFileSync(path.join(root, 'tsconfig.calls.json'), JSON.stringify({ extends: './tsconfig.json', include: ['src/calls.ts'], exclude: [] }));
  const open = (...args: [undefined | ((file: string) => void), undefined, string?]): string[] => {
    const info = createProjectProgram(root, ...args);
    try {
      return info.projectFiles.map((file) => path.relative(root, file)).filter((file) => file.startsWith('src'));
    } finally {
      info.program[Symbol.dispose]();
    }
  };
  const seen = new Set<string>();
  const found = open((file) => { seen.add(path.relative(root, file)); }, undefined);
  assert.ok(found.includes('src/payment.model.ts'), found.join());
  assert.ok(seen.has('tsconfig.json'), 'the tsconfig found from the root is observed');
  assert.deepEqual(open(undefined, undefined, path.join(root, 'tsconfig.calls.json')), ['src/calls.ts']);
});

test('scanFile answers for one file as scanProgram does, and for no file that is not a rewrite candidate', (t) => {
  const root = project(t, ['calls.ts']);
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.d.ts'), 'export declare const x: number;\n');
  fs.writeFileSync(path.join(root, 'src/declared.d.ts'), 'export declare const y: number;\n');
  const absolute = (relative: string): string => path.join(root, relative);
  withScanner(root, (scanner) => {
    const all = scanner.scanProgram();
    assert.deepEqual(scanner.scanFile(absolute('src/calls.ts')), all.files.get('src/calls.ts'));
    assert.deepEqual(scanner.scanFile(absolute('src/payment.model.ts')), all.files.get('src/payment.model.ts'));
    assert.deepEqual(scanner.scanFile(absolute('src/payment.model.ts'))?.edits.map(({ expect }) => expect), ['']);
    for (const candidate of ['src/payment.model.generated.ts', 'src/declared.d.ts', 'node_modules/pkg/index.d.ts', 'src/not-in-the-program.ts']) {
      assert.equal(scanner.scanFile(absolute(candidate)), undefined, candidate);
    }
  });
});

test('a file lists the codec key file and generated files its edits were resolved from', (t) => {
  const root = project(t, ['calls.ts', 'ledger.model.ts', 'ledger.model.generated.ts']);
  const result = scan(root);
  assert.deepEqual(scanned(result, 'calls.ts').dependencies, [CODEC_KEYS]);
  assert.deepEqual(scanned(result, 'ledger.model.ts').dependencies, [CODEC_KEYS, 'src/ledger.model.generated.ts']);
  assert.deepEqual(scanned(result, 'payment.model.ts').dependencies, [CODEC_KEYS, 'src/payment.model.generated.ts']);
});

test('a file with a byte order mark, CRLF line ends and Vietnamese text is scanned and applied at the compiler offsets', (t) => {
  const root = project(t, ['bom-crlf.ts']);
  // Git may normalise line ends in a checkout, so the test sets them.
  const fixture = path.join(root, 'src/bom-crlf.ts');
  fs.writeFileSync(fixture, fs.readFileSync(fixture, 'utf8').replace(/\r?\n/g, '\r\n'));
  const raw = fs.readFileSync(fixture, 'utf8');
  assert.equal(raw.startsWith('\uFEFF'), true, 'the fixture starts with a byte order mark');
  assert.equal(raw.includes('\r\n'), true);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const entry = scanned(result, 'bom-crlf.ts');
  const text = raw.slice(1);
  const call = 'parse<TMoney>(';
  assert.deepEqual(entry.edits.map(({ start, end, expect }) => ({ start, end, expect })), [{ start: text.indexOf(call), end: text.indexOf(call) + call.length, expect: call }]);

  const applied = applyRewrites(raw, entry);
  assert.equal(applied.code.startsWith(`\uFEFF${PAYMENT_MODULE}\n${SERDE}\n`), true, 'the mark stays first');
  assert.equal(applied.code, `\uFEFF${PAYMENT_MODULE}\n${SERDE}\n${text.replace(call, '__golem_requireObjectCodec("TMoney_11111111").parse(')}`);
  assert.equal(applyRewrites(text, entry).code, applied.code.slice(1), 'the text without the mark gives the same code without it');

  // The rewritten call resolves, through the map, to the original line and column of the call.
  const code = applied.code;
  const offset = code.indexOf('__golem_requireObjectCodec("TMoney');
  const before = code.slice(0, offset).split(/\r\n|\n/);
  const generatedLine = before.length - 1;
  const generatedColumn = before[generatedLine]!.length;
  const segment = [...(decodeMappings(applied.map.mappings)[generatedLine] ?? [])].reverse().find((candidate) => candidate[0]! <= generatedColumn);
  assert.ok(segment && segment.length >= 4);
  const original = text.slice(0, text.indexOf('parse<TMoney>')).split(/\r\n|\n/);
  assert.deepEqual([segment[2], segment[3]], [original.length - 1, original[original.length - 1]!.length]);
});

test('a // comment between the type arguments and the opening parenthesis goes with the replaced text', (t) => {
  const root = project(t);
  const source = `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './payment.model.js';
declare const text: string;
export const money = parse<TMoney> // keep the codec
  (text);
export const next = 1;
`;
  fs.writeFileSync(path.join(root, 'src/line-comment.ts'), source);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const entry = scanned(result, 'line-comment.ts');
  assert.deepEqual(entry.edits.map(({ expect }) => expect), ['parse<TMoney> // keep the codec\n  (']);
  const applied = applyRewrites(source, entry);
  assert.equal(applied.code, `${PAYMENT_MODULE}\n${SERDE}\n${source.replace('parse<TMoney> // keep the codec\n  (', '__golem_requireObjectCodec("TMoney_11111111").parse(')}`);
  // The line after the collapsed call still resolves to its own original line.
  const generated = applied.code.split('\n');
  const line = generated.findIndex((each) => each.startsWith('export const next'));
  const segment = decodeMappings(applied.map.mappings)[line]?.[0];
  assert.equal(segment?.[2], source.split('\n').findIndex((each) => each.startsWith('export const next')));
});

test('a class extending a base from any generated module registers, whatever suffix its file has', (t) => {
  const root = bareProject(t, {
    'order.entity.generated.ts': 'export abstract class TOrderBaseModel {}\n',
    'order.entity.ts': "import { TOrderBaseModel } from './order.entity.generated.js';\nexport type TOrder = { id: string };\nexport class Order extends TOrderBaseModel {}\n",
  }, { 'src/order.entity.ts#Order': 'TOrder_aaaaaaaa', 'src/order.entity.ts#TOrder': 'TOrder_aaaaaaaa' });
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.match(rewritten(root, result, 'order.entity.ts'), /\n__golem_registerIModelClass\("TOrder_aaaaaaaa", Order\);/);
});
