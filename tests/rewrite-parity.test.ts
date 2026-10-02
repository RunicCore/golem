// Parity of golem's own rewrite (scanner plus applier, then plain tsc) with the Go ttsc plugin on every ttsc fixture.
// Deleted together with the Go plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { applyRewrites, readRewriteIndex } from '#golem/rewrite';
import { scanProjectRewrites, writeRewriteIndex, type ScanResult } from '#golem/rewrite-scan';
import { generate } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import { copyFixtureFile, createFixtureProject, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { paymentModelSource } from './fixture-templates/controllers/payment-model.js';
import { compileModelProjectWithTtsc, createModelProject } from './model-project.js';
import { command, ttsc, ttscEnv, workspace } from './support/process.js';

const NEST_PLUGIN = '@exprtlabs/golem-ts-openapi/ttsc-plugin';
const SERDE_PLUGIN = '@exprtlabs/golem/ttsc-plugin';
const TSC = path.join(workspace, 'node_modules/typescript/bin/tsc');
const NEST = 'controllers/nest-plugin';
const PROFILE = { mobx: false, validation: true } as const;

// Project setup

interface Tsconfig {
  compilerOptions: Record<string, unknown>;
  include: string[];
}

function editTsconfig(root: string, edit: (tsconfig: Tsconfig) => void): void {
  const file = path.join(root, 'tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(file, 'utf8')) as Tsconfig;
  edit(tsconfig);
  fs.writeFileSync(file, JSON.stringify(tsconfig));
}

function usePlugins(root: string, ...plugins: readonly string[]): void {
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.plugins = plugins.map((transform) => ({ transform })); });
}

function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

/** A serde project with the shared money model, its generated files and the serde plugin on. */
function serdeProject(t: TestContext, name: string, profile: { mobx: boolean; validation: boolean } = PROFILE): string {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-parity-', name, linkTypescript: true, linkTtsc: true });
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  writeGeneratedArtifacts(generate({ root, profile }).artifacts);
  usePlugins(root, SERDE_PLUGIN);
  return root;
}

/** The nest-plugin test project (a payment model and controller, the controllers plugin on) plus `files`; callers then call `generateModels`. */
function nestProject(t: TestContext, files: Readonly<Record<string, string>>): string {
  const root = createControllerFixture(t, {
    prefix: 'golem-rewrite-parity-',
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
        plugins: [{ transform: NEST_PLUGIN }],
      },
      include: ['src/**/*.ts'],
    },
    files: {
      'src/payment.model.ts': readFixture(`${NEST}/project/payment.model.ts`),
      'src/payments.controller.ts': readFixture(`${NEST}/project/payments.controller.ts`),
      'golem.yaml': 'version: 1\nmodels: { root: . }\n',
      ...files,
    },
  });
  return root;
}

function generateModels(root: string): void {
  writeGeneratedArtifacts(generate({ root, profile: PROFILE }).artifacts);
}

// The two emits

type Emit = ReadonlyMap<string, string>;

function emitted(root: string): Emit {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith('.js')) files.set(path.relative(path.join(root, 'build'), filename).split(path.sep).join('/'), fs.readFileSync(filename, 'utf8'));
    }
  };
  visit(path.join(root, 'build'));
  return files;
}

/** The project after golem's scan: every rewritten source applied into a copy that has no plugin and no build output. */
function rewrittenCopy(t: TestContext, root: string, result: ScanResult): string {
  writeRewriteIndex(root, result.index);
  const index = readRewriteIndex(root);
  assert.ok(index, 'the index was written');
  const copy = createFixtureProject(t, 'golem-rewrite-parity-copy-');
  fs.cpSync(root, copy, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !['build', '.golem'].includes(path.relative(root, source)),
  });
  editTsconfig(copy, (tsconfig) => { delete tsconfig.compilerOptions.plugins; });
  for (const relative of Object.keys(index.files)) {
    const output = applyRewrites(relative, fs.readFileSync(path.join(root, relative), 'utf8'), index);
    assert.ok(output, `${relative} has an index entry`);
    fs.writeFileSync(path.join(copy, relative), output.code);
  }
  return copy;
}

function scan(root: string, nest: boolean): ScanResult {
  return scanProjectRewrites({ root, configFile: path.join(root, 'tsconfig.json'), nest });
}

/** `import` statements go (golem adds its own, aliased; Go merges names into existing ones), `__golem_x` reads as `x`, and each line is trimmed. */
function normalise(code: string): string {
  return code
    .replace(/^[ \t]*import\s*(['"])[^'"]*\1[^\n;]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s[^'";]*?\sfrom\s*(['"])[^'"]*\1[^\n;]*;?[ \t]*$/gm, '')
    .replace(/__golem_/g, '')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    .split('\n').map((line) => line.trim()).filter((line) => line !== '').join('\n');
}

/**
 * `aliases` maps a local name Go keeps from a type-only `import { X as Local }` to `X`, the name golem imports it by.
 */
function assertSameEmit(go: Emit, golem: Emit, aliases: Readonly<Record<string, string>> = {}): void {
  assert.deepEqual([...golem.keys()].sort(), [...go.keys()].sort(), 'both emit the same files');
  const unaliased = (code: string): string => Object.entries(aliases).reduce((text, [local, exported]) => text.replace(new RegExp(`\\b${local}\\b`, 'g'), exported), code);
  for (const [file, code] of go) assert.equal(normalise(golem.get(file) ?? ''), unaliased(normalise(code)), `${file}: golem's rewrite differs from the Go plugin's`);
}

/**
 * Compile the project with ttsc (the Go plugin) and, from golem's scan, with plain tsc; both emits must match after
 * normalisation. `rewrites` guards against comparing two emits that carry no rewrite.
 */
async function assertParity(t: TestContext, root: string, nest: boolean, rewrites: RegExp, aliases?: Readonly<Record<string, string>>): Promise<{ go: Emit; golem: Emit; result: ScanResult }> {
  const result = scan(root, nest);
  assert.deepEqual(result.diagnostics, [], 'the scan finds no failing site');
  const copy = rewrittenCopy(t, root, result);
  await compileModelProjectWithTtsc(root, [], { env: ttscEnv });
  await command(copy, process.execPath, [TSC, '-p', path.join(copy, 'tsconfig.json'), '--noCheck']);
  const go = emitted(root);
  const golem = emitted(copy);
  assert.ok([...go.values()].some((code) => rewrites.test(code)), `the Go emit has a rewrite matching ${rewrites}`);
  assertSameEmit(go, golem, aliases);
  return { go, golem, result };
}

interface Located { readonly file: string; readonly line: number; readonly column: number; readonly message: string }

/** Every `file:line:column: message` line Go's plugin printed, in order. */
function goDiagnostics(output: string): Located[] {
  const found = [...output.matchAll(/^(?:\S+: )?(\S+?):(\d+):(\d+): (.+)$/gm)]
    .map((match) => ({ file: match[1]!, line: Number(match[2]), column: Number(match[3]), message: match[4]! }));
  assert.notEqual(found.length, 0, `ttsc printed located diagnostics:\n${output}`);
  return found;
}

async function ttscFailures(root: string): Promise<Located[]> {
  const result = await command(root, process.execPath, [ttsc, '-p', path.join(root, 'tsconfig.json')], { allowFailure: true, env: ttscEnv });
  assert.notEqual(result.code, 0);
  return goDiagnostics(`${result.stdout}\n${result.stderr}`);
}

/**
 * The scan's errors against Go's: the same places in the same order, and the same messages once the wording the two do
 * not share ("hashed") is removed. `codes` are golem's codes for the sites, which Go does not number.
 */
function assertSameDiagnostics(go: readonly Located[], result: ScanResult, codes: readonly string[]): void {
  const meaning = (message: string): string => message.replace(/\bhashed /g, '');
  assert.deepEqual(
    result.diagnostics.map(({ code, file, line, column, message }) => ({ code, file, line, column, message: meaning(message) })),
    go.map(({ file, line, column, message }, index) => ({ code: codes[index], file, line, column, message: meaning(message) })),
  );
}

// serde-ttsc-plugin.test.ts

test('parity: serde calls in one project', async (t) => {
  const root = serdeProject(t, 'serde-fixture');
  write(root, 'src/use-stringify.ts', readFixture('models/serde/ttsc-plugin-rewrites-stringify-tmoney-to-the-generated-codec/use-stringify.ts'));
  write(root, 'src/use-parse-class.ts', readFixture('models/serde/ttsc-plugin-rewrites-parse-payment-to-construct-the-handwritten-class/use-parse-class.ts'));
  write(root, 'src/use-from-wire.ts', readFixture('models/serde/ttsc-plugin-does-not-rewrite-validation-validate-between-fromwireformat-t-ca/use-from-wire.ts'));
  write(root, 'src/use-comment.ts', readFixture('models/serde/ttsc-plugin-ignores-a-comment-and-string-that-look-like-serde-calls/use-comment.ts'));
  write(root, 'src/ns.ts', 'export class Thing { readonly kind = "thing"; }\n');
  write(root, 'src/use-heritage.ts', `import { parse, stringify } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import * as ns from './ns.js';
import { Payment, type TMoney } from './money.model.js';
function Mixin<T extends new (...args: any[]) => object>(Target: T) { return class extends Target { readonly mixed = true; }; }
class Base {}
export class A extends Error {}
export class B extends ns.Thing {}
export class C extends Mixin(Base) {}
export class D extends LibError {}
export const errorName = new A('x') instanceof Error;
export const kind = new B().kind;
export const mixed = new C().mixed;
export const libError = new D(LibErrorKind.Validation, 'bad') instanceof LibError;
export const text = stringify<TMoney>({ currency: 'USD', value: '1' });
export const payment = parse<Payment>('{"id":"p","amount":{"currency":"USD","value":"1"},"note":"n"}');
export const isPayment = payment instanceof Payment;
`);
  write(root, 'src/use-type-only.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { TPayment } from './money.model.js';
export function run(): unknown { return parse<TPayment>('{"id":"p","amount":{"currency":"USD","value":"1"},"note":"n"}'); }
`);
  write(root, 'src/use-multiline.ts', readFixture('models/serde/ttsc-plugin-rewrites-a-serde-call-whose-type-argument-is-split-across-lines/use-multiline.ts'));
  write(root, 'src/use-qualified.ts', readFixture('models/serde/ttsc-plugin-rewrites-a-qualified-type-argument-that-resolves-to-one-model/use-qualified.ts'));
  write(root, 'src/use-unrelated-parse.ts', readFixture('models/serde/ttsc-plugin-leaves-an-earlier-unrelated-parse-call-in-the-emitted-javascript/use-unrelated-parse.ts'));
  await assertParity(t, root, false, /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
});

test('parity: a class named apart from its alias links to its model through extends', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-parity-', name: 'serde-class-link', linkTypescript: true, linkTtsc: true });
  const fixtureDirectory = 'models/serde/a-class-named-apart-from-its-alias-registers-and-parses';
  copyFixtureFile(root, `${fixtureDirectory}/order.model.ts`, 'src/order.model.ts');
  copyFixtureFile(root, `${fixtureDirectory}/use-order.ts`, 'src/use-order.ts');
  writeGeneratedArtifacts(generate({ root, profile: PROFILE }).artifacts);
  usePlugins(root, SERDE_PLUGIN);
  await assertParity(t, root, false, /registerIModelClass\("TOrder_[0-9a-f]{8}", PurchaseOrder\)/);
});

test('parity: every class that extends a generated base registers under its own key', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-parity-', name: 'serde-class-link-many', linkTypescript: true, linkTtsc: true });
  const directory = 'models/serde/two-classes-link-to-one-model';
  copyFixtureFile(root, `${directory}/payment.model.ts`, 'src/payment.model.ts');
  copyFixtureFile(root, `${directory}/use-payment.ts`, 'src/use-payment.ts');
  writeGeneratedArtifacts(generate({ root, profile: PROFILE }).artifacts);
  usePlugins(root, SERDE_PLUGIN);
  await assertParity(t, root, false, /registerIModelClass\("TPayment_[0-9a-f]{8}#AdminPayment", AdminPayment\)/);
});

test('parity: OpenAPI codecs through SDK facades, and class names with the Model suffix', async (t) => {
  const root = serdeProject(t, 'serde-sdk', { mobx: false, validation: false });
  const writeGeneratedSdk = (sdkName: string, property: string, type: 'number' | 'string'): void => {
    writeGeneratedArtifacts(writeSdk({
      openapi: '3.1.0',
      info: { title: sdkName, version: '1' },
      components: { schemas: { Money: { type: 'object', required: [property], properties: { [property]: { type } } } } },
    }, { output: path.join(root, sdkName), name: sdkName, profile: { mobx: false, validation: false } }).artifacts);
  };
  writeGeneratedSdk('sdk-first', 'cents', 'number');
  writeGeneratedSdk('sdk-second', 'code', 'string');
  const object = (property: string, type: string) => ({ type: 'object', required: [property], properties: { [property]: { type } } });
  writeGeneratedArtifacts(writeSdk({
    openapi: '3.1.0',
    info: { title: 'Suffixed', version: '1' },
    components: {
      schemas: {
        PaymentModel: object('id', 'string'),
        TPayment: object('amount', 'number'),
        'Pay$ment': object('flag', 'boolean'),
        Money: object('units', 'integer'),
      },
    },
  }, { output: path.join(root, 'sdk'), name: 'Suffixed', profile: { mobx: false, validation: false } }).artifacts);
  editTsconfig(root, (tsconfig) => {
    tsconfig.compilerOptions.rootDir = '.';
    tsconfig.include = ['src/**/*.ts', 'sdk-first/**/*.ts', 'sdk-second/**/*.ts', 'sdk/**/*.ts'];
  });
  write(root, 'src/use-openapi-codecs.ts', readFixture('models/serde/ttsc-plugin-resolves-openapi-codecs-through-modular-sdk-facades-without-cros/use-openapi-codecs.ts'));
  write(root, 'src/use-suffixed.ts', `import { fromWireFormat, parse, stringify } from '@exprtlabs/golem/serde';
import type { MoneyModel, PaymentModelModel, Pay$mentModel, TPaymentModel } from '../sdk/index.js';
export const payment = fromWireFormat<PaymentModelModel>({ id: 'a' });
export const tpayment = fromWireFormat<TPaymentModel>({ amount: 3 });
export const dollar = fromWireFormat<Pay$mentModel>({ flag: true });
export const money = fromWireFormat<MoneyModel>({ units: 5 });
export const texts = [stringify<PaymentModelModel>(payment), stringify<TPaymentModel>(tpayment), stringify<Pay$mentModel>(dollar), stringify<MoneyModel>(money)];
export const parsed = [parse<PaymentModelModel>(texts[0]!), parse<TPaymentModel>(texts[1]!), parse<Pay$mentModel>(texts[2]!), parse<MoneyModel>(texts[3]!)];
`);
  await assertParity(t, root, false, /construct: SecondSdk\.MoneyModel/, { FirstMoneyModel: 'MoneyModel' });
});

test('parity: an unsupported serde type argument fails at the same source span', async (t) => {
  const root = serdeProject(t, 'serde-unsupported');
  write(root, 'src/use-unsupported.ts', readFixture('models/serde/ttsc-plugin-reports-a-source-span-for-an-unsupported-serde-type-argument/use-unsupported.ts'));
  assertSameDiagnostics(await ttscFailures(root), scan(root, false), ['RUNM1066']);
});

// tests/fixtures/rewrite: the projects rewrite-scan.test.ts scans

test('parity: the scan fixtures with hand-written key tables', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-parity-', name: 'rewrite-fixtures', linkTypescript: true, linkTtsc: true });
  for (const file of [
    'payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts', 'calls.ts', 'import-forms.ts', 'index.ts', 'write.ts', 'not-serde.ts',
    'construct.ts', 'type-only.ts', 'ledger.model.ts', 'ledger.model.generated.ts', 'registered.model.ts', 'registered.model.generated.ts',
    'rewritten.model.ts', 'rewritten.model.generated.ts', 'paren-type-argument.ts', 'type-argument-forms.ts',
  ]) copyFixtureFile(root, `rewrite/${file}`, `src/${file}`);
  usePlugins(root, SERDE_PLUGIN);
  await assertParity(t, root, false, /requireObjectCodec\("TMoney_11111111"\)\.stringify\(/, { Book: 'Ledger' });
});

test('parity: every unsupported or unkeyed serde call of the scan fixtures fails at the same source span', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-parity-', name: 'rewrite-bad-arguments', linkTypescript: true, linkTtsc: true });
  for (const file of ['payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts', 'bad-arguments.ts']) copyFixtureFile(root, `rewrite/${file}`, `src/${file}`);
  usePlugins(root, SERDE_PLUGIN);
  assertSameDiagnostics(await ttscFailures(root), scan(root, false), ['RUNM1066', 'RUNM1066', 'RUNM1066', 'RUNM1067', 'RUNM1067']);
});

// Where the port deliberately differs from Go. Each case holds Go's result as the evidence and golem's as the decision.

/** `files` under `src/`, a serde plugin project; returns Go's emit. */
async function goEmit(t: TestContext, files: Readonly<Record<string, string>>): Promise<{ root: string; go: Emit }> {
  const { root } = createModelProject(t, { prefix: 'golem-rewrite-parity-', name: 'rewrite-ruled', linkTypescript: true, linkTtsc: true });
  for (const [relative, text] of Object.entries(files)) write(root, `src/${relative}`, text);
  usePlugins(root, SERDE_PLUGIN);
  await compileModelProjectWithTtsc(root, [], { env: ttscEnv });
  return { root, go: emitted(root) };
}

test('two key tables that give one declaration different ids: Go takes one of them without saying so, golem fails the call', async (t) => {
  const table = (id: string): string => `export const IOBJECT_PLUGIN_KEYS = { "a/x.model.ts#TX": "${id}" } as const;\n`;
  const { root, go } = await goEmit(t, {
    'iobject-plugin-keys.ts': table('TX_aaaaaaaa'),
    'b/iobject-plugin-keys.ts': table('TX_bbbbbbbb'),
    'a/x.model.ts': 'export type TX = { id: string };\n',
    'use.ts': "import { parse } from '@exprtlabs/golem/serde';\nimport type { TX } from './a/x.model.js';\nexport const v = parse<TX>('{}');\n",
  });
  assert.match(go.get('use.js') ?? '', /requireObjectCodec\("TX_[ab]{8}"\)\.parse\(/, 'Go binds the call to one of the two ids without saying which');
  const { diagnostics, index } = scan(root, false);
  assert.deepEqual(diagnostics.map(({ code, file, line, column }) => ({ code, file, line, column })), [{ code: 'RUNM1067', file: 'src/use.ts', line: 3, column: 18 }]);
  assert.deepEqual(Object.keys(index.files), []);
});

test('a class whose own file has no key: Go registers it under the id of a same-named declaration in another file, golem does not register it', async (t) => {
  const { root, go } = await goEmit(t, {
    'iobject-plugin-keys.ts': 'export const IOBJECT_PLUGIN_KEYS = { "b.model.ts#Foo": "TFoo_bbbbbbbb", "b.model.ts#TFoo": "TFoo_bbbbbbbb" } as const;\n',
    'b.model.ts': 'export type TFoo = { id: string };\nexport const Foo = 1;\n',
    'a.model.generated.ts': 'export abstract class TFooBaseModel {}\n',
    'a.model.ts': "import { TFooBaseModel } from './a.model.generated.js';\nimport * as b from './b.model.js';\nexport class Foo extends TFooBaseModel {}\nexport const other = b.Foo;\n",
  });
  assert.match(go.get('a.model.js') ?? '', /registerIModelClass\("TFoo_bbbbbbbb", Foo\)/);
  const { diagnostics, index } = scan(root, false);
  assert.deepEqual(diagnostics, []);
  assert.equal(index.files['src/a.model.ts'], undefined);
});

// ttsc-plugin-diagnostics.test.ts

async function ttscTypeErrors(root: string): Promise<string> {
  const result = await command(root, process.execPath, [ttsc, '-p', path.join(root, 'tsconfig.json'), '--noEmit'], { allowFailure: true, env: ttscEnv });
  return `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
}

test('parity: a clean project compiles to the same output and a type error is reported at the same place', async (t) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-rewrite-parity-', linkTypescript: true, linkTtsc: true, ttscPlugin: true });
  fs.writeFileSync(path.join(sourceRoot, 'clean.ts'), 'export const clean: string = "ok";\n');
  const copy = rewrittenCopy(t, root, scan(root, false));
  await compileModelProjectWithTtsc(root, [], { env: ttscEnv });
  await command(copy, process.execPath, [TSC, '-p', path.join(copy, 'tsconfig.json')]);
  assertSameEmit(emitted(root), emitted(copy));

  // The rewrite is not a type-check step: the plain compiler on the unrewritten source is what reports.
  fs.writeFileSync(path.join(sourceRoot, 'broken.ts'), 'export const ok = 1;\nconst wrong: string = 5;\nexport { wrong };\n');
  const go = await ttscTypeErrors(root);
  const plain = await command(root, process.execPath, [TSC, '-p', path.join(root, 'tsconfig.json'), '--pretty', 'false', '--noEmit'], { allowFailure: true });
  assert.notEqual(plain.code, 0);
  assert.match(go, /src\/broken\.ts:2:7\b[\s\S]*TS2322/);
  assert.match(plain.stdout, /src\/broken\.ts\(2,7\): error TS2322/);
});

// golem-ts-openapi/nest-plugin.test.ts

test('parity: the NestJS controller metadata', async (t) => {
  const root = nestProject(t, {});
  generateModels(root);
  await assertParity(t, root, true, /nestModelReturn\("TPayment_[0-9a-f]{8}", true\)/);
});

test('parity: qualified decorators, Array forms, a serde call next to nest parameters and decorators already written', async (t) => {
  const forms = `${NEST}/rewrite-covers-qualified-array-and-serde-forms`;
  const root = nestProject(t, {
    'src/namespaced.controller.ts': readFixture(`${forms}/namespaced.controller.ts`),
    'src/arrays.controller.ts': readFixture(`${forms}/arrays.controller.ts`),
    'src/mixed.controller.ts': readFixture(`${forms}/mixed.controller.ts`),
    'src/plain.controller.ts': readFixture(`${NEST}/rewrite-keeps-existing-codec-decorators/plain.controller.ts`),
  });
  generateModels(root);
  await assertParity(t, root, true, /nestModelCodec\("TPaymentFilter_[0-9a-f]{8}"\)/);
});

test('parity: two Payment contracts keep distinct hashed ids', async (t) => {
  const directory = `${NEST}/two-payment-contracts-keep-distinct-hashed-nestmodelcodec-ids`;
  const root = nestProject(t, {
    'src/billing/payment.model.ts': paymentModelSource({ field: 'amount', fieldType: 'number' }).text,
    'src/payout/payment.model.ts': paymentModelSource({ field: 'destination', fieldType: 'string' }).text,
    'src/billing.controller.ts': readFixture(`${directory}/billing.controller.ts`),
    'src/payout.controller.ts': readFixture(`${directory}/payout.controller.ts`),
  });
  generateModels(root);
  await assertParity(t, root, true, /nestModelCodec\("TPayment_[0-9a-f]{8}"\)/);
});

test('parity: a table-known @Body() that cannot bind to one id fails at the same source span', async (t) => {
  const root = nestProject(t, {
    'src/billing/payment.model.ts': paymentModelSource({ field: 'amount', fieldType: 'number' }).text,
    'src/payout/payment.model.ts': paymentModelSource({ field: 'destination', fieldType: 'string' }).text,
    'src/notes.controller.ts': readFixture(`${NEST}/ttsc-fails-when-a-table-known-body-payment-cannot-bind-to-one-hashed-id/notes.controller.ts`),
  });
  generateModels(root);
  assertSameDiagnostics(await ttscFailures(root), scan(root, true), ['RUNM1071']);
});

test('parity: a primitive @Body() compiles the same, and parse of a missing model fails at the same source span', async (t) => {
  const directory = `${NEST}/ttsc-compiles-a-primitive-body-and-fails-parse-of-a-missing-model`;
  const root = nestProject(t, { 'src/notes.controller.ts': readFixture(`${directory}/notes.controller.ts`) });
  generateModels(root);
  const { go } = await assertParity(t, root, true, /__param\(0, Body\(\)\)/);
  assert.doesNotMatch(go.get('notes.controller.js') ?? '', /nestModelCodec/);

  write(root, 'src/missing.ts', readFixture(`${directory}/missing.ts`));
  assertSameDiagnostics(await ttscFailures(root), scan(root, true), ['RUNM1067']);
});

test('parity: serde rewrites and nest metadata share one emit', async (t) => {
  const root = nestProject(t, { 'src/read.ts': readFixture(`${NEST}/project/read.ts`) });
  usePlugins(root, SERDE_PLUGIN, NEST_PLUGIN);
  generateModels(root);
  await assertParity(t, root, true, /requireObjectCodec\("TPaymentInput_[0-9a-f]{8}"\)\.parse\(/);
});
