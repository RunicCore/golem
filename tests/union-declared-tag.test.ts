import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { generate } from '#model/generator';
import { fixturePath, writeGeneratedArtifacts } from './fixture-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { requireRecord, type GeneratedModelClass } from './openapi/helpers.js';

const TAG = "Discriminator<'kind'>";

// Every position a declared union can stand in: written on the union, through an alias, nullable, optional, array and record value.
const CONTACT_MODEL = `
import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import { TContactBaseModel, TEmailBaseModel, TPhoneBaseModel, TProbeBaseModel, TAlphaBaseModel, TBetaBaseModel } from './contact.model.generated.js';

export type TEmail = IModel<{ kind: 'email'; address: string; added: Date }>;
export type TPhone = IModel<{ kind: 'phone'; number: string; added: Date }>;
export type TValue = (TEmail | TPhone) & ${TAG};
export type TContact = IModel<{
  written: (TEmail | TPhone) & ${TAG};
  aliased: TValue;
  nullable: ((TEmail | TPhone) & ${TAG}) | null;
  optional?: (TEmail | TPhone) & ${TAG};
  list: ((TEmail | TPhone) & ${TAG})[];
  byName: Record<string, (TEmail | TPhone) & ${TAG}>;
}>;

export type TAlpha = IModel<{ kind: 'a'; mode: 'x'; at: Date }>;
export type TBeta = IModel<{ kind: 'b'; mode: 'y'; at: Date }>;
export type TProbe = IModel<{ item: (TAlpha | TBeta) & Discriminator<'mode'> }>;

export class Email extends TEmailBaseModel {}
export class Phone extends TPhoneBaseModel {}
export class Contact extends TContactBaseModel {}
export class Alpha extends TAlphaBaseModel {}
export class Beta extends TBetaBaseModel {}
export class Probe extends TProbeBaseModel {}
`;

/** The built contact project: the root models and the generated bases their variants are instances of. */
async function loadContact(root: string): Promise<Record<'Contact' | 'Probe' | 'Email' | 'Phone' | 'Alpha', GeneratedModelClass>> {
  const module = async (name: string): Promise<Record<string, unknown>> => requireRecord(await import(pathToFileURL(path.join(root, name)).href), name);
  const [models, bases] = [await module('build/contact.model.js'), await module('build/contact.model.generated.js')];
  const pick = (source: Record<string, unknown>, name: string): GeneratedModelClass => source[name] as GeneratedModelClass;
  return {
    Contact: pick(models, 'Contact'), Probe: pick(models, 'Probe'),
    Email: pick(bases, 'TEmailBaseModel'), Phone: pick(bases, 'TPhoneBaseModel'), Alpha: pick(bases, 'TAlphaBaseModel'),
  };
}

const DAY = '2024-05-06T07:08:09.000Z';
const email = { kind: 'email', address: 'a@b.c', added: DAY };
const phone = { kind: 'phone', number: '555', added: DAY };

for (const validation of [false, true]) {
  test(`a union that declares its tag key converts at every position, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-593 Discriminator<'kind'> on the union, an alias, a nullable, optional, array and record position drives conversion
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-tag-', name: 'declared-tag', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, { 'contact.model.ts': CONTACT_MODEL });
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const { Contact, Email, Phone } = await loadContact(root);
    const wire = {
      written: email, aliased: phone, nullable: null, list: [email, phone], byName: { home: phone },
    };
    const options = { validate: validation };
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TContact'));
    for (const decoded of [codec.fromWireFormat(wire, options), codec.parse(JSON.stringify(wire), options)]) {
      const contact = requireRecord(decoded, 'contact');
      assert.deepEqual({ ...requireRecord(contact.written, 'written') }, { ...email, added: new Date(DAY) });
      assert.deepEqual({ ...requireRecord(contact.aliased, 'aliased') }, { ...phone, added: new Date(DAY) });
      assert.equal(contact.nullable, null);
    }
    const contact = requireRecord(decodeGeneratedModel(Contact, wire), 'contact');
    assert.ok(contact.written instanceof Email, `validation=${validation}: written is an Email`);
    assert.ok(contact.aliased instanceof Phone, `validation=${validation}: aliased is a Phone`);
    assert.equal(contact.nullable, null);
    assert.deepEqual((contact.list as object[]).map(item => item instanceof Email), [true, false]);
    assert.ok(requireRecord(contact.byName, 'byName').home instanceof Phone);
    assert.ok(requireRecord(contact.written, 'written').added instanceof Date);
    const full = { ...wire, nullable: phone, optional: email };
    const decoded = requireRecord(decodeGeneratedModel(Contact, full), 'contact');
    assert.ok(decoded.nullable instanceof Phone);
    assert.ok(decoded.optional instanceof Email);
    assert.deepEqual(encodeGeneratedModel(decoded), full);
    assert.deepEqual(JSON.parse(codec.stringify(decoded, options)), full);
    if (validation) assert.throws(() => decodeGeneratedModel(Contact, { ...wire, written: { ...email, kind: 'fax' } }));
  });
}

test('a declared key picks the variant even when another shared literal field would tell the variants apart', async (t) => {
  // protects: T-593 the declared key, not an inferred one, selects the variant (kind comes first, the declared key is mode)
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-key-', name: 'declared-key', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'contact.model.ts': CONTACT_MODEL });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const { Probe, Alpha } = await loadContact(root);
  const probe = requireRecord(decodeGeneratedModel(Probe, { item: { kind: 'b', mode: 'x', at: DAY } }), 'probe');
  assert.ok(probe.item instanceof Alpha, 'mode "x" selects Alpha although kind says "b"');
});

test('the generated model types carry no Discriminator tag', t => {
  // protects: T-593 a tag does not change the application type (F-31), so it stays out of the generated file
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-text-', name: 'declared-text' });
  writeModelSources(sourceRoot, { 'contact.model.ts': CONTACT_MODEL });
  const artifacts = generate({ root, profile: { mobx: false, validation: true } }).artifacts;
  const generated = artifacts.find(artifact => artifact.path.endsWith('contact.model.generated.ts'));
  assert.ok(generated, 'contact.model.generated.ts must be generated');
  assert.ok(/TEmail/.test(generated.content));
  assert.equal(/\bDiscriminator\b/.test(generated.content), false);
});

const TAG_SHAPE = "Discriminator<'shape'>";

test('a variant made of several object parts gets no field from the Discriminator tag', t => {
  // protects: T-602 the tag key is type-only, so it is no field of the variants (it had a checker-specific name, so output differed between TypeScript 6 and 7)
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-parts-', name: 'declared-parts' });
  writeModelSources(sourceRoot, {
    'parts.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
type Geo = { lat: number };
type Scale = { scale: 1 | 2 };
export type TPlace = IModel<{ spot: ((Geo & Scale & { shape: 'point' }) | (Scale & { shape: 'name' })) & ${TAG_SHAPE} }>;
`,
  });
  const artifacts = generate({ root, profile: { mobx: false, validation: true } }).artifacts;
  const generated = artifacts.find(artifact => artifact.path.endsWith('parts.model.generated.ts'));
  assert.ok(generated, 'parts.model.generated.ts must be generated');
  assert.ok(/lat: number; scale: 1 \| 2; shape: "point"/.test(generated.content));
  assert.equal(/discriminatorTag/.test(generated.content), false);
});

const VARIANTS = `
import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
export type TEmail = IModel<{ kind: 'email'; added: Date }>;
`;

for (const validation of [false, true]) {
  const profile = { mobx: false, validation };
  for (const [name, source, message] of [
    [
      'a variant without the key',
      `${VARIANTS}export type TLabel = IModel<{ label: string; added: Date }>;\nexport type TBox = IModel<{ value: (TEmail | TLabel) & ${TAG} }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1087: Union variant \w+ in TBox has no required literal property "kind", the tag key that Discriminator<'kind'> declares\. Give \w+ a required "kind" property with a literal type, such as `kind: 'a'`\./,
    ],
    [
      'two variants that share a value',
      `${VARIANTS}export type TSecond = IModel<{ kind: 'email' | 'mail'; added: Date }>;\nexport type TBox = IModel<{ value: (TEmail | TSecond) & ${TAG} }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1087: Union variants \w+ and \w+ in TBox share the "kind" value "email"\. Give each variant its own "kind" value\./,
    ],
    [
      'a default that is not a variant of the union',
      `${VARIANTS}export type TPhone = IModel<{ kind: 'phone'; added: Date }>;\nexport type TOther = IModel<{ other: string }>;\nexport type TBox = IModel<{ value: (TEmail | TPhone) & Discriminator<'kind', TOther> }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1051: Discriminator<'kind', .*> in TBox names a default that is not a variant of the union\. Name one of its variants: /,
    ],
    [
      'a default variant that has the key itself',
      `${VARIANTS}export type TPhone = IModel<{ kind: 'phone'; added: Date }>;\nexport type TBox = IModel<{ value: (TEmail | TPhone) & Discriminator<'kind', TPhone> }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1051: The default variant \w+ of Discriminator<'kind'> in TBox has a "kind" property itself\./,
    ],
    [
      'two different tag keys on one union',
      `${VARIANTS}export type TPhone = IModel<{ kind: 'phone'; added: Date }>;\nexport type TA = IModel<{ type: 'a' }>;\nexport type TB = IModel<{ type: 'b' }>;\nexport type TBox = IModel<{ value: ((TEmail | TPhone) & ${TAG}) | ((TA | TB) & Discriminator<'type'>) }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1051: Conflicting Discriminator tags: '(kind' and 'type|type' and 'kind)'\. A union has one tag key\./,
    ],
    [
      'a tag on one object',
      `${VARIANTS}export type TBox = IModel<{ value: TEmail & ${TAG} }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1051: Discriminator on the model value requires a union of two or more object types, but TBox resolves to /,
    ],
  ] as const) {
    test(`${name} stops generation with a coded diagnostic, with validation ${validation ? 'on' : 'off'}`, t => {
      // protects: T-593 rule (b) RUNM1087 for a missing or shared tag value; a misplaced tag stops like any misplaced constraint
      const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-bad-', name: 'declared-bad' });
      writeModelSources(sourceRoot, { 'bad.model.ts': source });
      assert.throws(() => generate({ root, profile }), message);
    });
  }
}

/** The SDK of the Money document; `document` replaces the fixture's closed Money with the document it states. */
async function writeMoneySdk(sourceRoot: string, validation: boolean, document?: string): Promise<void> {
  if (document === undefined) fs.copyFileSync(fixturePath('wire-format/sdk-money/money.yaml'), path.join(sourceRoot, 'money.yaml'));
  else fs.writeFileSync(path.join(sourceRoot, 'money.yaml'), document);
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sourceRoot, 'money.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Payments',
    profile: { mobx: false, validation },
  })).artifacts);
}

/** A project whose TItem model is `value`'s type beside Money from `document` (the closed fixture by default), built, with its companion module loaded. */
async function buildMoneyItem(
  t: TestContext, prefix: string, validation: boolean, valueType: string, document?: string,
): Promise<{ readonly root: string; readonly Item: GeneratedModelClass }> {
  const { root, sourceRoot } = createModelProject(t, { prefix: `golem-${prefix}-`, name: prefix, linkWorkspaceNodeModules: true });
  await writeMoneySdk(sourceRoot, validation, document);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/index.js';
export type TItem = IModel<{ value: ${valueType} }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  const generated = requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.generated.js')).href), 'item companion');
  return { root, Item: generated.TItemBaseModel as GeneratedModelClass };
}

for (const validation of [false, true]) {
  test(`a declared default variant takes the value whose tag selects no object, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-593 Discriminator<'kind', Money> makes the SDK model the default beside tagged objects; each tagged object still wins by its value
    const { Item } = await buildMoneyItem(t, 'declared-default', validation,
      "(Money | { kind: 'a' | 'b'; x: number } | { kind: 'c' }) & Discriminator<'kind', Money>");
    const plain = (value: unknown): boolean => Object.getPrototypeOf(value) === Object.prototype;
    const valueOf = (wire: unknown): unknown => requireRecord(decodeGeneratedModel(Item, { value: wire }), 'item').value;
    for (const wire of [{ kind: 'a', x: 1 }, { kind: 'b', x: 2 }, { kind: 'c' }]) {
      assert.equal(plain(valueOf(wire)), true, `validation=${validation}: ${JSON.stringify(wire)} is the tagged object`);
    }
    for (const wire of [{ amount: 5, currency: 'EUR' }, { kind: 'zzz', amount: 5, currency: 'EUR' }]) {
      assert.equal(plain(valueOf(wire)), false, `validation=${validation}: ${JSON.stringify(wire)} is the default SDK model`);
    }
  });
}

// Money states no additionalProperties: false, so only the declared default's narrowing keeps it from taking a tagged variant's value.
const OPEN_MONEY_DOCUMENT = fs.readFileSync(fixturePath('wire-format/sdk-money/money.yaml'), 'utf8').split('\n').filter(line => !line.includes('additionalProperties')).join('\n');

test('an open declared default does not take the value of a tagged variant that the value does not fit', async (t) => {
  // protects: I-2 (P-31) the default takes only values whose tag selects no variant, also when its model is open
  const { root } = await buildMoneyItem(t, 'declared-open-default', true,
    "(Money | { kind: 'a' | 'b'; x: number } | { kind: 'c' }) & Discriminator<'kind', Money>", OPEN_MONEY_DOCUMENT);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
  const options = { validate: true };
  assert.throws(() => codec.parse(JSON.stringify({ value: { kind: 'a', amount: 5, currency: 'EUR' } }), options));
  assert.throws(() => codec.fromWireFormat({ value: { kind: 'a', amount: 5, currency: 'EUR' } }, options));
  for (const wire of [{ amount: 5, currency: 'EUR' }, { kind: 'zzz', amount: 5, currency: 'EUR' }, { kind: 'a', x: 1 }]) {
    assert.doesNotThrow(() => codec.parse(JSON.stringify({ value: wire }), options), JSON.stringify(wire));
  }
});

const BOX_MODEL = `
import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import { TBoxBaseModel, TEmailBaseModel, TPhoneBaseModel } from './box.model.generated.js';

export type TEmail = IModel<{ kind: 'email'; address: string; added: Date }>;
export type TPhone = IModel<{ kind: 'phone'; number: string; added: Date }>;
export type TBox = IModel<{
  text: (string | TEmail | TPhone) & ${TAG};
  amount: ((number | TEmail | TPhone) & ${TAG}) | null;
  list: (TEmail | TPhone | string[]) & ${TAG};
  flag: (boolean | 'none' | TEmail | TPhone) & ${TAG};
}>;

export class Email extends TEmailBaseModel {}
export class Phone extends TPhoneBaseModel {}
export class Box extends TBoxBaseModel {}
`;

for (const validation of [false, true]) {
  test(`a declared tag picks the object variants beside scalars, an array and null, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-603 a tagged object union can sit beside scalars, arrays and null (R-55): JSON type first, then the declared tag
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-json-', name: 'declared-json', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, { 'box.model.ts': BOX_MODEL });
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const models = requireRecord(await import(pathToFileURL(path.join(root, 'build/box.model.js')).href), 'box');
    const { Box, Email, Phone } = models as Record<'Box' | 'Email' | 'Phone', GeneratedModelClass>;
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TBox'));
    const options = { validate: validation };
    const scalars = { text: 'hi', amount: null, list: ['a', 'b'], flag: true };
    const mixed = { text: email, amount: 5, list: phone, flag: 'none' };
    const objects = { text: phone, amount: email, list: email, flag: phone };
    for (const wire of [scalars, mixed, objects]) {
      const decoded = requireRecord(decodeGeneratedModel(Box, wire), 'box');
      assert.deepEqual(encodeGeneratedModel(decoded), wire, `validation=${validation}: encode of ${JSON.stringify(wire)}`);
      assert.deepEqual(JSON.parse(codec.stringify(decoded, options)), wire, `validation=${validation}: stringify of ${JSON.stringify(wire)}`);
      assert.deepEqual(JSON.parse(JSON.stringify(requireRecord(codec.parse(JSON.stringify(wire), options), 'parsed'))), wire);
    }
    const first = requireRecord(decodeGeneratedModel(Box, scalars), 'box');
    assert.deepEqual([first.text, first.amount, first.list, first.flag], ['hi', null, ['a', 'b'], true]);
    const second = requireRecord(decodeGeneratedModel(Box, mixed), 'box');
    assert.ok(second.text instanceof Email && second.list instanceof Phone, `validation=${validation}: tagged objects become their models`);
    assert.ok(requireRecord(second.text, 'text').added instanceof Date);
    assert.deepEqual([second.amount, second.flag], [5, 'none']);
    const third = requireRecord(decodeGeneratedModel(Box, objects), 'box');
    assert.ok(third.text instanceof Phone && third.amount instanceof Email && third.list instanceof Email && third.flag instanceof Phone);
    assert.throws(() => decodeGeneratedModel(Box, { ...scalars, text: { ...email, kind: 'fax' } }), /Unknown kind discriminator value/);
  });

  test(`a declared default model sits beside scalars, an array and null, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-603 the declared default is the fallback of the object branch beside JSON-type variants (the wallet shape)
    const { root, Item } = await buildMoneyItem(t, 'declared-json-default', validation,
      "((Money | string | number[] | { kind: 'a'; x: number } | { kind: 'c' }) & Discriminator<'kind', Money>) | null");
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
    const options = { validate: validation };
    const plain = (value: unknown): boolean => Object.getPrototypeOf(value) === Object.prototype;
    const money = { amount: 5, currency: 'EUR' };
    for (const [wire, isModel] of [
      ['hi', false], [[1, 2], false], [null, false], [{ kind: 'a', x: 1 }, false], [{ kind: 'c' }, false],
      [money, true],
    ] as const) {
      const item = requireRecord(decodeGeneratedModel(Item, { value: wire }), 'item');
      const label = `validation=${validation}: ${JSON.stringify(wire)}`;
      assert.equal(typeof item.value === 'object' && item.value !== null && !Array.isArray(item.value) && !plain(item.value), isModel, label);
      assert.deepEqual(encodeGeneratedModel(item), { value: wire }, label);
      assert.deepEqual(JSON.parse(codec.stringify(item, options)), { value: wire }, label);
    }
    const unknownTag = requireRecord(decodeGeneratedModel(Item, { value: { kind: 'zzz', ...money } }), 'item').value;
    assert.equal(plain(unknownTag), false, `validation=${validation}: an unknown tag takes the default model`);
  });
}

// Every Money field is optional and Money states no additionalProperties: false, so an instance of another variant's class fits the default's document.
const LOOSE_MONEY_DOCUMENT = OPEN_MONEY_DOCUMENT.replace(/ {6}required: \[amount, currency\]\n/, '');

test('an open declared default does not take an instance of another variant\'s class that carries no tag', async (t) => {
  // protects: T-605 a tag-less TEmail instance is judged as a TEmail and rejected for its missing tag (F-39), not passed by the open default Money
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-instance-', name: 'declared-instance', linkWorkspaceNodeModules: true });
  await writeMoneySdk(sourceRoot, true, LOOSE_MONEY_DOCUMENT);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/index.js';
import { TItemBaseModel, TEmailBaseModel } from './item.model.generated.js';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export type TItem = IModel<{ value: (TEmail | TPhone | Money) & Discriminator<'kind', Money> }>;
export class Email extends TEmailBaseModel {}
export class Item extends TItemBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const { Item, Email } = requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.js')).href), 'item') as Record<string, new () => Record<string, unknown>>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
  const itemOf = (value: unknown): Record<string, unknown> => Object.assign(new Item(), { value });
  const emailOf = (fields: Record<string, unknown>): unknown => Object.assign(new Email(), fields);
  const problems = async (value: unknown): Promise<number> => (await validateInstance(itemOf(value))).length;
  assert.equal(await problems(emailOf({ address: 5 })), 1, 'a tag-less TEmail with a wrong address');
  assert.equal(await problems(emailOf({})), 1, 'a tag-less TEmail without its address');
  assert.equal(await problems(emailOf({ address: 'a@b.c' })), 1, 'a TEmail needs its tag, as in a union with no default');
  assert.equal(await problems(emailOf({ kind: 'email', address: 'a@b.c' })), 0, 'a valid tagged TEmail');
  assert.equal(await problems({ amount: 5 }), 0, 'a plain default value');
  const badItem = itemOf(emailOf({ address: 5 }));
  assert.equal(await getValidator(badItem).validate(badItem), false);
  assert.throws(() => codec.stringify(badItem, { validate: true }), /Model validation failed/);
});

test('a writer tells a model instance by its class before its tag, with validation off', async (t) => {
  // protects: T-605 stringify and toWireFormat wrote a tag-less TEmail instance as the default and an instance tagged as TPhone as a TPhone; encode wrote the first as TEmail and rejected the second
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-writer-', name: 'declared-writer', linkWorkspaceNodeModules: true });
  await writeMoneySdk(sourceRoot, false, LOOSE_MONEY_DOCUMENT);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/index.js';
import { TItemBaseModel, TEmailBaseModel } from './item.model.generated.js';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export type TItem = IModel<{ value: (TEmail | TPhone | Money) & Discriminator<'kind', Money> }>;
export class Email extends TEmailBaseModel {}
export class Item extends TItemBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const { Item, Email } = requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.js')).href), 'item') as Record<string, new () => Record<string, unknown>>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
  const itemOf = (fields: Record<string, unknown>): Record<string, unknown> => Object.assign(new Item(), { value: Object.assign(new Email(), fields) });
  const tagless = itemOf({ address: 'a@b.c' });
  assert.equal(codec.stringify(tagless), '{"value":{"kind":"email","address":"a@b.c"}}');
  assert.deepEqual(codec.toWireFormat(tagless), { value: { kind: 'email', address: 'a@b.c' } });
  assert.deepEqual(encodeGeneratedModel(tagless), { value: { kind: 'email', address: 'a@b.c' } });
  const tagged = itemOf({ kind: 'email', address: 'a@b.c' });
  assert.equal(codec.stringify(tagged), '{"value":{"kind":"email","address":"a@b.c"}}');
  const other = itemOf({ kind: 'phone', address: 'a@b.c' });
  assert.throws(() => encodeGeneratedModel(other), /Unknown kind discriminator value: "phone"/);
  assert.throws(() => codec.stringify(other), /Unknown kind discriminator value: "phone"/);
  assert.throws(() => codec.toWireFormat(other), /Unknown kind discriminator value: "phone"/);
});

test('a validating companion writes the tag of a tag-less instance once when validation is turned off for the call', async (t) => {
  // protects: T-605 the strict Core writes its literal tag itself, so the class branch must not inject it a second time
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-strict-', name: 'declared-strict', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import { TItemBaseModel, TEmailBaseModel } from './item.model.generated.js';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export type TItem = IModel<{ value: (TEmail | TPhone) & ${TAG} }>;
export class Email extends TEmailBaseModel {}
export class Item extends TItemBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const { Item, Email } = requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.js')).href), 'item') as Record<string, new () => Record<string, unknown>>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
  const tagless = Object.assign(new Item(), { value: Object.assign(new Email(), { address: 'a@b.c' }) });
  assert.equal(codec.stringify(tagless, { validate: false }), '{"value":{"kind":"email","address":"a@b.c"}}');
});
