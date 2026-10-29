import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { requireRecord, type GeneratedModelClass } from './openapi/helpers.js';
import { modelCodec } from './support/model-codec.js';

const HEAD = `import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator, TSerde } from '@exprtlabs/golem/tags';
`;

for (const validation of [false, true]) {
  const profile = { mobx: false, validation };
  const when = `with validation ${validation ? 'on' : 'off'}`;

  test(`a variant made of several parts prints without the Discriminator tag in the diagnostic, ${when}`, t => {
    // protects: fixed bug (bug-sweep 3, finding 2) RUNM1087 printed `Base & {...} & Discriminator<"kind">` for a variant that is an intersection
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sweep3a-', name: 'variant-text' });
    writeModelSources(sourceRoot, { 'bad.model.ts': `${HEAD}type Base = { id: string };
type Cat = Base & { name: string };
type Dog = { kind: 'dog' };
export type TBox = IModel<{ pet: (Cat | Dog) & Discriminator<'kind'> }>;
` });
    assert.throws(() => generate({ root, profile }), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /RUNM1087: Union variant (Base & \{ name: string; \}|\{ name: string; \} & Base) in TBox has no required literal property "kind"/);
      assert.equal(message.includes('Discriminator<"kind">'), false);
      return true;
    });
  });

  for (const [name, union, text] of [
    ['a date', "(Click | Key | Date) & Discriminator<'kind', Date>", 'Date'],
    ['a string', "(Click | Key | string) & Discriminator<'kind', string>", 'string'],
  ] as const) {
    test(`a default that is ${name} stops generation with RUNM1051, ${when}`, t => {
      // protects: fixed bug (bug-sweep 3, finding 3) a non-object default decoded a date as a string and threw on encode
      const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sweep3a-', name: 'scalar-default' });
      writeModelSources(sourceRoot, { 'bad.model.ts': `${HEAD}type Click = { kind: 'click'; x: number };
type Key = { kind: 'key'; code: string };
export type TBox = IModel<{ value: ${union} }>;
` });
      assert.throws(() => generate({ root, profile }), new RegExp(
        `bad\\.model\\.ts:\\d+:\\d+ RUNM1051: Discriminator<'kind', ${text}> in TBox names a default that is no object\\. `
        + 'The default is the object variant that has no tag; a scalar, array or null variant is chosen by its JSON type, so name an object variant or remove the default\\.',
      ));
    });
  }
}

test('a tag written alone in a type alias stops with RUNM1045 like every other tag', t => {
  // protects: refusal (bug-sweep 3, finding 1) an alias of a bare tag is refused for each tag; a generic wrapper `U & Tag` is the way
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sweep3a-', name: 'tag-alias' });
  writeModelSources(sourceRoot, { 'bad.model.ts': `${HEAD}type Tag = Discriminator<'kind'>;
export type TCat = IModel<{ kind: 'cat' }>;
export type TDog = IModel<{ kind: 'dog' }>;
export type TBox = IModel<{ value: (TCat | TDog) & Tag }>;
` });
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /bad\.model\.ts:\d+:\d+ RUNM1045: Discriminator<'kind'> must be intersected with a model value type\./);
});

test('a tag in a generic wrapper alias still decodes the variants to their models', async t => {
  // protects: finding 1 (bug-sweep 3) the supported alias form `type Tagged<U> = U & Discriminator<'kind'>` drives conversion
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sweep3a-', name: 'tag-wrapper', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'a.model.ts': `${HEAD}import { TABaseModel, TCatBaseModel } from './a.model.generated.js';
type Tagged<U> = U & Discriminator<'kind'>;
export type TCat = IModel<{ kind: 'cat'; lives: number }>;
export type TDog = IModel<{ kind: 'dog'; bark: string }>;
export type TA = IModel<{ value: Tagged<TCat | TDog> }>;
export class Cat extends TCatBaseModel {}
export class A extends TABaseModel {}
` });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const models = requireRecord(await import(pathToFileURL(path.join(root, 'build/a.model.js')).href), 'a');
  const decoded = requireRecord(modelCodec(models.A as GeneratedModelClass).fromWireFormat({ value: { kind: 'cat', lives: 9 } }), 'a');
  assert.ok(decoded.value instanceof (models.Cat as new () => object));
});

test('a serde scalar beside null decodes null as null, with and without a tagged union', async t => {
  // protects: fixed bug (bug-sweep 3, finding 4) the serde converter ran on null: readAmount(null) gave 0
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sweep3a-', name: 'serde-null', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'codecs.ts': `export const writeAmount = (amount: number): string => amount.toFixed(2);
export const readAmount = (text: string): number => Number(text);
`,
    'a.model.ts': `${HEAD}import { TABaseModel } from './a.model.generated.js';
import type { writeAmount, readAmount } from './codecs.js';
type Amount = number & TSerde<typeof writeAmount, typeof readAmount>;
export type TCat = IModel<{ kind: 'cat'; lives: number }>;
export type TDog = IModel<{ kind: 'dog'; bark: string }>;
export type TA = IModel<{ plain: Amount | boolean[] | null; tagged: ((TCat | TDog) & Discriminator<'kind'>) | Amount | null }>;
export class A extends TABaseModel {}
` });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const models = requireRecord(await import(pathToFileURL(path.join(root, 'build/a.model.js')).href), 'a');
  const A = models.A as GeneratedModelClass;
  const nulls = requireRecord(modelCodec(A).fromWireFormat({ plain: null, tagged: null }), 'a');
  assert.deepEqual([nulls.plain, nulls.tagged], [null, null]);
  const amounts = requireRecord(modelCodec(A).fromWireFormat({ plain: '12.50', tagged: '3.00' }), 'a');
  assert.deepEqual([amounts.plain, amounts.tagged], [12.5, 3]);
});
