import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { runPipeline } from '#golem/cli';
import { GeneratorSessionResources } from '#golem/pipeline';
import { applyRewrites, GolemRewriteStaleError, readRewriteIndex } from '#golem/rewrite';
import { assertRewriteIndexCurrent, scanProjectRewrites, writeRewriteIndex, type ScanResult } from '#golem/rewrite-scan';
import { writeSdk } from '#openapi/generator';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { writeFixture } from './support/consumer.js';
import { workspace } from './support/process.js';

const BASE = ['payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts'];

/** A project of the shared model fixtures plus the named fixture files, all under `src/`. */
function project(t: TestContext, files: readonly string[] = []): string {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-scan-', linkTypescript: true });
  for (const file of [...BASE, ...files]) copyFixtureFile(root, `rewrite/${file}`, `src/${file}`);
  return root;
}

function scan(root: string): ScanResult {
  return scanProjectRewrites({ root, nest: false });
}

/** The file after `applyRewrites`, as a host would see it. */
function rewritten(root: string, result: ScanResult, file: string): string {
  const relative = `src/${file}`;
  const output = applyRewrites(relative, fs.readFileSync(path.join(root, relative), 'utf8'), result.index);
  assert.ok(output, `${relative} has an index entry`);
  return output.code;
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

test('each serde call with a type argument becomes a call on its codec', (t) => {
  const root = project(t, ['calls.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, 'calls.ts');
  assert.equal(code.split('\n')[0], SERDE);
  assertLines(code, [
    'export const written = __golem_requireObjectCodec("TMoney_11111111").stringify(money);',
    'export const parsed = __golem_requireObjectCodec("TMoney_11111111").parse(text);',
    'export const checked = __golem_requireObjectCodec("TMoney_11111111").validate(money);',
    'export const asserted = __golem_requireObjectCodec("TMoney_11111111").assert(money);',
    'export const wire = __golem_requireObjectCodec("TMoney_11111111").toWireFormat(money);',
    'export const read = __golem_requireObjectCodec("TMoney_11111111").fromWireFormat(text);',
  ]);
  assert.deepEqual(result.index.files['src/calls.ts']?.imports, [{ from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] }]);
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
  assert.equal(result.index.files['src/not-serde.ts'], undefined, 'a local function, JSON.parse, an optional call, a comment and a call without a type argument stay');
  assert.equal(result.index.files['src/index.ts'], undefined);
});

test('parse and fromWireFormat of a class construct it, and options that name construct are kept', (t) => {
  const root = project(t, ['construct.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  const code = rewritten(root, result, 'construct.ts');
  const parse = '__golem_requireObjectCodec("TPayment_22222222").parse';
  assertLines(code, [
    `export const one = ${parse}(text, { construct: Payment });`,
    `export const two = ${parse}(text, { ...{ validate: false }, construct: Payment });`,
    `export const present = ${parse}(text, { construct: Payment });`,
    `export const wire = __golem_requireObjectCodec("TPayment_22222222").fromWireFormat({ id: '1' }, { construct: Payment });`,
    `export const plain = ${parse}(text);`,
    `export const nested = ${parse}(text, { ...{ validate: ${parse}(text) === undefined }, construct: Payment });`,
  ]);
  assert.deepEqual(result.index.files['src/construct.ts']?.imports, [{ from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] }]);
});

test('a class imported only as a type is constructed through an aliased value import of its module', (t) => {
  const root = project(t, ['type-only.ts', 'ledger.model.ts', 'ledger.model.generated.ts']);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.index.files['src/type-only.ts']?.imports, [
    { from: './ledger.model.js', names: ['Ledger'] },
    { from: './payment.model.js', names: ['Payment'] },
    { from: '@exprtlabs/golem/serde', names: ['requireObjectCodec'] },
  ]);
  const code = rewritten(root, result, 'type-only.ts');
  assertLines(code, [
    "import { Ledger as __golem_Ledger } from './ledger.model.js';",
    "import { Payment as __golem_Payment } from './payment.model.js';",
    'export const payment = __golem_requireObjectCodec("TPayment_22222222").parse(text, { construct: __golem_Payment });',
    'export const book = __golem_requireObjectCodec("TLedger_33333333").parse(text, { ...{ validate: false }, construct: __golem_Ledger });',
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
  assert.deepEqual(result.index.files['src/ledger.model.ts']?.imports, [{ from: '@exprtlabs/golem/serde', names: ['registerIModelClass'] }]);
  assert.equal(result.index.files['src/registered.model.ts'], undefined, 'the plain statement exists');
  assert.equal(result.index.files['src/rewritten.model.ts'], undefined, 'the aliased statement exists');
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

/** The codec id the SDK's key table gives `MoneyModel`. */
function sdkMoneyId(sdk: string): string {
  const id = /"models\/_group-[0-9a-f]{8}\.ts#MoneyModel": "(Money_[0-9a-f]{8})"/.exec(fs.readFileSync(path.join(sdk, 'iobject-plugin-keys.ts'), 'utf8'))?.[1];
  assert.ok(id, 'the SDK key table names MoneyModel');
  return id;
}

test('a type from an installed SDK resolves through its own key table', (t) => {
  const root = project(t);
  const id = sdkMoneyId(installSdk(root));
  fs.writeFileSync(path.join(root, 'src/use-sdk.ts'), `import { parse } from '@exprtlabs/golem/serde';
import type { MoneyModel } from 'sdk';
declare const text: string;
export const money = parse<MoneyModel>(text);
`);
  const result = scan(root);
  assert.deepEqual(result.diagnostics, []);
  assertLines(rewritten(root, result, 'use-sdk.ts'), [
    `export const money = __golem_requireObjectCodec("${id}").parse(text, { construct: __golem_MoneyModel });`,
    "import { MoneyModel as __golem_MoneyModel } from 'sdk';",
  ]);
  assert.deepEqual(Object.keys(result.index.files).filter((file) => file.includes('node_modules')), [], 'installed packages are not rewritten');
});

test('a type argument that is not a type name, a type without a codec and a type parameter are reported with their position', (t) => {
  const root = project(t, ['bad-arguments.ts']);
  const source = readFixture('rewrite/bad-arguments.ts');
  const { diagnostics, index } = scan(root);
  const at = (needle: string): { line: number; column: number } => position(source, needle);
  const expected = (code: string, message: string, needle: string) => ({ code, severity: 'error', message, file: 'src/bad-arguments.ts', ...at(needle) });
  assert.deepEqual(diagnostics, [
    expected('RUNM1066', 'parse type argument must be a single type name or typeof expression', 'parse<TMoney | null>'),
    expected('RUNM1066', 'stringify type argument must be a single type name or typeof expression', 'stringify<Array<TMoney>>'),
    expected('RUNM1066', 'assert type argument must be a single type name or typeof expression', 'assertValue<TMoney, TMoney>'),
    expected('RUNM1067', 'parse<TUnkeyed> has no unique codec id', 'parse<TUnkeyed>'),
    expected('RUNM1067', 'parse<T> has no unique codec id', 'parse<T>(value)'),
  ]);
  assert.equal(index.files['src/bad-arguments.ts'], undefined);
});

test('a file that gets a rewrite may not use a name that starts with the added import prefix', (t) => {
  const root = project(t, ['reserved-name.ts', 'reserved-name-unrewritten.ts', 'class-clash.ts', 'other/payment.model.ts', 'other/payment.model.generated.ts', 'other/iobject-plugin-keys.ts']);
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

test('an index is current only while it equals a fresh scan', (t) => {
  const root = project(t, ['calls.ts']);
  writeRewriteIndex(root, scan(root).index);
  assertRewriteIndexCurrent(root, scan(root).index);
  fs.appendFileSync(path.join(root, 'src/calls.ts'), '// edited\n');
  assert.throws(() => assertRewriteIndexCurrent(root, scan(root).index), (error: unknown) =>
    error instanceof GolemRewriteStaleError && error.file === 'src/calls.ts' && /src\/calls\.ts is out of date in \.golem\/rewrites\.json/.test(error.message));
});

test('a project without an index is current', (t) => {
  const root = project(t, ['calls.ts']);
  assertRewriteIndexCurrent(root, scan(root).index);
});

test('the same project always writes the same index, with its files and edits in order', (t) => {
  const root = project(t, ['calls.ts', 'construct.ts', 'ledger.model.ts', 'ledger.model.generated.ts']);
  const first = scan(root);
  assert.deepEqual(first.diagnostics, []);
  writeRewriteIndex(root, first.index);
  const bytes = fs.readFileSync(path.join(root, '.golem/rewrites.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(bytes) as object), ['version', 'golem', 'files'], 'the index holds no cache state');
  const second = scan(root);
  assert.equal(writeRewriteIndex(root, second.index), false);
  assert.equal(fs.readFileSync(path.join(root, '.golem/rewrites.json'), 'utf8'), bytes);
  assert.deepEqual(Object.keys(first.index.files), [...Object.keys(first.index.files)].sort());
  for (const file of Object.values(first.index.files)) {
    assert.deepEqual(file.edits.map(({ start, end }) => [start, end]), file.edits.map(({ start, end }) => [start, end]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
  }
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

test('golem generate writes the index, writes it identically twice, and a model change updates the ids of files that did not change', async (t) => {
  const { root, config } = generatedProject(t);
  const indexFile = path.join(root, '.golem/rewrites.json');

  await runPipeline(config);
  const first = fs.readFileSync(indexFile, 'utf8');
  const index = readRewriteIndex(root);
  assert.deepEqual(Object.keys(index?.files ?? {}), ['src/money.model.ts', 'src/use.ts']);
  const usedId = (): string => /requireObjectCodec\("(TPayment_[0-9a-f]{8})"\)/.exec(readRewriteIndex(root)?.files['src/use.ts']?.edits[0]?.text ?? '')?.[1] ?? '';
  const before = usedId();
  assert.match(before, /^TPayment_[0-9a-f]{8}$/);
  assert.match(readRewriteIndex(root)?.files['src/money.model.ts']?.edits[0]?.text ?? '', new RegExp(`registerIModelClass\\("${before}", Payment\\)`));

  await runPipeline(config);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), first, 'a second run writes the same bytes');
  await runPipeline(config, { check: true });

  fs.writeFileSync(path.join(root, 'src/money.model.ts'), fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('note: string', 'note: string; extra: string'));
  await runPipeline(config);
  assert.notEqual(usedId(), before, 'use.ts did not change, its codec did');
  await runPipeline(config, { check: true });

  fs.appendFileSync(path.join(root, 'src/use.ts'), '// edited\n');
  await assert.rejects(runPipeline(config, { check: true }), /src\/use\.ts is out of date in \.golem\/rewrites\.json/);
  fs.writeFileSync(path.join(root, 'src/use.ts'), "import { parse } from '@exprtlabs/golem/serde';\nexport const bad = parse<string | null>('{}');\n");
  await assert.rejects(runPipeline(config), /RUNM1066 \(src\/use\.ts:2:20\): parse type argument must be a single type name or typeof expression/);
});

test('golem check rescans: a new call, a stale codec id and a removed file fail it, an up-to-date index and a missing index pass', async (t) => {
  const { root, config } = generatedProject(t);
  const indexFile = path.join(root, '.golem/rewrites.json');
  await runPipeline(config);
  fs.rmSync(indexFile);
  await runPipeline(config, { check: true });
  assert.equal(fs.existsSync(indexFile), false, 'check without an index passes and writes none');
  await runPipeline(config);
  await runPipeline(config, { check: true });

  const index = fs.readFileSync(indexFile, 'utf8');
  const id = /requireObjectCodec\(\\"(TPayment_[0-9a-f]{8})\\"\)/.exec(index)?.[1];
  assert.ok(id, 'the index holds a codec id for use.ts');
  fs.writeFileSync(indexFile, index.split(id).join('TPayment_00000000'));
  await assert.rejects(runPipeline(config, { check: true }), /src\/(use|money\.model)\.ts is out of date in \.golem\/rewrites\.json/, 'the sha256 still matches, the codec id does not');
  fs.writeFileSync(indexFile, index);
  await runPipeline(config, { check: true });

  fs.writeFileSync(path.join(root, 'src/added.ts'), "import { parse } from '@exprtlabs/golem/serde';\nimport type { TPayment } from './money.model.js';\nexport const added = parse<TPayment>('{}');\n");
  await assert.rejects(runPipeline(config, { check: true }), /src\/added\.ts is out of date in \.golem\/rewrites\.json/, 'a file with a site and no entry');
  fs.rmSync(path.join(root, 'src/added.ts'));
  await runPipeline(config, { check: true });

  fs.rmSync(path.join(root, 'src/use.ts'));
  await assert.rejects(runPipeline(config, { check: true }), /src\/use\.ts is out of date in \.golem\/rewrites\.json/, 'an entry whose file is gone');
});

test('an edit to a file only the scan reads reruns the scan and reuses the models job', async (t) => {
  const { root, config } = generatedProject(t);
  const sdk = installSdk(root);
  fs.writeFileSync(path.join(root, 'src/use-sdk.ts'), `import { parse } from '@exprtlabs/golem/serde';
import type { MoneyModel } from 'sdk';
declare const text: string;
export const money = parse<MoneyModel>(text);
`);
  const keys = path.join(sdk, 'iobject-plugin-keys.ts');
  const id = sdkMoneyId(sdk);
  const codecId = (): string => /requireObjectCodec\("(Money_[0-9a-f]{8})"\)/.exec(readRewriteIndex(root)?.files['src/use-sdk.ts']?.edits[0]?.text ?? '')?.[1] ?? '';
  using session = new GeneratorSessionResources();
  const first = await runPipeline(config, { session });
  assert.equal(codecId(), id);
  assert.equal(first.dependencies.get(keys)?.has('models:.') ?? false, false, 'the models job does not read the installed SDK key table');
  fs.writeFileSync(keys, fs.readFileSync(keys, 'utf8').split(id).join('Money_00000000'));
  const second = await runPipeline(config, { session, previous: first, changedInputs: [keys], modelOnly: true });
  assert.equal(codecId(), 'Money_00000000', 'the scan saw the new key table');
  assert.equal(second.results.get('models:.'), first.results.get('models:.'), 'the models job was not rerun');
});

test('a config without a models or controllers job still indexes the project that calls an SDK', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-rewrite-consumer-',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-openapi': path.join(workspace, 'packages/golem-openapi') },
  });
  writeFixture(root, { mobx: false, validation: false }, false);
  fs.writeFileSync(path.join(root, 'src/use.ts'), `import { parse } from '@exprtlabs/golem/serde';
import type { MoneyModel } from '../sdk/index.js';
declare const text: string;
export const money = parse<MoneyModel>(text);
`);
  await runPipeline(path.join(root, 'golem.yaml'));
  const entry = readRewriteIndex(root)?.files['src/use.ts'];
  assert.match(entry?.edits[0]?.text ?? '', /^__golem_requireObjectCodec\("Money_[0-9a-f]{8}"\)\.parse\($/);
  assert.deepEqual(Object.keys(readRewriteIndex(root)?.files ?? {}), ['src/use.ts']);
  await runPipeline(path.join(root, 'golem.yaml'), { check: true });
});

test('a file outside the project root with a rewrite site fails generation, one without a site does not', (t) => {
  const { root: outer } = createModelProject(t, { prefix: 'golem-rewrite-outside-', linkTypescript: true });
  const root = path.join(outer, 'app');
  for (const file of BASE) copyFixtureFile(root, `rewrite/${file}`, `src/${file}`);
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
export class Payment extends TPaymentBaseModel {}
`);
  fs.writeFileSync(path.join(outer, 'shared/plain.ts'), "export const plain = 1;\n");
  const { diagnostics, index } = scanProjectRewrites({ root, nest: false });
  // A class site is the end of the class, where its registration goes.
  const message = (file: string): string => `"${file}" has a rewrite site but lies outside the project root. Move it under the root, or run golem generate for the package that contains it.`;
  assert.deepEqual(diagnostics, [
    { code: 'RUNM1070', severity: 'error', message: message('../shared/payment.model.ts'), file: '../shared/payment.model.ts', line: 2, column: 50 },
    { code: 'RUNM1070', severity: 'error', message: message('../shared/x.ts'), file: '../shared/x.ts', line: 4, column: 22 },
  ]);
  assert.deepEqual(Object.keys(index.files), ['src/payment.model.ts'], 'files outside the root are not indexed');
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
  assert.equal(result.index.files['src/default-class-import.ts'], undefined);
});
