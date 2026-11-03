import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator } from '@exprtlabs/golem/validation';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { buildModelProjectWith, generatedModelFiles } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';
import { modelCodec } from './support/model-codec.js';

test('validation false retains Date and serde conversions without a validator registry', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-tags/validation-false-retains-date-and-serde-conversions-without-a-validator-regi/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { encode, decode } from './codecs.js';`,
    fields: tsSource`when?: Date; token: number & TSerde<typeof encode, typeof decode>`,
  }).text);
  await buildModelProjectWith(root, { validation: false });
  const generated = generatedModelFiles(root).find((artifact) => artifact.path.endsWith('/a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /__golemSerialize0Source/);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/codecs.js')));
  const model = modelCodec(A).fromWireFormat({ token: '4' }, { validate: false });
  assert.equal(model.when, undefined);
  assert.deepEqual(modelCodec(model).toWireFormat(model), { token: '4' });
  assert.equal(codecs.deserialized, 1);
  assert.equal(codecs.serialized, 1);
  const dated = modelCodec(A).fromWireFormat({ when: '2025-01-02T03:04:05.000Z', token: '5' }, { validate: false });
  assert.ok(dated.when instanceof Date);
  assert.deepEqual(modelCodec(dated).toWireFormat(dated), { when: '2025-01-02T03:04:05.000Z', token: '5' });
});

test('a TSerde deserializer whose parameter is unknown is rejected by default and allowed by allowAny', (t) => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), `export function encode(value: number): string { return String(value); }
export function decode(wire: unknown): number { return Number(wire); }
`);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { encode, decode } from './codecs.js';`,
    fields: tsSource`value: number & TSerde<typeof encode, typeof decode>`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1011.*contains unknown/);
  assert.doesNotThrow(() => generate({ root, profile: { validation: true, allowAny: true } }));
});

test('serde wire descriptors validate nested constraints before decode and after encode', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-tags/serde-wire-descriptors-validate-nested-constraints-before-decode-and-after-e/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde, MinLength } from '@exprtlabs/golem/tags';\nimport { encode, decode } from './codecs.js';`,
    fields: tsSource`value: number & TSerde<typeof encode, typeof decode>`,
  }).text);
  await buildModelProjectWith(root, { validation: true });
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/codecs.js')));
  assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).parse( JSON.stringify({ value: { code: 'x' } })));
  assert.equal(codecs.decodeCalls, 0, 'invalid wire input is rejected before decode');
  assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).assert( modelCodec(A).toWireFormat(new A({ value: 7 }))));
  assert.equal(codecs.encodeCalls, 1, 'invalid encoded wire output is checked after one encode');
});

test('serde wire predicates run on the wire plane', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-tags/serde-wire-predicates-run-on-the-wire-plane-with-generated-validators/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde, TValidation } from '@exprtlabs/golem/tags';\nimport { encode, decode, positive } from './codecs.js';`,
    fields: tsSource`value: number & TValidation<typeof positive> & TSerde<typeof encode, typeof decode>`,
  }).text);
  await buildModelProjectWith(root, { validation: true });
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/codecs.js')));

  const parsed = requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).parse( JSON.stringify({ value: '0a' })) as { value: number };
  assert.equal(codecs.wireCalls, 1, 'validates the explicit wire predicate before decode');
  assert.equal(codecs.decodeCalls, 1, 'type-only parse fills through deserialize');
  assert.equal(parsed.value, 10);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(codecs.modelCalls, 1, 'parse runs the model predicate once after decoding, with or without a class');
  const model = new A(parsed);
  assert.equal(Reflect.get(model, 'value'), 10);
  assert.equal(await getValidator(model).validate(), true);
  assert.equal(codecs.modelCalls, 2, 'the class validator runs the model predicate');
  assert.equal(codecs.encodeCalls, 0, 'public validate stays on the model plane and does not encode');

  const wireBeforeStringify = codecs.wireCalls;
  requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).stringify(model);
  assert.equal(codecs.wireCalls, wireBeforeStringify + 1, 'stringify validates the encoded wire value');
  assert.equal(codecs.encodeCalls, 1, 'stringify serializes through TSerde');
  assert.equal(codecs.modelCalls, 3, 'stringify checks the model plane before encoding');

  const wireBeforeInvalidParse = codecs.wireCalls;
  assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).parse( JSON.stringify({ value: 'zz' })));
  assert.equal(codecs.wireCalls, wireBeforeInvalidParse + 1);
  assert.equal(codecs.decodeCalls, 1, 'invalid wire data does not invoke the decoder');
  assert.equal(codecs.modelCalls, 3, 'invalid wire data does not invoke the model predicate');

  codecs.setInvalidEncoding(true);
  const wireBeforeInvalidEncode = codecs.wireCalls;
  assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).stringify(new A({ value: 10 })));
  assert.equal(codecs.modelCalls, 4, 'failed stringify still checks the model plane');
  assert.equal(codecs.encodeCalls, 2);
  assert.equal(codecs.wireCalls, wireBeforeInvalidEncode + 1);
});

test('rejects asynchronous, multi-parameter, and incompatible codec bindings', t => {
  const cases: readonly { readonly name: string; readonly bindings: SourceFragment; readonly field: SourceFragment; readonly error: RegExp }[] = [
    {
      name: 'async predicate',
      bindings: tsSource`export async function check(value: unknown): Promise<boolean> { return Boolean(value); }`,
      field: tsSource`value: string & TValidation<typeof bindings.check>`,
      error: /synchronous/,
    },
    {
      name: 'multi-parameter predicate',
      bindings: tsSource`export function check(value: unknown, other: string): boolean { return Boolean(value && other); }`,
      field: tsSource`value: string & TValidation<typeof bindings.check>`,
      error: /exactly one required parameter/,
    },
    {
      name: 'incompatible predicate parameter',
      bindings: tsSource`export function check(value: number): boolean { return value > 0; }`,
      field: tsSource`value: string & TValidation<typeof bindings.check>`,
      error: /Validation parameter is incompatible/,
    },
    {
      name: 'incompatible serialize parameter',
      bindings: tsSource`export function encode(value: string): string { return value; }
export function decode(value: string): number { return Number(value); }`,
      field: tsSource`value: number & TSerde<typeof bindings.encode, typeof bindings.decode>`,
      error: /serialize parameter is incompatible/,
    },
    {
      name: 'incompatible deserialize result',
      bindings: tsSource`export function encode(value: number): string { return String(value); }
export function decode(value: string): string { return value; }`,
      field: tsSource`value: number & TSerde<typeof bindings.encode, typeof bindings.decode>`,
      error: /deserialize result is incompatible/,
    },
    {
      name: 'incompatible Date serializer parameter',
      bindings: tsSource`export function encode(value: string): string { return value; }
export function decode(value: string): Date { return new Date(value); }`,
      field: tsSource`value: Date & TSerde<typeof bindings.encode, typeof bindings.decode>`,
      error: /serialize parameter is incompatible/,
    },
  ];
  for (const item of cases) {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'bindings.ts'), item.bindings.text);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
      name: 'A',
      fields: item.field,
      imports: tsSource`import type { TSerde, TValidation } from '@exprtlabs/golem/tags';
import * as bindings from './bindings.js';`,
    }).text);
    assert.throws(
      () => generate({ root, profile: { validation: true } }),
      item.error,
      item.name,
    );
  }
});

test('conflicting serde pairs are rejected during model analysis', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-tags/conflicting-serde-pairs-are-rejected-during-model-analysis/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { encodeA, decodeA, encodeB, decodeB } from './codecs.js';`,
    fields: tsSource`value: number & TSerde<typeof encodeA, typeof decodeA> & TSerde<typeof encodeB, typeof decodeB>`,
  }).text);
  assert.throws(
    () => generate({ root, profile: { validation: false } }),
    /Conflicting serde tags/,
  );
});

test('generic utility aliases retain nested constraints, predicates, and serde boundaries', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'bindings.ts'), readFixture("models/model-tags/generic-utility-aliases-retain-nested-constraints-predicates-and-serde-bound/bindings.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { MinLength, TSerde, TValidation } from '@exprtlabs/golem/tags';\nimport { encodeDate, decodeDate, valid } from './bindings.js';\ntype Tagged<T extends string> = T & MinLength<3> & TValidation<typeof valid>;\ntype Box<T> = { value: T };\ntype Payload = Partial<Pick<Box<Tagged<string>>, 'value'>> & { when: Date & TSerde<typeof encodeDate, typeof decodeDate> };`,
    fields: tsSource`payload: Payload`,
  }).text);
  await buildModelProjectWith(root, { validation: true });
  const shared = generatedModelFiles(root).map((artifact) => artifact.content).join('\n');
  assert.match(shared, /__golemSerialize0Source/);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const bindings = await import(path.toNamespacedPath(path.join(root, 'build/bindings.js')));
  const invalid = modelCodec(A).fromWireFormat({ payload: { value: 'x', when: '2025-01-02T03:04:05.000Z' } }, { validate: false });
  assert.equal(await getValidator(invalid).validate(), false);
  assert.equal(bindings.predicateCalls, 0, 'builtin minLength failure suppresses the predicate');
  assert.equal(bindings.deserialized, 1, 'nested serde deserializes once');
  const valid = modelCodec(A).fromWireFormat({ payload: { value: 'good', when: '2025-01-02T03:04:05.000Z' } }, { validate: false });
  assert.equal(await getValidator(valid).validate(), true);
  assert.equal(bindings.predicateCalls, 1, 'the aliased predicate runs once after builtins pass');
  assert.equal(bindings.serialized, 0, 'model-plane validate does not encode TSerde values');
  assert.deepEqual(modelCodec(valid).toWireFormat(valid), { payload: { value: 'good', when: '2025-01-02T03:04:05.000Z' } });
  assert.equal(bindings.serialized, 1, 'an explicit serialize call serializes once for that call');
  const boundary = (value: string) => modelCodec(A).fromWireFormat({ payload: { value, when: '2025-01-02T03:04:05.000Z' } }, { validate: false });
  assert.equal(await getValidator(boundary('abc')).validate(), true, 'a value of the minimum length passes');
  assert.equal(await getValidator(boundary('ab')).validate(), false, 'a value under the minimum length fails');
});

test('two model files that import each other round-trip a TSerde field, also when the other file picks it with Pick', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), `export function encode(value: number): string { return String(value); }
export function decode(value: string): number { return Number(value); }
`);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { TB } from './b.model.js';
import { encode, decode } from './codecs.js';
export type TA = IObject<{ token: number & TSerde<typeof encode, typeof decode>; other?: TB }>;
`.text);
  fs.writeFileSync(path.join(sourceRoot, 'b.model.ts'), tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TA } from './a.model.js';
export type TB = IObject<{ back?: TA; copy: Pick<TA, 'token'> }>;
`.text);
  await buildModelProjectWith(root, { validation: true });
  const a = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js')));
  const b = await import(path.toNamespacedPath(path.join(root, 'build/b.model.generated.js')));

  assert.deepEqual(a.parseTA('{"token":"4","other":{"copy":{"token":"5"}}}'), { token: 4, other: { copy: { token: 5 } } });
  assert.deepEqual(JSON.parse(a.stringifyTA({ token: 4, other: { copy: { token: 5 } } })), { token: '4', other: { copy: { token: '5' } } });
  assert.deepEqual(b.parseTB('{"back":{"token":"6"},"copy":{"token":"7"}}'), { back: { token: 6 }, copy: { token: 7 } });
  assert.deepEqual(JSON.parse(b.stringifyTB({ back: { token: 6 }, copy: { token: 7 } })), { back: { token: '6' }, copy: { token: '7' } });
});

// protects: a TSerde whose wire is a number or a boolean returned the wire value on decode and never ran its deserializer
for (const validation of [true, false]) {
  test(`a TSerde with a number or boolean wire runs its deserializer on decode with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), `export function toCents(value: number): number { return Math.round(value * 100); }
export function fromCents(wire: number): number { return wire / 100; }
export function toFlag(value: 'yes' | 'no'): boolean { return value === 'yes'; }
export function fromFlag(wire: boolean): 'yes' | 'no' { return wire ? 'yes' : 'no'; }
`);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { toCents, fromCents, toFlag, fromFlag } from './codecs.js';`,
      fields: tsSource`amount: number & TSerde<typeof toCents, typeof fromCents>; answer: ('yes' | 'no') & TSerde<typeof toFlag, typeof fromFlag>`,
    }).text);
    await buildModelProjectWith(root, { validation });
    const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
    const parsed = requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).parse('{"amount":500,"answer":true}') as { amount: number; answer: string };
    assert.deepEqual({ amount: parsed.amount, answer: parsed.answer }, { amount: 5, answer: 'yes' });
    const decoded = modelCodec(A).fromWireFormat({ amount: 250, answer: false }, { validate: false });
    assert.deepEqual({ amount: decoded.amount, answer: decoded.answer }, { amount: 2.5, answer: 'no' });
    assert.deepEqual(modelCodec(decoded).toWireFormat(decoded), { amount: 250, answer: false });
  });
}

for (const validation of [true, false]) {
  test(`toWireFormat runs a TSerde encoder once for a field two intersected objects share and only on the selected union branch (validation ${validation})`, async t => {
    // protects: T-650 the encoder of a shared serde field and of a tagged union runs only where the value needs it
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), `export let encodeCalls = 0;
export function encode(value: number): string { encodeCalls += 1; return 'token:' + String(value); }
export function decode(value: string): number { return Number(value.slice('token:'.length)); }
`);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
import { encode, decode } from './codecs.js';
type Token = number & TSerde<typeof encode, typeof decode>;
export type TBoth = IModel<{ token: Token; label: string } & { token: Token; at: Date }>;
export type TEither = IModel<{ value: ({ kind: 'one'; token: Token } | { kind: 'two'; other: Token }) & Discriminator<'kind'> }>;
`);
    await buildModelProjectWith(root, { validation });
    await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js')));
    const codecs = await import(path.toNamespacedPath(path.join(root, 'build/codecs.js')));
    const both = requireObjectCodec(generatedCodecIdFromRoot(root, 'TBoth'));
    const at = new Date('2025-01-02T03:04:05.000Z');
    assert.deepEqual(both.toWireFormat({ token: 7, label: 'x', at }), { token: 'token:7', label: 'x', at: '2025-01-02T03:04:05.000Z' });
    assert.equal(codecs.encodeCalls, 1, 'the shared serde field is encoded once');
    const either = requireObjectCodec(generatedCodecIdFromRoot(root, 'TEither'));
    assert.deepEqual(either.toWireFormat({ value: { kind: 'one', token: 11 } }), { value: { kind: 'one', token: 'token:11' } });
    assert.equal(codecs.encodeCalls, 2, 'the selected branch encodes its field once and the other branch encodes nothing');
  });
}
