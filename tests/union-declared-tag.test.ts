import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { generate } from '#model/generator';
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
      'a scalar variant beside the tagged objects',
      `${VARIANTS}export type TPhone = IModel<{ kind: 'phone'; added: Date }>;\nexport type TBox = IModel<{ value: (string | TEmail | TPhone) & ${TAG} }>;\n`,
      /bad\.model\.ts:\d+:\d+ RUNM1087: Union variant string in TBox has no required literal property "kind"/,
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
