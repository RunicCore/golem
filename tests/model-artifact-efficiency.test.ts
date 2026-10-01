import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { deduplicateTagSchemas, type TagSchema } from '#model/emit';
import { generate } from '#model/generator';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject, type ModelProject } from './model-project.js';
import { duplicateLocalNameReferenceModelSource } from './fixture-templates/models/model-artifact-efficiency.js';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { IssueCode, IssueRepresentation, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { findCodecIdForConstructor, requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { generatedCodecIdFromRoot } from './support/consumer.js';

function fixture(t: TestContext, options: { readonly noUnusedLocals?: boolean } = {}) {
  return createModelProject(t, {
    prefix: 'golem-model-efficiency-',
    name: 'model-efficiency',
    ...(options.noUnusedLocals ? { compilerOptions: { noUnusedLocals: true } } : {}),
  });
}

function copyStandalone(result: ReturnType<typeof generate>, fixtureValue: ModelProject): void {
  const artifact = result.artifacts.find((item) => item.path.endsWith('/models.validators.generated.js'));
  assert.ok(artifact, 'standalone validator artifact');
  const target = path.join(fixtureValue.root, 'build', path.relative(fixtureValue.sourceRoot, artifact.path));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(artifact.path, target);
}

test('equivalent tag schemas share compilation while metadata and callback identities stay distinct', () => {
  const schemas: TagSchema[] = [
    { key: 'number:first', id: 'legacy:first', schema: { type: 'number' } },
    { key: 'number:second', id: 'legacy:second', schema: { type: 'number' } },
    {
      key: 'callback:first',
      id: 'legacy:callback:first',
      schema: { exprtValidation: { schema: { type: 'number' }, bindings: ['callback:first'] } },
    },
    {
      key: 'callback:second',
      id: 'legacy:callback:second',
      schema: { exprtValidation: { schema: { type: 'number' }, bindings: ['callback:second'] } },
    },
    {
      key: 'reference:number',
      id: 'legacy:reference:number',
      schema: { $ref: '#/$defs/Value', $defs: { Value: { type: 'number' } } },
    },
    {
      key: 'reference:string',
      id: 'legacy:reference:string',
      schema: { $ref: '#/$defs/Value', $defs: { Value: { type: 'string' } } },
    },
  ];
  const compilations = deduplicateTagSchemas(schemas);
  assert.equal(compilations.length, 5);
  const number = compilations.find((item) => item.keys.includes('number:first'));
  assert.ok(number);
  assert.deepEqual(number.keys, ['number:first', 'number:second']);
  assert.equal(compilations.filter((item) => item.keys.some((key) => key.startsWith('callback:'))).length, 2);
  assert.equal(compilations.filter((item) => item.keys.some((key) => key.startsWith('reference:'))).length, 2);
  assert.throws(
    () => deduplicateTagSchemas([...schemas, { key: 'number:first', id: 'conflict', schema: { type: 'string' } }]),
    /Conflicting generated tag schema/,
  );
});

test('codec Ajv compiles equivalent MinLength tags in each companion', async (t) => {
  for (const ajvStandalone of [false, true] as const) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async (profileTest) => {
      const fixtureValue = fixture(profileTest);
      const source = path.join(fixtureValue.sourceRoot, 'item.model.ts');
      writeFileSync(source, readFixture('models/model-artifact-efficiency/codec-ajv-compiles-equivalent-minlength-tags-in-each-companion/item.model.ts'));
      writeFileSync(path.join(fixtureValue.sourceRoot, 'other.model.ts'), readFixture("models/model-artifact-efficiency/codec-ajv-compiles-equivalent-minlength-tags-in-each-companion/other.model.ts"));
      const result = generate({ root: fixtureValue.root, profile: { mobx: false, validation: true, ajvStandalone } });
      writeGeneratedArtifacts(result.artifacts);
      const generated = result.artifacts.map((item) => item.content).join('\n');
      if (ajvStandalone) {
        assert.match(generated, /createValidatorSet\(/, 'standalone validators are created as a shared set');
        assert.doesNotMatch(
          generated,
          /createOpenApi(?:Sync)?AjvEngine/,
          'standalone codecs bind to precompiled validators instead of importing a runtime Ajv engine',
        );
      } else {
        assert.equal((generated.match(/createOpenApiSyncAjvEngine\(\{ allErrors: false/g) ?? []).length, 2, 'one fast sync engine per companion');
      }
      await compileModelProject(fixtureValue.root);
      if (ajvStandalone) copyStandalone(result, fixtureValue);
      const { Item } = await import(`${pathToFileURL(path.join(fixtureValue.root, 'build/item.model.js')).href}?${ajvStandalone}`) as {
        Item: new (values?: { value?: string; extra?: string }) => { value: string; extra: string };
      };
      const { getValidator } = await import('@exprtlabs/golem/validation');
      const valid = new Item({ value: 'ab', extra: 'wxyz' });
      const invalid = new Item({ value: 'x', extra: 'wxyz' });
      assert.equal(await getValidator(valid).validate(), true);
      assert.equal(await getValidator(invalid).validate(), false);
      assert.strictEqual(getValidator(valid), getValidator(valid));
      for (const [field, badValue] of [['value', 'x'], ['extra', 'xyz']] as const) {
        const bad = new Item({ value: 'ab', extra: 'wxyz', [field]: badValue });
        const validator = getValidator(bad);
        assert.equal(await validator.validate(), false, `${field} enforces its own MinLength bound`);
        assert.deepEqual(validator.issues.map((issue: { path: readonly (string | number)[] }) => issue.path), [[field]]);
      }
    });
  }
});

test('standalone validator bindings survive strict companion regeneration', async (t) => {
  const fixtureValue = fixture(t, { noUnusedLocals: true });
  const source = path.join(fixtureValue.sourceRoot, 'cart.model.ts');
  writeFileSync(path.join(fixtureValue.sourceRoot, 'rules.ts'), readFixture('models/model-artifact-efficiency/standalone-validator-regeneration/rules.ts'));
  writeFileSync(source, readFixture('models/model-artifact-efficiency/standalone-validator-regeneration/cart-initial.model.ts'));
  const profile = { mobx: false, validation: true, ajvStandalone: true } as const;

  // The first pass emits the base class. Adding the handwritten class mirrors
  // consumer use and forces prospective validation on the second generation.
  const first = generate({ root: fixtureValue.root, profile });
  writeGeneratedArtifacts(first.artifacts);
  writeFileSync(source, readFixture('models/model-artifact-efficiency/standalone-validator-regeneration/cart.model.ts'));
  const regenerated = generate({ root: fixtureValue.root, profile });
  writeGeneratedArtifacts(regenerated.artifacts);

  await compileModelProject(fixtureValue.root);
  copyStandalone(regenerated, fixtureValue);
  const { Cart } = await import(pathToFileURL(path.join(fixtureValue.root, 'build/cart.model.js')).href);
  assert.equal(await getValidator(new Cart({ count: 2 })).validate(), true);
  assert.equal(await getValidator(new Cart({ count: 3 })).validate(), false, 'custom predicate rejects values accepted by Minimum');
  assert.equal(await getValidator(new Cart({ count: 0 })).validate(), false, 'Minimum constraint remains active');
});

test('wire-only serde predicates do not create model-plane tag validators', async (t) => {
  const fixtureValue = fixture(t);
  mkdirSync(fixtureValue.sourceRoot, { recursive: true });
  writeFileSync(path.join(fixtureValue.sourceRoot, 'codecs.ts'), readFixture("models/model-artifact-efficiency/wire-only-serde-predicates-do-not-create-model-plane-tag-validators/codecs.ts"));
  writeFileSync(path.join(fixtureValue.sourceRoot, 'item.model.ts'), readFixture("models/model-artifact-efficiency/wire-only-serde-predicates-do-not-create-model-plane-tag-validators/item.model.ts"));
  const result = generate({ root: fixtureValue.root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(fixtureValue.root);
  const { Item } = await import(pathToFileURL(path.join(fixtureValue.root, 'build/item.model.js')).href) as {
    Item: new (values?: { value?: number }) => { value: number };
  };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(fixtureValue.root, 'Item'));
  const model = new Item({ value: -5 });
  assert.equal(codec.validate(model), true, 'the model-plane number field carries no tag validator derived from the wire-only predicate');
  assert.throws(
    () => codec.parse(JSON.stringify({ value: '' })),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues.some((issue) => issue.code === IssueCode.Custom
        && issue.representation === IssueRepresentation.Wire
        && issue.path.join('.') === 'value'),
    'the wire-plane predicate still rejects an invalid wire string on decode',
  );
});

test('generated tag schemas retain distinct reference closures for duplicate local names', async (t) => {
  const fixtureValue = fixture(t);
  for (const directory of ['one', 'two']) mkdirSync(path.join(fixtureValue.sourceRoot, directory), { recursive: true });
  writeFileSync(path.join(fixtureValue.sourceRoot, 'one/things.model.ts'), duplicateLocalNameReferenceModelSource({ valueType: 'string' }).text);
  writeFileSync(path.join(fixtureValue.sourceRoot, 'two/things.model.ts'), duplicateLocalNameReferenceModelSource({ valueType: 'number' }).text);

  const result = generate({ root: fixtureValue.root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(fixtureValue.root);
  const [
    { Parent: OneParent, Child: OneChild },
    { ParentBaseModel: OneParentBaseModel },
    { Parent: TwoParent, Child: TwoChild },
    { ParentBaseModel: TwoParentBaseModel },
  ] = await Promise.all([
    import(pathToFileURL(path.join(fixtureValue.root, 'build/one/things.model.js')).href),
    import(pathToFileURL(path.join(fixtureValue.root, 'build/one/things.model.generated.js')).href),
    import(pathToFileURL(path.join(fixtureValue.root, 'build/two/things.model.js')).href),
    import(pathToFileURL(path.join(fixtureValue.root, 'build/two/things.model.generated.js')).href),
  ]) as [
    { Parent: new (values?: never) => object; Child: new (values?: never) => object },
    { ParentBaseModel: abstract new (...args: never[]) => object },
    { Parent: new (values?: never) => object; Child: new (values?: never) => object },
    { ParentBaseModel: abstract new (...args: never[]) => object },
  ];
  const oneCodecId = findCodecIdForConstructor(OneParentBaseModel);
  const twoCodecId = findCodecIdForConstructor(TwoParentBaseModel);
  assert.ok(oneCodecId, 'the "one" Parent model has a registered codec id');
  assert.ok(twoCodecId, 'the "two" Parent model has a registered codec id');
  const oneCodec = requireObjectCodec(oneCodecId);
  const twoCodec = requireObjectCodec(twoCodecId);

  const oneValid = new OneParent({ children: [new OneChild({ value: 'a' } as never)] } as never);
  assert.equal(oneCodec.validate(oneValid), true, 'the "one" Contains schema accepts a matching string child');
  const oneInvalid = new OneParent({ children: [{ value: 5 }] } as never);
  assert.equal(oneCodec.validate(oneInvalid), false, 'the "one" Contains schema still requires string children');

  const twoValid = new TwoParent({ children: [new TwoChild({ value: 5 } as never)] } as never);
  assert.equal(twoCodec.validate(twoValid), true, 'the "two" Contains schema accepts a matching number child');
  const twoInvalid = new TwoParent({ children: [{ value: 'a' }] } as never);
  assert.equal(
    twoCodec.validate(twoInvalid),
    false,
    'the "two" Contains schema still requires number children, unaffected by the duplicate local name in "one"',
  );
});

for (const ajvStandalone of [false, true]) {
  test(`shared projection helpers retain distinct validators with standalone=${ajvStandalone}`, async t => {
    const value = fixture(t);
    writeFileSync(path.join(value.sourceRoot, 'item.model.ts'), readFixture("models/model-artifact-efficiency/model-artifact-efficiency-item-model/item.model.ts"));
    const result = generate({ root: value.root, profile: { mobx: false, validation: true, ajvStandalone } });
    writeGeneratedArtifacts(result.artifacts);
    const companion = result.artifacts.find(item => item.path.endsWith('/item.model.generated.ts'))?.content ?? '';
    assert.equal((companion.match(/function decodeShortPickValue\(/g) ?? []).length, 1);
    await compileModelProject(value.root);
    if (ajvStandalone) copyStandalone(result, value);
    const { Container } = await import(pathToFileURL(path.join(value.root, 'build/item.model.js')).href);
    const wire = { first: { value: 'a' }, second: { value: 'abc' } };
    const model = decodeGeneratedModel(Container, wire);
    assert.deepEqual(encodeGeneratedModel(model), wire);
    assert.equal(Object.getPrototypeOf(model.first), Object.prototype);
    assert.equal(await getValidator(new Container(wire)).validate(), true);
    const invalid = new Container({ first: { value: 'a' }, second: { value: 'ab' } });
    assert.equal(await getValidator(invalid).validate(), false);
    assert.deepEqual(getValidator(invalid).issues.map((issue: { path: readonly (string | number)[] }) => issue.path), [['second', 'value']]);
  });
}

test('validation-disabled serde artifacts omit executable predicate bindings', t => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'codecs.ts'), readFixture("models/model-artifact-efficiency/validation-disabled-serde-artifacts-omit-executable-predicate-bindings/codecs.ts"));
  writeFileSync(path.join(value.sourceRoot, 'item.model.ts'), readFixture("models/model-artifact-efficiency/validation-disabled-serde-artifacts-omit-executable-predicate-bindings/item.model.ts"));
  const result = generate({ root: value.root, profile: { mobx: false, validation: false } });
  const output = result.artifacts.filter(item => item.path.endsWith('.ts')).map(item => item.content).join('\n');
  assert.doesNotMatch(output, /modelValidationBindings|import\s*\{\s*accepts\b|\/validation['"]/);
  assert.match(output, /modelSerdeBindings/);
});
