import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject, buildModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';

function fixture(t: TestContext) {
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
export function encodeBig(value: bigint): string { return value.toString(); }
export function decodeBig(value: string): bigint { return BigInt(value); }
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

async function build(t: TestContext, fields: SourceFragment) {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), CODECS);
  fs.writeFileSync(path.join(sourceRoot, 'money.ts'), MONEY);
  fs.writeFileSync(path.join(sourceRoot, 'temporal.d.ts'), TEMPORAL_D_TS);
  fs.writeFileSync(path.join(sourceRoot, 'temporal-runtime.js'), TEMPORAL_RUNTIME);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import type { Money } from './money.js';
import { encodeBytes, decodeBytes, encodeMoney, decodeMoney, encodeInstant, decodeInstant, encodeBig, decodeBig } from './codecs.js';
type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;
type When = Temporal.Instant & TSerde<typeof encodeInstant, typeof decodeInstant>;
type Big = bigint & TSerde<typeof encodeBig, typeof decodeBig>;`, fields }).text);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'temporal-runtime.js'), path.join(root, 'build/temporal-runtime.js'));
  await import(path.toNamespacedPath(path.join(root, 'build/temporal-runtime.js')));
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  return { A, result, root };
}

test('class-valued TSerde fields round-trip', async t => {
  const { A } = await build(t, tsSource`bytes: Bytes; price: Price; when: When; list: Bytes[]; maybe: Bytes | null`);
  const wire = { bytes: 'AQID', price: '12.34', when: '2025-01-02T03:04:05.000Z', list: ['AQ=='], maybe: null };
  const model = decodeGeneratedModel(A, wire);
  assert.ok(model.bytes instanceof Uint8Array);
  assert.equal(model.price.cents, 1234n);
  assert.equal(model.when.epochMilliseconds, Date.parse(wire.when));
  assert.deepEqual(encodeGeneratedModel(model), wire);
});

test('bigint TSerde fields round-trip: plain, array, nullable and optional', async t => {
  const { A } = await build(t, tsSource`big: Big; bigs: Big[]; maybeBig: Big | null; optBig?: Big`);
  const wire = { big: '9007199254740993', bigs: ['1', '-2'], maybeBig: null };
  const model = decodeGeneratedModel(A, wire);
  assert.equal(model.big, 9007199254740993n);
  assert.deepEqual(model.bigs, [1n, -2n]);
  assert.deepEqual(encodeGeneratedModel(model), wire);
  assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(A, { ...wire, maybeBig: '3', optBig: '4' })), { ...wire, maybeBig: '3', optBig: '4' });
});

test('optional class-value field', async t => {
  const { A } = await build(t, tsSource`bytes?: Bytes`);
  assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(A, {})), {});
  assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(A, { bytes: 'AQID' })), { bytes: 'AQID' });
});

test('invalid wire value is rejected before decoding', async t => {
  const { root } = await build(t, tsSource`bytes: Bytes`);
  // parse<Model> runs JSON validation by default; decodeGeneratedModel does not validate.
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as { parseTA: (text: string) => unknown };
  assert.throws(() => codecs.parseTA('{"bytes":"***"}'));
  assert.doesNotThrow(() => codecs.parseTA('{"bytes":"AQID"}'));
});

test('generated model type names the class', async t => {
  const { result } = await build(t, tsSource`price: Price; when: When; bytes: Bytes`);
  const generated = result.artifacts.find(a => a.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /import type \{ Money as __golemClass\d+ \} from "\.\/money\.js"/);
  assert.match(generated, /Temporal\.Instant/);
  assert.match(generated, /Uint8Array/);
});

test('class-value field under the MobX profile', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), CODECS);
  fs.writeFileSync(path.join(sourceRoot, 'money.ts'), MONEY);
  fs.writeFileSync(path.join(sourceRoot, 'temporal.d.ts'), TEMPORAL_D_TS);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { encodeBytes, decodeBytes } from './codecs.js';
type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;`, fields: tsSource`bytes: Bytes` }).text);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: true, validation: true } }).artifacts);
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const model = decodeGeneratedModel(A, { bytes: 'AQID' });
  assert.ok(model.bytes instanceof Uint8Array, 'MobX must hold the instance by reference, not wrap it');
  assert.deepEqual(encodeGeneratedModel(model), { bytes: 'AQID' });
});

test('class from an installed package is imported by package specifier', async t => {
  const vendor = fs.mkdtempSync(path.join(fs.realpathSync(import.meta.dirname), '.vendor-'));
  t.after(() => fs.rmSync(vendor, { recursive: true, force: true }));
  writeCodecPackage(vendor, { name: '@fixture/money', exports: { '.': './src/index.ts' }, files: {
    'src/index.ts': `${MONEY}export function encodeMoney(value: Money): string { return value.toString(); }
export function decodeMoney(value: string): Money { return Money.parse(value); }
`,
  } });
  const workspace = path.resolve(import.meta.dirname, '../..');
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-class-value-pkg-', name: 'class-value-pkg', linkTypescript: true,
    packages: { '@fixture/money': vendor, ajv: path.join(workspace, 'node_modules/ajv'), 'ajv-formats': path.join(workspace, 'node_modules/ajv-formats') },
  });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { type Money, encodeMoney, decodeMoney } from '@fixture/money';
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;`, fields: tsSource`price: Price` }).text);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  const generated = result.artifacts.find(a => a.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /import type \{ Money as __golemClass\d+ \} from "@fixture\/money"/);
  assert.doesNotMatch(generated, /import type \{ Price \}/);
});

test('class field without TSerde is still rejected', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', fields: tsSource`bytes: Uint8Array` }).text);
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1004/);
});

test('class-value output does not depend on the checkout directory', t => {
  const outputs = [0, 1].map(() => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), CODECS);
    fs.writeFileSync(path.join(sourceRoot, 'money.ts'), MONEY);
    fs.writeFileSync(path.join(sourceRoot, 'temporal.d.ts'), TEMPORAL_D_TS);
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
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const generated = result.artifacts.find(a => a.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /import type \{ Cash as __golemClass\d+ \} from "\.\/first\/money\.js"/);
  assert.match(generated, /import type \{ default as __golemClass\d+ \} from "\.\/second\/money\.js"/);
  assert.match(generated, /import type \{ Money as __golemClass\d+ \} from "\.\/third\.js"/);
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const wire = { first: 'a', second: 'b', third: 'c' };
  assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(A, wire)), wire);
});
