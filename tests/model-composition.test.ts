import { fixturePath, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { compositionProject as fixture } from './support/model-composition-project.js';
import { buildModelProject, buildModelProjectWith, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { discardedProjectionCodecsSource, discardedProjectionMetadataSource } from './fixture-templates/models/model-composition.js';
import { generate } from '#model/generator';

test('an unrelated same-name class does not become a model constructor', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/an-unrelated-same-name-class-does-not-become-a-model-constructor/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
  const authored = await import(`${path.join(root, 'build/item.model.js')}?${Date.now()}`);
  const parent = new generated.TParentBaseModel({ child: { id: 'child' } });
  assert.ok(parent.child instanceof generated.TItemBaseModel);
  assert.equal(parent.child instanceof authored.Item, false);
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'child' } });
});

test('first generation resolves model class bases through project path aliases', async t => {
  const { root, sourceRoot } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', imports: { '#generated/*': './build/*.model.generated.js' } }));
  config.compilerOptions.paths = { '#generated/*': ['./src/*.model.generated.ts'] };
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/item.model.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'parent.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/parent.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/parent.model.generated.js')}?${Date.now()}`);
  const authored = await import(path.join(root, 'build/item.model.js'));
  const parent = new generated.TParentBaseModel({ child: { id: 'nested' } });
  assert.ok(parent.child instanceof authored.Item);
  assert.equal(parent.child.label, 'nested');
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'nested' } });
});


test('IModel exposes fields and rejects root unions before emitting artifacts', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'keys.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/keys.ts"));
  await buildModelProject(root);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/item.model.ts"));
  for (const validation of [true, false]) {
    assert.throws(() => generate({ root, profile: { mobx: false, validation } }), /RUNM1052.*The IModel fields type must be an object type, but TItem has a union/);
  }
  assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
});

// protects: T-425 a non-object IModel root stops with RUNM1052 (Date[] once generated an invalid file, string[] a false RUNM1004)
const nonObjectRoots = [
  { name: 'an array of dates with validation off', declaration: 'IModel', fields: 'Date[]', validation: false, found: 'an array' },
  { name: 'an array of strings with validation on', declaration: 'IModel', fields: 'string[]', validation: true, found: 'an array' },
  { name: 'an array in an IObject', declaration: 'IObject', fields: 'string[]', validation: true, found: 'an array' },
  { name: 'a tuple', declaration: 'IModel', fields: '[string, Date]', validation: true, found: 'a tuple' },
  { name: 'a scalar', declaration: 'IModel', fields: 'string', validation: true, found: 'a scalar' },
  { name: 'any', declaration: 'IModel', fields: 'any', validation: false, found: 'any' },
  { name: 'the object keyword', declaration: 'IModel', fields: 'object', validation: false, found: 'the object keyword' },
  { name: 'an object intersected with a scalar', declaration: 'IModel', fields: '{ a: string } & string', validation: false, found: 'an intersection with a scalar' },
] as const;
for (const { name, declaration, fields, validation, found } of nonObjectRoots) {
  test(`${declaration} with ${name} as its fields type stops with RUNM1052`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { ${declaration} } from '@exprtlabs/golem/model';\nexport type TItem = ${declaration}<${fields}>;\n`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      new RegExp(`RUNM1052: The ${declaration} fields type must be an object type, but TItem has ${found}\\.`),
    );
    assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
  });
}

// protects: T-425 an unresolved fields type keeps RUNM1058 (it once read as the unknown root of RUNM1052)
for (const validation of [true, false]) {
  test(`an IModel whose fields type does not resolve stops with RUNM1058 with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';\nimport type { Missing } from './missing.js';\nexport type TItem = IModel<Missing>;\n`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      /RUNM1058: The fields type of TItem could not be resolved\. Fix its declaration or import\./,
    );
  });
}

// protects: T-425 a whole-object TSerde root stops with RUNM1052 (it once wrote a file that did not compile); an SDK model's fields stay a valid root
test('an IModel over a type that a TSerde converts as a whole stops with RUNM1052', async t => {
  const { root, sourceRoot } = fixture(t);
  writeModelSources(sourceRoot, {
    'box.ts': `export class Box { constructor(public amount: number = 0) {} }
export function boxToJson(value: Box): string { return String(value.amount); }
export function boxFromJson(text: string): Box { return new Box(Number(text)); }
`,
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { Box, boxToJson, boxFromJson } from './box.js';
export type TItem = IModel<Box & TSerde<typeof boxToJson, typeof boxFromJson>>;
`,
  });
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1052: The IModel fields type must be an object type, but TItem has a type that a TSerde converts as a whole\./,
  );
});

/** Generate the `Payments` SDK with its `Money` model into `src/sdk`. */
async function writeMoneySdk(sourceRoot: string): Promise<void> {
  fs.copyFileSync(fixturePath('wire-format/sdk-money/money.yaml'), path.join(sourceRoot, 'money.yaml'));
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sourceRoot, 'money.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Payments',
    profile: { mobx: false, validation: true },
  })).artifacts);
}

test('an IModel over an SDK model generates a class with the fields of that model', async t => {
  // protects: an IModel over an SDK model types the generated class with that model's fields (a wrong field type fails the build)
  const { root, sourceRoot } = fixture(t);
  await writeMoneySdk(sourceRoot);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/index.js';
export type TItem = IModel<Money>;
`,
    'consumer.ts': `import { TItemBaseModel } from './item.model.generated.js';
declare const item: TItemBaseModel;
export const amount: number = item.amount;
export const currency: string = item.currency;
// @ts-expect-error the amount field is a number
export const wrong: string = item.amount;
`,
  });
  await buildModelProject(root);
});

test('an SDK model beside objects tagged by a literal union generates and decodes each branch', async t => {
  // protects: bug-sweep RUNM1030 once rejected an SDK model beside objects whose tag is a union of literals (`kind: 'a' | 'b'`), which union conversion accepts
  const { root, sourceRoot } = fixture(t);
  await writeMoneySdk(sourceRoot);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/index.js';
export type TItem = IModel<{ value: Money | { kind: 'a' | 'b'; x: number } | { kind: 'c' } }>;
`,
  });
  await buildModelProjectWith(root, { mobx: false, validation: true });
  const generated = await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
  for (const value of [{ kind: 'a', x: 1 }, { kind: 'b', x: 2 }, { kind: 'c' }, { amount: 5, currency: 'EUR' }]) {
    assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(generated.TItemBaseModel, { value })), { value });
  }
});

test('an SDK model beside objects whose literal tags overlap stops generation with RUNM1030', async t => {
  // protects: bug-sweep RUNM1030 still rejects a tag value that two objects beside an SDK model share
  const { root, sourceRoot } = fixture(t);
  await writeMoneySdk(sourceRoot);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/index.js';
export type TItem = IModel<{ value: Money | { kind: 'a' | 'b'; x: number } | { kind: 'b' } }>;
`,
  });
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /item\.model\.ts:\d+:\d+ RUNM1030: Generated model union in TItem has an ambiguous object alternative\. Add a required literal discriminator\./,
  );
  assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
});

test('an IModel over an SDK model keeps a field spelled like a brand key and drops the real brand keys', async t => {
  // protects: F-213 a generated-model brand key is found by its symbol, so a string key spelled like one stays a field
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'odd.yaml'), `openapi: 3.1.0
info: { title: Odd, version: "1" }
paths: {}
components:
  schemas:
    Odd:
      type: object
      required: [amount, "__@generatedModelWireBrand@1"]
      additionalProperties: false
      properties:
        amount: { type: number }
        "__@generatedModelWireBrand@1": { type: string }
`);
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sourceRoot, 'odd.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Odd',
    profile: { mobx: false, validation: true },
  })).artifacts);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Odd } from './sdk/index.js';
import { TItemBaseModel, TPlainBaseModel } from './item.model.generated.js';
export type TItem = IModel<Odd>;
export type TPlain = IModel<{ amount: number; '__@generatedModelWireBrand@1': string }>;
export class Item extends TItemBaseModel {}
export class Plain extends TPlainBaseModel {}
`,
    'consumer.ts': `import { Item, type Plain } from './item.model.js';
export const item = new Item({ amount: 1, '__@generatedModelWireBrand@1': 'plain' });
export const amount: number = item.amount;
export const odd: string = item['__@generatedModelWireBrand@1'];
// @ts-expect-error the string key spelled like a brand key is a string field
export const wrong: number = item['__@generatedModelWireBrand@1'];
type SymbolKeys<T> = Extract<keyof T, symbol>;
// the real brand keys of the SDK model add no symbol key beyond the ones every model class has
export const brandKeysDropped: [SymbolKeys<Item>] extends [SymbolKeys<Plain>] ? ([SymbolKeys<Plain>] extends [SymbolKeys<Item>] ? true : false) : false = true;
`,
  });
  await buildModelProject(root);
  const authored = await import(`${path.join(root, 'build/item.model.js')}?${Date.now()}`);
  const item = new authored.Item({ amount: 1, '__@generatedModelWireBrand@1': 'plain' });
  assert.deepEqual(encodeGeneratedModel(item), { amount: 1, '__@generatedModelWireBrand@1': 'plain' });
});

for (const [place, fields] of [['a field of the model', 'name: string; [sym]: string'], ['a field of a nested object', 'inner: { name: string; [sym]: string }']] as const) {
  test(`a symbol-keyed property in ${place} stops generation with RUNM1070`, t => {
    // protects: F-39 golem rejects a property that JSON cannot carry; a symbol key once became a field named __@sym@N
    const { root, sourceRoot } = fixture(t);
    writeModelSources(sourceRoot, {
      'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
declare const sym: unique symbol;
export type TItem = IModel<{ ${fields} }>;
`,
    });
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /item\.model\.ts:\d+:\d+ RUNM1070: Model TItem has the property \[sym\] with a symbol key\. JSON cannot carry a symbol key\. Use a string key, or remove the property\./,
    );
  });
}

test('generated readonly fields remain readonly to TypeScript consumers', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  fs.writeFileSync(path.join(sourceRoot, 'readonly-consumer.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/readonly-consumer.ts"));
  await buildModelProject(root);
});

test('anonymous nested IModel declarations fail with an actionable diagnostic', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/anonymous-nested-imodel-declarations-fail-with-an-actionable-diagnostic/item.model.ts"));
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1053.*named, exported declaration/,
  );
});

for (const tag of ['serde', 'validation'] as const) {
  test(`projection rejects discarded whole-object ${tag} metadata`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), discardedProjectionCodecsSource({ metadata: tag }).text);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), discardedProjectionMetadataSource({ metadata: tag }).text);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /RUNM1055.*whole-object constraints or serialization/,
    );
  });
}

test('generic model templates require a concrete named declaration', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generic-model-templates-require-a-concrete-named-declaration/item.model.ts"));
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1057.*concrete fields/);
});

test('MobX projections retain nested observability', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/model-composition-item-model/item.model.ts"));
  writeModelGolemYaml(root, { mobx: true, validation: true });
  await buildModelProject(root);
  const { Parent, Child } = await import(path.join(root, 'build/item.model.js'));
  const { autorun, isObservableObject, runInAction } = await import('mobx');
  const parent = decodeGeneratedModel(Parent, { projected: { child: { name: 'First' } } });
  assert.ok(parent.projected.child instanceof Child);
  assert.equal(Object.getPrototypeOf(parent.projected), Object.prototype);
  assert.ok(isObservableObject(parent.projected.child));
  const seen: string[] = [];
  const dispose = autorun(() => { seen.push(parent.projected.child.name); });
  try {
    runInAction(() => { parent.projected.child.name = 'Next'; });
    assert.deepEqual(seen, ['First', 'Next']);
    assert.deepEqual(encodeGeneratedModel(parent), { projected: { child: { name: 'Next' } } });
    runInAction(() => { parent.projected.child.name = 'x'; });
    assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'Parent')).assert( encodeGeneratedModel(parent)));
  } finally { dispose(); }
});

// protects: T-471 Date & Model once generated a field of Date's method names (validation off) or blamed toString with RUNM1004 (validation on)
const scalarWithObject = [
  { name: 'a required field', fields: '{ x: Date & TAddress }', scalar: 'Date' },
  { name: 'an optional field', fields: '{ x?: Date & TAddress }', scalar: 'Date' },
  { name: 'two object parts that give one field', fields: '{ x: Date } & { x: TAddress }', scalar: 'Date' },
  { name: 'a bigint field', fields: '{ x: bigint & TAddress }', scalar: 'bigint' },
  { name: 'a branded Date with a model', fields: "{ x: Date & { readonly __brand: 'T' } & TAddress }", scalar: 'Date' },
] as const;
for (const { name, fields, scalar } of scalarWithObject) for (const validation of [true, false]) {
  test(`${name} that combines a scalar with a model stops with RUNM1085 with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type TAddress = IModel<{ city: string }>;
export type TItem = IModel<${fields}>;
`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      new RegExp(`RUNM1085: Field "x" of TItem combines ${scalar} with an object type, and no value is both\\. Keep one of the two types, or move the object into its own field`),
    );
    assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
  });
}

// protects: T-553 RUNM1004 for a Map or Set field blamed a method name (clear, add); it now names the Map or Set, and with validation off the field once generated with a required `size`
const mapOrSetModelFields = [
  { fields: '{ x: Map<string, number> }', kind: 'Map' },
  { fields: '{ x: Set<string> }', kind: 'Set' },
  { fields: '{ x: ReadonlyMap<string, number> }', kind: 'ReadonlyMap' },
  { fields: '{ x?: ReadonlySet<string> }', kind: 'ReadonlySet' },
] as const;
for (const { fields, kind } of mapOrSetModelFields) for (const validation of [true, false]) {
  test(`a model field typed ${kind} stops with RUNM1004 naming ${kind} with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type TItem = IModel<${fields}>;
`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      new RegExp(`RUNM1004: Field "x" of TItem is a ${kind}, which golem cannot represent\\. Use a Record or an array\\.`),
    );
  });
}

// protects: T-471 a Date with a phantom brand is a Date (RUNM1085 once said no value is both); a bigint with a brand keeps the old TSerde message
for (const validation of [true, false]) {
  test(`a Date with a phantom brand generates a Date field and round-trips a Date with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type Timestamp = Date & { readonly __brand: 'Timestamp' };
export type Optional = Date & { readonly __brand?: 'Optional' };
export type TItem = IModel<{ at: Timestamp; later?: Optional }>;
`);
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const generated = await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
    const decoded = decodeGeneratedModel(generated.TItemBaseModel, { at: '2024-05-06T07:08:09.000Z', later: '2025-01-02T03:04:05.000Z' });
    assert.equal(decoded.at instanceof Date, true);
    assert.equal(decoded.later instanceof Date, true);
    assert.deepEqual(encodeGeneratedModel(decoded), { at: '2024-05-06T07:08:09.000Z', later: '2025-01-02T03:04:05.000Z' });
  });
}

// protects: bug-sweep a string with a required literal brand (`string & { readonly __brand: 'Email' }`) rejected every string ("Expected object"): the brand test accepted only undefined or never members
for (const exact of [true, false]) {
  test(`a string with a required literal brand accepts a string and rejects a number with exact ${exact}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type Email = string & { readonly __brand: 'Email' };
export type TItem = IModel<{ email: Email }>;
`);
    await buildModelProjectWith(root, { mobx: false, validation: true, exact });
    await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
    assert.deepEqual(codec.parse('{"email":"a@b.c"}'), { email: 'a@b.c' });
    assert.equal(codec.validate({ email: 'a@b.c' }), true);
    assert.equal(codec.validate({ email: 1 }), false);
  });
}

// protects: bug-sweep a Record keyed by a template literal (`id_${string}`) accepted a key that does not match the template
test('a Record with a template-literal key rejects a key outside the template and decodes the Dates of the others', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type TItem = IModel<{ seen: Record<\`id_\${string}\`, Date>; both: Record<\`a_\${string}_z\` | \`b.\${string}\`, number>; accent?: Record<\`café_\${string}\`, number>; mixed?: { [key: number]: number; [key: \`id_\${string}\`]: number } }>;
`);
  await buildModelProjectWith(root, { mobx: false, validation: true });
  await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
  const day = '2024-01-01T00:00:00.000Z';
  assert.equal(codec.validate({ seen: { id_1: new Date(day) }, both: {} }), true);
  assert.equal(codec.validate({ seen: { other: new Date(day) }, both: {} }), false);
  assert.equal(codec.validate({ seen: {}, both: { a_1_z: 1, 'b.x': 2 } }), true);
  for (const both of [{ a_1: 1 }, { 'bx': 2 }, { a_1_zz: 3 }]) assert.equal(codec.validate({ seen: {}, both }), false, JSON.stringify(both));
  assert.deepEqual(codec.parse(`{"seen":{"id_1":"${day}"},"both":{}}`), { seen: { id_1: new Date(day) }, both: {} });
  assert.throws(() => codec.parse(`{"seen":{"other":"${day}"},"both":{}}`), /Model validation failed/);
  // A key text outside ASCII, and a number index beside a template one.
  assert.equal(codec.validate({ seen: {}, both: {}, accent: { 'café_1': 1 } }), true);
  assert.equal(codec.validate({ seen: {}, both: {}, accent: { cafe_1: 1 } }), false);
  assert.equal(codec.validate({ seen: {}, both: {}, mixed: { '1': 1, '-2.5': 2, id_x: 3 } }), true);
  assert.equal(codec.validate({ seen: {}, both: {}, mixed: { x: 1 } }), false);
});

for (const key of ['${number}', '${string}_${number}', 'Uppercase<string>']) {
  test(`a Record keyed by ${key} that golem cannot state as one key pattern stops generation with RUNM1004`, t => {
    const { root, sourceRoot } = fixture(t);
    const keyType = key.startsWith('Upper') ? key : `\`${key}\``;
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type TItem = IModel<{ seen: Record<${keyType}, Date> }>;
`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /item\.model\.ts:\d+:\d+ RUNM1004: Field "seen" of TItem is keyed by a template literal type that golem cannot state as a key pattern\. Use string-only holes, such as `id_\$\{string\}`, or a plain string key\./,
    );
    // With validation off golem states no key rule, so the key type does not stop generation.
    assert.doesNotThrow(() => generate({ root, profile: { mobx: false, validation: false } }));
  });
}

test('a bigint with a phantom brand keeps the TSerde message, not RUNM1085', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type TItem = IModel<{ x: bigint & { readonly __brand: 'Id' } }>;
`);
  assert.throws(() => generate({ root, profile: { mobx: false, validation: false } }), /bigint has no JSON representation; declare a TSerde wire codec/);
});

// protects: T-559 a derived model that narrowed an array-of-models field decoded its items as plain objects
for (const validation of [true, false]) {
  test(`a derived model that narrows an array-of-models field decodes model instances with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'pets.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
export type TPet = IModel<{ name: string }>;
export type TCat = IModel<{ name: string; lives: number }>;
export type TOwner = IModel<{ pet: TPet; pets: TPet[] }>;
export type TCatOwner = IModel<TOwner & { pet: TCat; pets: TCat[] }>;
`);
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const generated = await import(`${path.join(root, 'build/pets.model.generated.js')}?${Date.now()}`);
    const wire = { pet: { name: 'Tom', lives: 9 }, pets: [{ name: 'Kit', lives: 3 }] };
    const decoded = decodeGeneratedModel(generated.TCatOwnerBaseModel, wire);
    assert.equal(decoded.pet instanceof generated.TCatBaseModel, true);
    assert.equal(decoded.pets[0] instanceof generated.TCatBaseModel, true);
    assert.deepEqual(encodeGeneratedModel(decoded), wire);
  });
}

test('a projection inside a type alias keeps its model when an unrelated generic parameter shares the model name', async t => {
  // protects: bug sweep 3 fieldProvenance read the model TAddress in Pair as the argument of Wrap<TAddress> by name, so the projection check never saw the model
  const { root, sourceRoot } = fixture(t);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { MinProperties } from '@exprtlabs/golem/tags';
export type TAddress = IModel<{ id: string; city: string } & MinProperties<1>>;
type Pair = Omit<TAddress, 'id'> | string;
type Wrap<TAddress> = Pair | null;
export type TContainer = IModel<{ projected: Wrap<string> }>;
`,
  });
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1055.*Projection of TAddress would discard whole-object constraints/,
  );
});
