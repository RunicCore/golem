import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject, compileModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';

function fixture(t: TestContext) {
  return createModelProject(t, { prefix: 'golem-class-value-', name: 'class-value', ttscPlugin: true, linkWorkspaceNodeModules: true });
}

const CODECS = `import type { Pattern } from '@exprtlabs/golem/tags';
import { Money } from './money.js';
export type Base64 = string & Pattern<'^[A-Za-z0-9+/]*={0,2}$'>;
export function encodeBytes(value: Uint8Array): Base64 { return Buffer.from(value).toString('base64'); }
export function decodeBytes(value: Base64): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')); }
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
  await compileModelProject(root);
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
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as { parseA: (text: string) => unknown };
  assert.throws(() => codecs.parseA('{"bytes":"***"}'));
  assert.doesNotThrow(() => codecs.parseA('{"bytes":"AQID"}'));
});

test('generated model type names the class', async t => {
  const { result } = await build(t, tsSource`price: Price; when: When; bytes: Bytes`);
  const generated = result.artifacts.find(a => a.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /import type \{ Money \} from "\.\/money\.js"/);
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
  await compileModelProject(root);
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
    prefix: 'golem-class-value-pkg-', name: 'class-value-pkg', ttscPlugin: true, linkTypescript: true, linkTtsc: true,
    packages: { '@fixture/money': vendor, ajv: path.join(workspace, 'node_modules/ajv'), 'ajv-formats': path.join(workspace, 'node_modules/ajv-formats') },
  });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { type Money, encodeMoney, decodeMoney } from '@fixture/money';
type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;`, fields: tsSource`price: Price` }).text);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  const generated = result.artifacts.find(a => a.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /import type \{ Money \} from "@fixture\/money"/);
  assert.doesNotMatch(generated, /import type \{ Price \}/);
});

test('class field without TSerde is still rejected', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', fields: tsSource`bytes: Uint8Array` }).text);
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1004/);
});
