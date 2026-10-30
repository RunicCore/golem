import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createModelProject, buildModelProject, writeModelGolemYaml } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';
import { fileFixtureScope, onceShared, writeGeneratedArtifacts, type FixtureScope } from './fixture-project.js';
import { command } from './support/process.js';
import { TSC } from './support/build-project.js';
import { modelCodec } from './support/model-codec.js';
import { validateInstance } from '@exprtlabs/golem/validation';
import { LibError } from '@exprtlabs/golem/errors';

function fixture(t: FixtureScope) {
  return createModelProject(t, { prefix: 'golem-class-value-', name: 'class-value', linkWorkspaceNodeModules: true });
}

const CODECS = `import type { Pattern } from '@exprtlabs/golem/tags';
import { Money } from './money.js';
export type Base64 = string & Pattern<'^[A-Za-z0-9+/]*={0,2}$'>;
export function encodeBytes(value: Uint8Array): Base64 { return btoa(String.fromCharCode(...value)) as Base64; }
export function decodeBytes(value: Base64): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
export function encodeMoney(value: Money): string { return value.toString(); }
export function decodeMoney(value: string): Money { return Money.parse(value); }
export function encodeInstant(value: Temporal.Instant): string { return value.toString(); }
export function decodeInstant(value: string): Temporal.Instant { return Temporal.Instant.from(value); }
export function encodeLink(value: URL): string { return value.href; }
export function decodeLink(value: string): URL { return new URL(value); }
export function encodeBig(value: bigint): string { return value.toString(); }
export function decodeBig(value: string): bigint { return BigInt(value); }
export function encodeCents(value: bigint): number { return Number(value); }
export function decodeCents(value: number): bigint { return BigInt(value); }
export function encodeFlag(value: bigint): boolean { return value !== 0n; }
export function decodeFlag(value: boolean): bigint { return value ? 1n : 0n; }
`;
const MONEY = `export class Money {
  constructor(readonly cents: bigint) {}
  static parse(text: string): Money { return new Money(BigInt(text.replace('.', ''))); }
  toString(): string { const s = this.cents.toString().padStart(3, '0'); return \`\${s.slice(0, -2)}.\${s.slice(-2)}\`; }
}
`;
// A minimal ambient Temporal, standing in for the global or a polyfill's declarations.
const TEMPORAL_D_TS = `declare namespace Temporal {
  class Instant { static from(text: string): Instant; readonly epochMilliseconds: number; toString(): string; }
}
`;
const TEMPORAL_RUNTIME = `globalThis.Temporal = { Instant: class Instant {
  static from(text) { const i = new Instant(); i.epochMilliseconds = Date.parse(text); return i; }
  toString() { return new Date(this.epochMilliseconds).toISOString(); }
} };
export {};
`;

/**
 * Type-checks `probe.ts`, which assigns each field type of the generated `TAFields` to the class it must name.
 * A field typed `unknown` or `string` fails the assignments, and the `@ts-expect-error` line fails when the field is not a class.
 */
async function assertFieldClasses(root: string, sourceRoot: string, imports: readonly string[], fields: Readonly<Record<string, string>>): Promise<void> {
  const lines = Object.entries(fields).map(([field, type]) => `export const ${field}: ${type} = null as unknown as TAFields['${field}'];`);
  const [firstField] = Object.keys(fields);
  fs.writeFileSync(path.join(sourceRoot, 'probe.ts'), [
    "import type { TAFields } from './a.model.generated.js';",
    ...imports,
    ...lines,
    '// @ts-expect-error the field is a class instance, not a string',
    `export const notString: string = null as unknown as TAFields['${firstField}'];`,
    '',
  ].join('\n'));
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--noEmit']);
}

/** The codec, class and Temporal declaration files that every class-value project holds. */
function writeClassSupport(sourceRoot: string): void {
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), CODECS);
  fs.writeFileSync(path.join(sourceRoot, 'money.ts'), MONEY);
  fs.writeFileSync(path.join(sourceRoot, 'temporal.d.ts'), TEMPORAL_D_TS);
}

async function build(t: FixtureScope, fields: SourceFragment) {
  const { root, sourceRoot } = fixture(t);
  writeClassSupport(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'temporal-runtime.js'), TEMPORAL_RUNTIME);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import type { Money } from './money.js';
import { encodeBytes, decodeBytes, encodeMoney, decodeMoney, encodeInstant, decodeInstant, encodeLink, decodeLink, encodeBig, decodeBig, encodeCents, decodeCents, encodeFlag, decodeFlag } from './codecs.js';
type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;
type When = Temporal.Instant & TSerde<typeof encodeInstant, typeof decodeInstant>;
type Link = URL & TSerde<typeof encodeLink, typeof decodeLink>;
type Big = bigint & TSerde<typeof encodeBig, typeof decodeBig>;
type Cents = bigint & TSerde<typeof encodeCents, typeof decodeCents>;
type Flag = bigint & TSerde<typeof encodeFlag, typeof decodeFlag>;`, fields }).text);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'temporal-runtime.js'), path.join(root, 'build/temporal-runtime.js'));
  await import(path.toNamespacedPath(path.join(root, 'build/temporal-runtime.js')));
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  return { A, generatedSource: fs.readFileSync(path.join(sourceRoot, 'a.model.generated.ts'), 'utf8'), root };
}

test('class-valued TSerde fields round-trip', async t => {
  const { A } = await build(t, tsSource`bytes: Bytes; price: Price; when: When; list: Bytes[]; maybe: Bytes | null`);
  const wire = { bytes: 'AQID', price: '12.34', when: '2025-01-02T03:04:05.000Z', list: ['AQ=='], maybe: null };
  const model = modelCodec(A).fromWireFormat(wire);
  assert.ok(model.bytes instanceof Uint8Array);
  assert.equal(model.price.cents, 1234n);
  assert.equal(model.when.epochMilliseconds, Date.parse(wire.when));
  assert.deepEqual(modelCodec(model).toWireFormat(model), wire);
});

test('bigint TSerde fields round-trip: plain, array, nullable and optional', async t => {
  const { A } = await build(t, tsSource`big: Big; bigs: Big[]; maybeBig: Big | null; optBig?: Big`);
  const wire = { big: '9007199254740993', bigs: ['1', '-2'], maybeBig: null };
  const model = modelCodec(A).fromWireFormat(wire);
  assert.equal(model.big, 9007199254740993n);
  assert.deepEqual(model.bigs, [1n, -2n]);
  assert.deepEqual(modelCodec(model).toWireFormat(model), wire);
  assert.deepEqual(modelCodec(A).toWireFormat(modelCodec(A).fromWireFormat({ ...wire, maybeBig: '3', optBig: '4' })), { ...wire, maybeBig: '3', optBig: '4' });
});

// A model over a mapped, conditional or Pick type: the bigint TSerde of `amount` comes through `Final['order']`.
for (const item of [
  { name: 'a mapped type', model: 'Final[\'order\']' },
  { name: 'a Pick over a mapped type', model: 'Pick<Final[\'order\'], \'id\' | \'amount\'>' },
] as const) {
  test(`bigint TSerde field of ${item.name} round-trips`, async t => {
    // protects: T-253 a model over a mapped type keeps the TSerde conversion of a field
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), `export function encodeBig(value: bigint): string { return value.toString(); }
export function decodeBig(value: string): bigint { return BigInt(value); }
`);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), `import type { IObject } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { encodeBig, decodeBig } from './codecs.js';
type Amount = bigint & TSerde<typeof encodeBig, typeof decodeBig>;
type Entities = { order: { id: string; amount: string }; user: { name: string } };
type DbOverrides = { order: { amount: Amount } };
type Column<T extends keyof Entities, C extends keyof Entities[T]> = T extends keyof DbOverrides
  ? C extends keyof DbOverrides[T] ? DbOverrides[T][C] : Entities[T][C]
  : Entities[T][C];
type Final = { [T in keyof Entities]: { [C in keyof Entities[T]]: Column<T, C> } };
export type TA = IObject<${item.model}>;
`);
    writeModelGolemYaml(root, { mobx: false, validation: true });
    await buildModelProject(root);
    const codecs = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as {
      parseTA: (text: string) => { amount: bigint };
      stringifyTA: (value: unknown) => string;
    };
    const text = '{"id":"o1","amount":"9007199254740993"}';
    const model = codecs.parseTA(text);
    assert.equal(model.amount, 9007199254740993n);
    assert.equal(codecs.stringifyTA(model), text);
  });
}

test('optional class-value field', async t => {
  const { A } = await build(t, tsSource`bytes?: Bytes`);
  assert.deepEqual(modelCodec(A).toWireFormat(modelCodec(A).fromWireFormat({})), {});
  assert.deepEqual(modelCodec(A).toWireFormat(modelCodec(A).fromWireFormat({ bytes: 'AQID' })), { bytes: 'AQID' });
});

test('invalid wire value is rejected before decoding', async t => {
  const { root } = await build(t, tsSource`bytes: Bytes`);
  // parse<Model> runs JSON validation by default; fromWireFormat with validate false does not validate.
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as { parseTA: (text: string) => unknown };
  assert.throws(() => codecs.parseTA('{"bytes":"***"}'));
  assert.doesNotThrow(() => codecs.parseTA('{"bytes":"AQID"}'));
});

// A user class, a global class, a Temporal class and a bigint, whose wires are a string, a number and a boolean, share one build.
const fileScope = fileFixtureScope();
const classFields = onceShared(() => build(fileScope, tsSource`price: Price; link: Link; when: When; cents: Cents; flag: Flag`));
const dateField = onceShared(() => build(fileScope, tsSource`at: Date`));
const CLASS_WIRE = { price: '12.34', link: 'https://example.com/', when: '2025-01-02T03:04:05.000Z', cents: 5, flag: true };
const isInputError = (message: RegExp) => (error: unknown): boolean => error instanceof LibError && error.causedByInput === true && message.test(error.message);

// A serde reads only the JSON type of its wire: any other wire value is bad input at every level of validation, off included.
for (const [field, wrong, message] of [
  ['price', 5, /Expected a string/],
  ['cents', '5', /Expected a number/],
  ['flag', 'yes', /Expected a boolean/],
] as const) {
  test(`${field}: a wire value of the wrong JSON type is rejected with validation off`, async () => {
    // protects: T-659 F-39 a TSerde reads only the JSON type of its wire (string, number or boolean), also when validation is off
    const { A } = await classFields();
    assert.doesNotThrow(() => modelCodec(A).fromWireFormat(CLASS_WIRE, { validate: false }));
    assert.throws(() => modelCodec(A).fromWireFormat({ ...CLASS_WIRE, [field]: wrong }, { validate: false }), isInputError(message));
  });
}

// A user class, a global class and a Temporal class share one model-plane check: the value is an instance of the class, or one `instance` issue names it.
for (const [field, name, wrong] of [['price', 'Money', new Map()], ['link', 'URL', 5], ['when', 'Temporal.Instant', 'text']] as const) {
  test(`${field}: validation accepts an instance of ${name} and rejects another value with one instance issue`, async () => {
    // protects: T-659 F-39 validate() rejects a value that is not an instance of the field's TSerde class
    const { A } = await classFields();
    assert.deepEqual(await validateInstance(modelCodec(A).fromWireFormat(CLASS_WIRE), { failFast: false }), []);
    const issues = await validateInstance(Object.assign(modelCodec(A).fromWireFormat(CLASS_WIRE), { [field]: wrong }), { failFast: false });
    assert.deepEqual(issues.map(issue => ({ path: issue.path, code: issue.code, model: (issue as { model?: string }).model })), [{ path: [field], code: 'instance', model: name }]);
  });
}

// A plain Date field has the same check, and a Date that holds no time (an invalid Date) is no value of the class.
for (const [name, wrong] of [['a string', '2025-01-02T03:04:05.000Z'], ['a number', 5], ['an invalid Date', new Date(Number.NaN)]] as const) {
  test(`at: validation rejects ${name} in a Date field with one instance issue at the field path`, async () => {
    // protects: T-725 F-39 validate() rejects a non-Date and an invalid Date in a Date field, though Date has no rule of its own
    const { A } = await dateField();
    const model = modelCodec(A).fromWireFormat({ at: '2025-01-02T03:04:05.000Z' });
    assert.deepEqual(await validateInstance(model, { failFast: false }), []);
    const issues = await validateInstance(Object.assign(model, { at: wrong }), { failFast: false });
    assert.deepEqual(issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message })), [{ path: ['at'], code: 'instance', message: 'Expected an instance of Date' }]);
  });
}

test('generated model type names the class', async t => {
  const { root } = await build(t, tsSource`price: Price; when: When; bytes: Bytes`);
  await assertFieldClasses(root, path.join(root, 'src'), ["import type { Money } from './money.js';"], { price: 'Money', when: 'Temporal.Instant', bytes: 'Uint8Array' });
});

test('class-value field under the MobX profile', async t => {
  const { root, sourceRoot } = fixture(t);
  writeClassSupport(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { encodeBytes, decodeBytes } from './codecs.js';
type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;`, fields: tsSource`bytes: Bytes` }).text);
  writeModelGolemYaml(root, { mobx: true, validation: true });
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const model = modelCodec(A).fromWireFormat({ bytes: 'AQID' });
  assert.ok(model.bytes instanceof Uint8Array, 'MobX must hold the instance by reference, not wrap it');
  assert.deepEqual(modelCodec(model).toWireFormat(model), { bytes: 'AQID' });
});

test('class from an installed package is imported by package specifier', async t => {
  const vendor = fs.mkdtempSync(path.join(fs.realpathSync(import.meta.dirname), '.vendor-'));
  t.after(() => fs.rmSync(vendor, { recursive: true, force: true }));
  writeCodecPackage(vendor, { name: '@fixture/money', exports: { '.': './src/index.ts' }, files: {
    'src/index.ts': `${MONEY}export function encodeMoney(value: Money): string { return value.toString(); }
export function decodeMoney(value: string): Money { return Money.parse(value); }
`,
  } });
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-class-value-pkg-', name: 'class-value-pkg', linkTypescript: true,
    packages: { '@fixture/money': vendor },
  });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { type Money, encodeMoney, decodeMoney } from '@fixture/money';
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;`, fields: tsSource`price: Price` }).text);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await assertFieldClasses(root, sourceRoot, ["import type { Money } from '@fixture/money';"], { price: 'Money' });
});

test('class field without TSerde is still rejected', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', fields: tsSource`bytes: Uint8Array` }).text);
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1004/);
});

test('class-value output does not depend on the checkout directory', t => {
  const outputs = [0, 1].map(() => {
    const { root, sourceRoot } = fixture(t);
    writeClassSupport(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import type { Money } from './money.js';
import { encodeMoney, decodeMoney } from './codecs.js';
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;`, fields: tsSource`price: Price` }).text);
    return generate({ root, profile: { mobx: false, validation: true } }).artifacts
      .map(artifact => [path.relative(root, artifact.path), artifact.content] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  });
  assert.deepEqual(outputs[1], outputs[0]);
});

const SHAPES = `export const anonymous = new (class { run(): void {} })();
export function encodeAnonymous(value: typeof anonymous): string { return String(value); }
export function decodeAnonymous(_value: string): typeof anonymous { return anonymous; }

class Hidden { run(): void {} }
export function makeHidden(): Hidden { return new Hidden(); }
export function encodeHidden(value: Hidden): string { return String(value); }
export function decodeHidden(_value: string): Hidden { return new Hidden(); }

export class Box<T> { constructor(readonly item: T) {} run(): void {} }
export function encodeBox(value: Box<string>): string { return value.item; }
export function decodeBox(value: string): Box<string> { return new Box(value); }
`;
const AMBIENT = `declare module 'legacy-money' { export class Legacy { run(): void; } }
`;
const LEGACY_CODECS = `import type { Legacy } from 'legacy-money';
export function encodeLegacy(_value: Legacy): string { return ''; }
export function decodeLegacy(_value: string): Legacy { throw new Error('unused'); }
`;
const SHAPES_IMPORTS = tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { anonymous, makeHidden, encodeAnonymous, decodeAnonymous, encodeHidden, decodeHidden, encodeBox, decodeBox, type Box } from './shapes.js';
import { encodeLegacy, decodeLegacy } from './legacy.js';
import type { Legacy } from 'legacy-money';
type Anonymous = typeof anonymous & TSerde<typeof encodeAnonymous, typeof decodeAnonymous>;
type Hidden = ReturnType<typeof makeHidden> & TSerde<typeof encodeHidden, typeof decodeHidden>;
type Boxed = Box<string> & TSerde<typeof encodeBox, typeof decodeBox>;
type Old = Legacy & TSerde<typeof encodeLegacy, typeof decodeLegacy>;`;

for (const item of [
  { name: 'an anonymous class', field: tsSource`value: Anonymous`, expected: /a\.model\.ts:\d+:\d+ RUNM1063: .*no name.*Name the class and export it/ },
  { name: 'a class that is not exported', field: tsSource`value: Hidden`, expected: /a\.model\.ts:\d+:\d+ RUNM1063: .*Class Hidden is not exported from .*shapes\.ts.*Export it/ },
  { name: 'a generic class', field: tsSource`value: Boxed`, expected: /a\.model\.ts:\d+:\d+ RUNM1063: .*Class Box has type parameters.*extends Box<string>/ },
  { name: 'a class declared in an ambient module of a script file', field: tsSource`value: Old`, expected: /a\.model\.ts:\d+:\d+ RUNM1063: .*Class Legacy is declared inside declare module "legacy-money".*Move it into a module file/ },
] as const) {
  test(`class-valued TSerde diagnostic: ${item.name}`, t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'shapes.ts'), SHAPES);
    fs.writeFileSync(path.join(sourceRoot, 'ambient.d.ts'), AMBIENT);
    fs.writeFileSync(path.join(sourceRoot, 'legacy.ts'), LEGACY_CODECS);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: SHAPES_IMPORTS, fields: item.field }).text);
    assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), error => { assert.match(String(error), item.expected); return true; });
  });
}

/** A module declaring `Money` with its codec, so one project can hold several classes of the same name. */
function moneyModule(options: { readonly exports: string; readonly prefix: string }): string {
  return `class Money { constructor(readonly text: string) {} run(): void {} }
export function encode${options.prefix}(value: Money): string { return value.text; }
export function decode${options.prefix}(value: string): Money { return new Money(value); }
${options.exports}
`;
}

test('class-valued TSerde fields import renamed and default exports and keep same-named classes apart', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.mkdirSync(path.join(sourceRoot, 'first'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'second'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'first/money.ts'), moneyModule({ prefix: 'First', exports: 'export { Money as Cash };' }));
  fs.writeFileSync(path.join(sourceRoot, 'second/money.ts'), moneyModule({ prefix: 'Second', exports: 'export default Money;' }));
  fs.writeFileSync(path.join(sourceRoot, 'third.ts'), `export class Money { constructor(readonly text: string) {} run(): void {} }
export function encodeThird(value: Money): string { return value.text; }
export function decodeThird(value: string): Money { return new Money(value); }
`);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import type { Cash } from './first/money.js';
import type SecondMoney from './second/money.js';
import type { Money as ThirdMoney } from './third.js';
import { encodeFirst, decodeFirst } from './first/money.js';
import { encodeSecond, decodeSecond } from './second/money.js';
import { encodeThird, decodeThird } from './third.js';
type First = Cash & TSerde<typeof encodeFirst, typeof decodeFirst>;
type Second = SecondMoney & TSerde<typeof encodeSecond, typeof decodeSecond>;
type Third = ThirdMoney & TSerde<typeof encodeThird, typeof decodeThird>;`, fields: tsSource`first: First; second: Second; third: Third` }).text);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  await assertFieldClasses(root, sourceRoot, [
    "import type { Cash } from './first/money.js';",
    "import type SecondMoney from './second/money.js';",
    "import type { Money as ThirdMoney } from './third.js';",
  ], { first: 'Cash', second: 'SecondMoney', third: 'ThirdMoney' });
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const wire = { first: 'a', second: 'b', third: 'c' };
  assert.deepEqual(modelCodec(A).toWireFormat(modelCodec(A).fromWireFormat(wire)), wire);
});
