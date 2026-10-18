import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { buildModelProject, generatedModelFiles, writeModelGolemYaml } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';

test('validation false retains Date and serde conversions without a validator registry', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-tags/validation-false-retains-date-and-serde-conversions-without-a-validator-regi/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { encode, decode } from './codecs.js';`,
    fields: tsSource`when?: Date; token: number & TSerde<typeof encode, typeof decode>`,
  }).text);
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = generatedModelFiles(root).find((artifact) => artifact.path.endsWith('/a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /__golemSerialize0Source/);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/codecs.js')));
  const model = decodeGeneratedModel(A, { token: '4' });
  assert.equal(model.when, undefined);
  assert.deepEqual(encodeGeneratedModel(model), { token: '4' });
  assert.equal(codecs.deserialized, 1);
  assert.equal(codecs.serialized, 1);
  const dated = decodeGeneratedModel(A, { when: '2025-01-02T03:04:05.000Z', token: '5' });
  assert.ok(dated.when instanceof Date);
  assert.deepEqual(encodeGeneratedModel(dated), { when: '2025-01-02T03:04:05.000Z', token: '5' });
});

test('serde wire descriptors validate nested constraints before decode and after encode', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-tags/serde-wire-descriptors-validate-nested-constraints-before-decode-and-after-e/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde, MinLength } from '@exprtlabs/golem/tags';\nimport { encode, decode } from './codecs.js';`,
    fields: tsSource`value: number & TSerde<typeof encode, typeof decode>`,
  }).text);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codecs = await import(path.toNamespacedPath(path.join(root, 'build/codecs.js')));
  assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).parse( JSON.stringify({ value: { code: 'x' } })));
  assert.equal(codecs.decodeCalls, 0, 'invalid wire input is rejected before decode');
  assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TA')).assert( encodeGeneratedModel(new A({ value: 7 }))));
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
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
      () => generate({ root, profile: { mobx: false, validation: true } }),
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
    () => generate({ root, profile: { mobx: false, validation: false } }),
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const shared = generatedModelFiles(root).map((artifact) => artifact.content).join('\n');
  assert.match(shared, /minLength/);
  assert.match(shared, /exprtValidation/);
  assert.match(shared, /__golemSerialize0Source/);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const bindings = await import(path.toNamespacedPath(path.join(root, 'build/bindings.js')));
  const invalid = decodeGeneratedModel(A, { payload: { value: 'x', when: '2025-01-02T03:04:05.000Z' } });
  assert.equal(await getValidator(invalid).validate(), false);
  assert.equal(bindings.predicateCalls, 0, 'builtin minLength failure suppresses the predicate');
  assert.equal(bindings.deserialized, 1, 'nested serde deserializes once');
  const valid = decodeGeneratedModel(A, { payload: { value: 'good', when: '2025-01-02T03:04:05.000Z' } });
  assert.equal(await getValidator(valid).validate(), true);
  assert.equal(bindings.predicateCalls, 1, 'the aliased predicate runs once after builtins pass');
  assert.equal(bindings.serialized, 0, 'model-plane validate does not encode TSerde values');
  assert.deepEqual(encodeGeneratedModel(valid), { payload: { value: 'good', when: '2025-01-02T03:04:05.000Z' } });
  assert.equal(bindings.serialized, 1, 'an explicit serialize call serializes once for that call');
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const a = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js')));
  const b = await import(path.toNamespacedPath(path.join(root, 'build/b.model.generated.js')));

  assert.deepEqual(a.parseTA('{"token":"4","other":{"copy":{"token":"5"}}}'), { token: 4, other: { copy: { token: 5 } } });
  assert.deepEqual(JSON.parse(a.stringifyTA({ token: 4, other: { copy: { token: 5 } } })), { token: '4', other: { copy: { token: '5' } } });
  assert.deepEqual(b.parseTB('{"back":{"token":"6"},"copy":{"token":"7"}}'), { back: { token: 6 }, copy: { token: 7 } });
  assert.deepEqual(JSON.parse(b.stringifyTB({ back: { token: 6 }, copy: { token: 7 } })), { back: { token: '6' }, copy: { token: '7' } });
});
