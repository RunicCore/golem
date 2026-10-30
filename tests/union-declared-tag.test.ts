import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { generate } from '#model/generator';
import { fixturePath, writeGeneratedArtifacts } from './fixture-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { requireRecord, type GeneratedModelClass } from './openapi/helpers.js';
import { modelCodec } from './support/model-codec.js';
import { parse as parseYaml } from 'yaml';
import { loadGolemModeProject } from './openapi/sdk-client-fixture.js';

const TAG = "Discriminator<'kind'>";

type ContactCodecs = Record<string, (value: unknown, options?: object) => unknown>;

async function buildContactCodecs(root: string, validation: boolean): Promise<ContactCodecs> {
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  return requireRecord(await import(pathToFileURL(path.join(root, 'build/contact.model.generated.js')).href), 'contact companion') as ContactCodecs;
}

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
    const contact = requireRecord(modelCodec(Contact).fromWireFormat(wire, { validate: false }), 'contact');
    assert.ok(contact.written instanceof Email, `validation=${validation}: written is an Email`);
    assert.ok(contact.aliased instanceof Phone, `validation=${validation}: aliased is a Phone`);
    assert.equal(contact.nullable, null);
    assert.deepEqual((contact.list as object[]).map(item => item instanceof Email), [true, false]);
    assert.ok(requireRecord(contact.byName, 'byName').home instanceof Phone);
    assert.ok(requireRecord(contact.written, 'written').added instanceof Date);
    const full = { ...wire, nullable: phone, optional: email };
    const decoded = requireRecord(modelCodec(Contact).fromWireFormat(full, { validate: false }), 'contact');
    assert.ok(decoded.nullable instanceof Phone);
    assert.ok(decoded.optional instanceof Email);
    assert.deepEqual(modelCodec(decoded).toWireFormat(decoded), full);
    assert.deepEqual(JSON.parse(codec.stringify(decoded, options)), full);
    if (validation) assert.throws(() => modelCodec(Contact).fromWireFormat({ ...wire, written: { ...email, kind: 'fax' } }, { validate: false }));
  });
}

test('toWireFormat with validation off rejects an unknown tag and a tag of another variant, as stringify does', async (t) => {
  // protects: T-650 the encode tests of an unknown and a mutated tag went with the class-level encode; toWireFormat keeps the rule
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-write-tag-', name: 'declared-write-tag', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'contact.model.ts': CONTACT_MODEL });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const loaded = await loadContact(root);
  const [Email, Phone] = [loaded.Email, loaded.Phone] as unknown as (new (values: object) => object)[];
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TContact'));
  const added = new Date(DAY);
  const rest = { aliased: new Phone({ ...phone, added }), nullable: null, list: [], byName: {} };
  const options = { validate: false };
  const cases = [
    ['an unknown tag', { ...email, added, kind: 'fax' }, /"fax"/],
    ['an Email instance with the tag of Phone', Object.assign(new Email({ ...email, added }), { kind: 'phone' }), /"phone"/],
  ] as const;
  for (const [label, written, message] of cases) {
    const value = { ...rest, written };
    for (const write of [() => codec.toWireFormat(value, options), () => codec.stringify(value, options)]) {
      assert.throws(write, (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Serialization && message.test(error.message), label);
    }
  }
});

test('a declared key picks the variant even when another shared literal field would tell the variants apart', async (t) => {
  // protects: T-593 the declared key, not an inferred one, selects the variant (kind comes first, the declared key is mode)
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-key-', name: 'declared-key', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'contact.model.ts': CONTACT_MODEL });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const { Probe, Alpha } = await loadContact(root);
  const probe = requireRecord(modelCodec(Probe).fromWireFormat({ item: { kind: 'b', mode: 'x', at: DAY } }, { validate: false }), 'probe');
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

for (const validation of [false, true]) {
  test(`the class dispatch of a declared union is a selector and a codec function for each writer, with validation ${validation ? 'on' : 'off'}`, t => {
    // protects: T-617 (F-129) one selector per union and direction serves every writer and position, not a copy in each
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-selector-', name: 'declared-selector' });
    writeModelSources(sourceRoot, { 'contact.model.ts': CONTACT_MODEL });
    const generated = generate({ root, profile: { mobx: false, validation } }).artifacts.find(artifact => artifact.path.endsWith('contact.model.generated.ts'));
    assert.ok(generated, 'contact.model.generated.ts must be generated');
    // The kind union and the mode union each get a decode and an encode selector, whatever number of positions use them.
    assert.equal(generated.content.match(/^function __golemVariant_\w+\(/gm)?.length, 4);
    assert.equal(generated.content.match(/TPhoneBaseModel\.prototype instanceof TEmailBaseModel/g)?.length, 2);
    // protects: T-639 (F-129) one codec function per union and writer, which every position calls
    const writers = { stringify: /stringify\w+Core\(/, toWireFormat: /toWireFormat\w+Core\(/, decode: /decodeGeneratedModelTrusted\(/, init: /new \(requireIModelClass\(/ };
    const definitions = generated.content.match(/^function __golemUnion_\w+\(.*$/gm) ?? [];
    const perWriter = Object.fromEntries(Object.entries(writers).map(([writer, marker]) => [writer, definitions.filter(definition => marker.test(definition)).length]));
    // The kind union and the mode union each get one function for every writer.
    assert.deepEqual(perWriter, { stringify: 2, toWireFormat: 2, decode: 2, init: 2 });
  });
}

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
    // protects: T-593 Discriminator<'kind', Money> makes the SDK type the default beside tagged objects; each tagged object still wins by its value, shown by its Date field
    const { Item } = await buildMoneyItem(t, 'declared-default', validation,
      "(Money | { kind: 'a' | 'b'; at: Date } | { kind: 'c' }) & Discriminator<'kind', Money>");
    const valueOf = (wire: unknown): Record<string, unknown> => requireRecord(requireRecord(modelCodec(Item).fromWireFormat({ value: wire }, { validate: false }), 'item').value, 'value');
    const at = '2025-01-02T03:04:05.000Z';
    assert.deepEqual(valueOf({ kind: 'a', at }), { kind: 'a', at: new Date(at) });
    assert.deepEqual(valueOf({ kind: 'b', at }), { kind: 'b', at: new Date(at) });
    assert.deepEqual(valueOf({ kind: 'c' }), { kind: 'c' });
    assert.equal(valueOf({ amount: 5, currency: 'EUR' }).amount, 5);
    assert.equal(valueOf({ kind: 'zzz', amount: 5, currency: 'EUR' }).amount, 5);
  });
}

// Money states no additionalProperties: false, so only the declared default's narrowing keeps it from taking a tagged variant's value.
const OPEN_MONEY_DOCUMENT = fs.readFileSync(fixturePath('wire-format/sdk-money/money.yaml'), 'utf8').split('\n').filter(line => !line.includes('additionalProperties')).join('\n');

test('an open declared default does not take the value of a tagged variant that the value does not fit', async (t) => {
  // protects: I-2 (P-31) the default takes only values whose tag selects no variant, also when its type is open; the open type comes from a golem-mode SDK (F-804)
  const model = `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { Money } from '../sdk/index.js';
export type TItem = IModel<{ value: (Money | { kind: 'a' | 'b'; x: number } | { kind: 'c' }) & Discriminator<'kind', Money> }>;
`;
  const { root } = await loadGolemModeProject(t, 'golem-declared-open-default-', [{ document: parseYaml(OPEN_MONEY_DOCUMENT), folder: 'sdk', name: 'Payments' }], true, { 'src/item.model.ts': model });
  await import(pathToFileURL(path.join(root, 'build/src/item.model.generated.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
  const options = { validate: true };
  assert.throws(() => codec.parse(JSON.stringify({ value: { kind: 'a', amount: 5, currency: 'EUR' } }), options));
  assert.throws(() => codec.fromWireFormat({ value: { kind: 'a', amount: 5, currency: 'EUR' } }, options));
  assert.doesNotThrow(() => codec.parse(JSON.stringify({ value: { amount: 5, currency: 'EUR' } }), options));
  assert.doesNotThrow(() => codec.parse(JSON.stringify({ value: { kind: 'zzz', amount: 5, currency: 'EUR' } }), options));
  assert.doesNotThrow(() => codec.parse(JSON.stringify({ value: { kind: 'a', x: 1 } }), options));
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
      const decoded = requireRecord(modelCodec(Box).fromWireFormat(wire, { validate: false }), 'box');
      assert.deepEqual(modelCodec(decoded).toWireFormat(decoded), wire, `validation=${validation}: encode of ${JSON.stringify(wire)}`);
      assert.deepEqual(JSON.parse(codec.stringify(decoded, options)), wire, `validation=${validation}: stringify of ${JSON.stringify(wire)}`);
      assert.deepEqual(JSON.parse(JSON.stringify(requireRecord(codec.parse(JSON.stringify(wire), options), 'parsed'))), wire);
    }
    const first = requireRecord(modelCodec(Box).fromWireFormat(scalars, { validate: false }), 'box');
    assert.deepEqual([first.text, first.amount, first.list, first.flag], ['hi', null, ['a', 'b'], true]);
    const second = requireRecord(modelCodec(Box).fromWireFormat(mixed, { validate: false }), 'box');
    assert.ok(second.text instanceof Email && second.list instanceof Phone, `validation=${validation}: tagged objects become their models`);
    assert.ok(requireRecord(second.text, 'text').added instanceof Date);
    assert.deepEqual([second.amount, second.flag], [5, 'none']);
    const third = requireRecord(modelCodec(Box).fromWireFormat(objects, { validate: false }), 'box');
    assert.ok(third.text instanceof Phone && third.amount instanceof Email && third.list instanceof Email && third.flag instanceof Phone);
    assert.throws(() => modelCodec(Box).fromWireFormat({ ...scalars, text: { ...email, kind: 'fax' } }, { validate: false }), /Unknown kind discriminator value/);
  });

  test(`a declared default model sits beside scalars, an array and null, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-603 the declared default is the fallback of the object branch beside JSON-type variants (the wallet shape)
    const { root, Item } = await buildMoneyItem(t, 'declared-json-default', validation,
      "((Money | string | number[] | { kind: 'a'; x: number } | { kind: 'c' }) & Discriminator<'kind', Money>) | null");
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
    const options = { validate: validation };
    const money = { amount: 5, currency: 'EUR' };
    const item = (wire: unknown): Record<string, unknown> => requireRecord(modelCodec(Item).fromWireFormat({ value: wire }, { validate: false }), 'item');
    const rows = [item('hi'), item([1, 2]), item(null), item({ kind: 'a', x: 1 }), item({ kind: 'c' }), item(money)];
    assert.deepEqual(rows.map(row => modelCodec(row).toWireFormat(row)), [{ value: 'hi' }, { value: [1, 2] }, { value: null }, { value: { kind: 'a', x: 1 } }, { value: { kind: 'c' } }, { value: money }]);
    assert.deepEqual(rows.map(row => JSON.parse(codec.stringify(row, options))), [{ value: 'hi' }, { value: [1, 2] }, { value: null }, { value: { kind: 'a', x: 1 } }, { value: { kind: 'c' } }, { value: money }]);
    // An unknown tag takes the default, which keeps the fields of Money.
    assert.equal(requireRecord(item({ kind: 'zzz', ...money }).value, 'value').amount, 5);
  });
}

// Every Money field is optional and Money states no additionalProperties: false, so an instance of another variant's class fits the default's document.
const LOOSE_MONEY_DOCUMENT = OPEN_MONEY_DOCUMENT.replace(/ {6}required: \[amount, currency\]\n/, '');

/** A project whose TItem model holds `value` of `valueType` beside the model classes Email and Item, built; Money from `document` is imported when given. */
async function buildEmailItem(t: TestContext, prefix: string, validation: boolean, valueType: string, document?: string) {
  const { root, sourceRoot } = createModelProject(t, { prefix: `golem-${prefix}-`, name: prefix, linkWorkspaceNodeModules: true });
  if (document !== undefined) await writeMoneySdk(sourceRoot, validation, document);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
${document === undefined ? '' : "import type { Money } from './sdk/index.js';\n"}import { TItemBaseModel, TEmailBaseModel } from './item.model.generated.js';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export type TItem = IModel<{ value: ${valueType} }>;
export class Email extends TEmailBaseModel {}
export class Item extends TItemBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  const { Item, Email } = requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.js')).href), 'item') as Record<string, new () => Record<string, unknown>>;
  const itemOf = (fields: Record<string, unknown>): Record<string, unknown> => Object.assign(new Item(), { value: Object.assign(new Email(), fields) });
  return { codec: requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem')), Item, itemOf };
}

test('an open declared default does not take an instance of another variant\'s class that carries no tag', async (t) => {
  // protects: T-605 a tag-less TEmail instance is judged as a TEmail and rejected for its missing tag (F-39), not passed by the open default Money
  const { codec, Item, itemOf } = await buildEmailItem(t, 'declared-instance', true, "(TEmail | TPhone | Money) & Discriminator<'kind', Money>", LOOSE_MONEY_DOCUMENT);
  const problems = async (item: Record<string, unknown>): Promise<number> => (await validateInstance(item)).length;
  assert.equal(await problems(itemOf({ address: 5 })), 1, 'a tag-less TEmail with a wrong address');
  assert.equal(await problems(itemOf({})), 1, 'a tag-less TEmail without its address');
  assert.equal(await problems(itemOf({ address: 'a@b.c' })), 1, 'a TEmail needs its tag, as in a union with no default');
  assert.equal(await problems(itemOf({ kind: 'email', address: 'a@b.c' })), 0, 'a valid tagged TEmail');
  assert.equal(await problems(Object.assign(new Item(), { value: { amount: 5 } })), 0, 'a plain default value');
  const badItem = itemOf({ address: 5 });
  assert.equal(await getValidator(badItem).validate(badItem), false);
  assert.throws(() => codec.stringify(badItem, { validate: true }), /Model validation failed/);
});

test('a writer tells a model instance by its class before its tag, with validation off', async (t) => {
  // protects: T-605 stringify and toWireFormat wrote a tag-less TEmail instance as the default and an instance tagged as TPhone as a TPhone; encode wrote the first as TEmail and rejected the second
  const { codec, itemOf } = await buildEmailItem(t, 'declared-writer', false, "(TEmail | TPhone | Money) & Discriminator<'kind', Money>", LOOSE_MONEY_DOCUMENT);
  const tagless = itemOf({ address: 'a@b.c' });
  assert.equal(codec.stringify(tagless), '{"value":{"kind":"email","address":"a@b.c"}}');
  assert.deepEqual(codec.toWireFormat(tagless), { value: { kind: 'email', address: 'a@b.c' } });
  assert.deepEqual(modelCodec(tagless).toWireFormat(tagless), { value: { kind: 'email', address: 'a@b.c' } });
  assert.equal(codec.stringify(itemOf({ kind: 'email', address: 'a@b.c' })), '{"value":{"kind":"email","address":"a@b.c"}}');
  const other = itemOf({ kind: 'phone', address: 'a@b.c' });
  assert.throws(() => modelCodec(other).toWireFormat(other), /Unknown kind discriminator value: "phone"/);
  assert.throws(() => codec.stringify(other), /Unknown kind discriminator value: "phone"/);
  assert.throws(() => codec.toWireFormat(other), /Unknown kind discriminator value: "phone"/);
});

// The second shape makes the variants file and the item file one import cycle.
for (const [shape, back, owner] of [
  ['a file that imports nothing back', '', ''],
  ['a file in an import cycle', "import type { TItem } from './item.model.js';\n", '; owner?: TItem'],
] as const) {
  test(`a writer tells an instance of a variant model from ${shape} by its class, with validation off`, async (t) => {
    // protects: T-618 (F-39) the writers test the class of a variant model from another file, as for a local one: a tag-less instance of it is written as that variant, not rejected
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-imported-', name: 'declared-imported', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, {
      'variants.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
${back}export type TEmail = IModel<{ kind: 'email'; address: string${owner} }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
`,
      'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { TEmail, TPhone } from './variants.model.js';
export type TItem = IModel<{ value: (TEmail | TPhone) & ${TAG} }>;
`,
    });
    writeModelGolemYaml(root, { mobx: false, validation: false });
    await buildModelProject(root);
    const load = async (name: string) => requireRecord(await import(pathToFileURL(path.join(root, name)).href), name);
    const Email = (await load('build/variants.model.generated.js')).TEmailBaseModel as new () => Record<string, unknown>;
    const Item = (await load('build/item.model.generated.js')).TItemBaseModel as new () => Record<string, unknown>;
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
    const tagless = Object.assign(new Item(), { value: Object.assign(new Email(), { address: 'a@b.c' }) });
    assert.deepEqual(modelCodec(tagless).toWireFormat(tagless), { value: { kind: 'email', address: 'a@b.c' } });
    assert.equal(codec.stringify(tagless), '{"value":{"kind":"email","address":"a@b.c"}}');
    assert.deepEqual(codec.toWireFormat(tagless), { value: { kind: 'email', address: 'a@b.c' } });
  });
}

for (const validation of [false, true]) {
  test(`a Date beside tagged models is written as a date, not sent to the tag test, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: a Date value (QA trace on the tagged-union writers): a Date value of a union beside tagged models threw "Unknown kind discriminator value: undefined" in encode and stringify (a Date is an object, so it reached the tag chain)
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-date-', name: 'declared-date', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, {
      'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export type TItem = IModel<{ tagged: (TEmail | TPhone | Date) & ${TAG}; untagged: TEmail | Date | string[] }>;
`,
    });
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const Item = (requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.generated.js')).href), 'item')).TItemBaseModel as new () => Record<string, unknown>;
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TItem'));
    const item = Object.assign(new Item(), { tagged: new Date(DAY), untagged: new Date(DAY) });
    const wire = { tagged: DAY, untagged: DAY };
    assert.deepEqual(modelCodec(item).toWireFormat(item), wire);
    assert.equal(codec.stringify(item), JSON.stringify(wire));
    assert.deepEqual(codec.toWireFormat(item), wire);
  });
}

test('the shared selector variable survives a tagged union nested in a branch and a serde that encodes the same union during dispatch', async (t) => {
  // protects: T-617 re-entrancy - the writers of a file share one index variable, so a union that runs inside a branch arm must not change the choice of the outer one
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-reentry-', name: 'declared-reentry', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'wrap.ts': `import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
export class Wrap {
  constructor(readonly inner: object) {}
  show(): string { return 'wrap'; }
}
export function encodeWrap(value: Wrap): string { return JSON.stringify(requireObjectCodec(findGeneratedModelDefinition(value.inner)!.codecId!).toWireFormat(value.inner)); }
export function decodeWrap(value: string): Wrap { return new Wrap(JSON.parse(value) as object); }
`,
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
import { Wrap, encodeWrap, decodeWrap } from './wrap.js';
type Wrapped = Wrap & TSerde<typeof encodeWrap, typeof decodeWrap>;
export type TLeaf = IModel<{ kind: 'leaf' }>;
export type TTwig = IModel<{ kind: 'twig' }>;
export type TAlpha = IModel<{ kind: 'a'; parts: ((TLeaf | TTwig) & ${TAG})[]; wrapped: Wrapped }>;
export type TBeta = IModel<{ kind: 'b' }>;
export type TRoot = IModel<{ value: (TAlpha | TBeta) & ${TAG} }>;
export type TInner = IModel<{ value: (TAlpha | TBeta) & ${TAG} }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const bases = requireRecord(await import(pathToFileURL(path.join(root, 'build/item.model.generated.js')).href), 'item companion');
  const make = (name: string, values: object): object => Object.assign(new (bases[name] as new () => object)(), values);
  const Wrap = requireRecord(await import(pathToFileURL(path.join(root, 'build/wrap.js')).href), 'wrap').Wrap as new (inner: object) => object;
  const inner = make('TInnerBaseModel', { value: make('TBetaBaseModel', {}) });
  const alpha = make('TAlphaBaseModel', { parts: [make('TLeafBaseModel', {}), make('TTwigBaseModel', {})], wrapped: new Wrap(inner) });
  const item = make('TRootBaseModel', { value: alpha });
  const wire = { value: { kind: 'a', parts: [{ kind: 'leaf' }, { kind: 'twig' }], wrapped: '{"value":{"kind":"b"}}' } };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TRoot'));
  assert.deepEqual(modelCodec(item).toWireFormat(item), wire);
  assert.equal(codec.stringify(item), JSON.stringify(wire));
  assert.deepEqual(codec.toWireFormat(item), wire);
});

test('a validating companion writes the tag of a tag-less instance once when validation is turned off for the call', async (t) => {
  // protects: T-605 the strict Core writes its literal tag itself, so the class branch must not inject it a second time
  const { codec, itemOf } = await buildEmailItem(t, 'declared-strict', true, `(TEmail | TPhone) & ${TAG}`);
  assert.equal(codec.stringify(itemOf({ address: 'a@b.c' }), { validate: false }), '{"value":{"kind":"email","address":"a@b.c"}}');
});

for (const validation of [false, true]) {
  test(`a tagged union of IObject models builds and writes, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-605 an IObject variant has no generated class, so the writers of a tagged union must not test an instance against one
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-object-', name: 'declared-object', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, {
      'variants.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
`,
      'contact.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { TPhone } from './variants.model.js';
export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TContact = IObject<{ value: (TEmail | TPhone) & Discriminator<'kind'> }>;
`,
    });
    const codecs = await buildContactCodecs(root, validation);
    const options = { validate: validation };
    for (const value of [{ kind: 'email', address: 'a@b.c' }, { kind: 'phone', number: '5' }]) {
      assert.equal(codecs.stringifyTContact({ value }, options), JSON.stringify({ value }));
      assert.deepEqual(codecs.toWireFormatTContact({ value }, options), { value });
    }
  });
}

for (const validation of [false, true]) {
  test(`a TSerde class value such as URL sits beside a tagged union, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-637 a TSerde class value is a scalar variant beside tagged objects, as a Date is (it stopped generation with RUNM1082)
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-url-', name: 'declared-url', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, {
      'codecs.ts': `export function encodeUrl(value: URL): string { return value.href; }
export function decodeUrl(value: string): URL { return new URL(value); }
`,
      'contact.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
import { encodeUrl, decodeUrl } from './codecs.js';
type Link = URL & TSerde<typeof encodeUrl, typeof decodeUrl>;
export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{
  value: (Link | TEmail | TPhone) & ${TAG};
  beside: Link | ((TEmail | TPhone) & ${TAG});
  maybe: ((Link | TEmail | TPhone) & ${TAG}) | null;
}>;
`,
    });
    const codecs = await buildContactCodecs(root, validation);
    const options = { validate: validation };
    const href = 'https://example.com/a?b=1';
    const email = { kind: 'email', address: 'a@b.c' };
    const wires = [
      { value: href, beside: href, maybe: null },
      { value: email, beside: email, maybe: href },
      { value: { kind: 'phone', number: '5' }, beside: href, maybe: email },
    ];
    for (const wire of wires) {
      const model = requireRecord(codecs.fromWireFormatTContact(wire, options), 'contact');
      assert.equal(model.value instanceof URL, typeof wire.value === 'string', `validation=${validation}: value of ${JSON.stringify(wire)}`);
      assert.equal(model.beside instanceof URL, typeof wire.beside === 'string');
      assert.equal(model.maybe instanceof URL, typeof wire.maybe === 'string');
      assert.deepEqual(codecs.toWireFormatTContact(model, options), wire);
      assert.deepEqual(JSON.parse(codecs.stringifyTContact(model, options) as string), wire);
      assert.deepEqual(codecs.toWireFormatTContact(codecs.parseTContact(JSON.stringify(wire), options), options), wire);
    }
    if (validation) assert.throws(() => codecs.fromWireFormatTContact({ ...wires[0], value: 5 }, options));
    const unknownTag = { ...wires[0], value: { kind: 'fax' } };
    assert.throws(() => codecs.fromWireFormatTContact(unknownTag, options), (error: { issues?: { code: string; path: string[] }[] }) =>
      (validation ? error.issues?.[0].code === 'union' && error.issues[0].path.join('.') === 'value' : error.issues?.[0].path.join('.') === 'value.kind'));
  });
}

for (const validation of [false, true]) {
  test(`a Date sits beside a tagged union and round-trips, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-637 docs/guide/field-types.md says a Date may sit beside tagged objects
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-date-', name: 'declared-date', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, {
      'contact.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{ value: (Date | TEmail | TPhone) & ${TAG} }>;
`,
    });
    const codecs = await buildContactCodecs(root, validation);
    const options = { validate: validation };
    const at = '2020-01-02T03:04:05.000Z';
    for (const wire of [{ value: at }, { value: { kind: 'email', address: 'a@b.c' } }, { value: { kind: 'phone', number: '5' } }]) {
      const model = requireRecord(codecs.fromWireFormatTContact(wire, options), 'contact');
      assert.equal(model.value instanceof Date, typeof wire.value === 'string');
      assert.deepEqual(codecs.toWireFormatTContact(model, options), wire);
      assert.deepEqual(JSON.parse(codecs.stringifyTContact(model, options) as string), wire);
    }
  });
}

test('a model instance and an object with no prototype keep their tag beside a URL class value', async (t) => {
  // protects: T-637 beside a class value, the write path tells a variant object (a model instance, a plain or prototype-less object) from the class instance
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-url-model-', name: 'declared-url-model', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'codecs.ts': `export function encodeUrl(value: URL): string { return value.href; }
export function decodeUrl(value: string): URL { return new URL(value); }
`,
    'contact.model.ts': `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
import { TEmailBaseModel } from './contact.model.generated.js';
import { encodeUrl, decodeUrl } from './codecs.js';
type Link = URL & TSerde<typeof encodeUrl, typeof decodeUrl>;
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{ value: (Link | TEmail | TPhone) & ${TAG} }>;
export class Email extends TEmailBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const companion = await import(pathToFileURL(path.join(root, 'build/contact.model.generated.js')).href) as Record<string, (value: unknown, options?: object) => unknown>;
  const { Email } = await import(pathToFileURL(path.join(root, 'build/contact.model.js')).href) as { Email: new (values: object) => object };
  const bare = Object.assign(Object.create(null) as object, { kind: 'phone', number: '5' });
  const href = 'https://example.com/a?b=1';
  const cases = [
    { value: new Email({ kind: 'email', address: 'a@b.c' }), wire: { kind: 'email', address: 'a@b.c' } },
    { value: bare, wire: { kind: 'phone', number: '5' } },
    { value: new URL(href), wire: href },
  ];
  for (const { value, wire } of cases) {
    assert.deepEqual(companion.toWireFormatTContact({ value }, { validate: true }), { value: wire });
    assert.deepEqual(JSON.parse(companion.stringifyTContact({ value }, { validate: true }) as string), { value: wire });
    const decoded = requireRecord(companion.fromWireFormatTContact({ value: wire }, { validate: true }), 'contact');
    assert.deepEqual(companion.toWireFormatTContact(decoded, { validate: true }), { value: wire });
  }
  assert.deepEqual({ ...requireRecord(requireRecord(companion.fromWireFormatTContact({ value: cases[0].wire }, { validate: true }), 'contact').value, 'email') }, cases[0].wire);
  assert.ok(requireRecord(companion.fromWireFormatTContact({ value: href }, { validate: true }), 'contact').value instanceof URL);
});

for (const validation of [true, false]) {
  test(`a deserializer of a class value beside tagged objects that throws on its wire value gives a LibError, with validation ${validation ? 'on' : 'off'}`, async (t) => {
    // protects: T-637 the deserializer of a TSerde class value in a tagged union is wrapped like one on a plain field (a LibError of the field, not a raw TypeError)
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-url-reject-', name: 'declared-url-reject', linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, {
      'codecs.ts': `export function encodeUrl(value: URL): string { return value.href; }
export function decodeUrl(value: string): URL { return new URL(value); }
`,
      'contact.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
import { encodeUrl, decodeUrl } from './codecs.js';
type Link = URL & TSerde<typeof encodeUrl, typeof decodeUrl>;
export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{ beside: Link | ((TEmail | TPhone) & ${TAG}) }>;
`,
    });
    const codecs = await buildContactCodecs(root, validation);
    assert.throws(
      () => codecs.fromWireFormatTContact({ beside: 'not a url' }, { validate: validation }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization && !error.causedByInput && error.issues[0]?.path.join('.') === 'beside',
    );
  });
}

test('a TSerde class value written as an object beside tagged objects stops with RUNM1082', async (t) => {
  // protects: T-637 only a class value with a scalar JSON form sits beside tagged objects; an object wire is ambiguous with them
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-declared-url-object-', name: 'declared-url-object', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'codecs.ts': `export function encodeUrl(value: URL): { href: string } { return { href: value.href }; }
export function decodeUrl(value: { href: string }): URL { return new URL(value.href); }
`,
    'contact.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
import { encodeUrl, decodeUrl } from './codecs.js';
type Link = URL & TSerde<typeof encodeUrl, typeof decodeUrl>;
export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
export type TContact = IObject<{ value: (Link | TEmail | TPhone) & ${TAG} }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await assert.rejects(buildModelProject(root), /RUNM1082/);
});
