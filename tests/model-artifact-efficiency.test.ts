import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { deduplicateTagSchemas, type TagSchema } from '#model/emit';
import { generate } from '#model/generator';
import { canonicalSchemaKey } from '@exprtlabs/golem/internal/schema';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources, type ModelProject } from './model-project.js';
import { duplicateLocalNameReferenceModelSource } from './fixture-templates/models/model-artifact-efficiency.js';
import { parse as parseYaml } from 'yaml';
import { loadGolemModeProject } from './openapi/sdk-client-fixture.js';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec, decodeGeneratedModelTrusted, findGeneratedModelDefinitionForConstructor } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator } from '@exprtlabs/golem/validation';
import { spyOnBuild } from './support/build-spy.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { modelCodec } from './support/model-codec.js';

function fixture(t: TestContext, options: { readonly noUnusedLocals?: boolean } = {}) {
  return createModelProject(t, {
    prefix: 'golem-model-efficiency-',
    name: 'model-efficiency',
    ...(options.noUnusedLocals ? { compilerOptions: { noUnusedLocals: true } } : {}),
  });
}

/** Builds the project without validation and records the calls its built modules make to the conversion exports `spied`. */
async function buildAndSpy(project: ModelProject, spied: readonly string[]): ReturnType<typeof spyOnBuild> {
  writeModelGolemYaml(project.root, { validation: false });
  await buildModelProject(project.root);
  return spyOnBuild(project.root, { '@exprtlabs/golem/internal/model-runtime': spied });
}

test('equivalent tag schemas share compilation while callback identities and reference definitions stay distinct', () => {
  // protects: F-164 equal tag schemas compile once, and callback and reference variants keep their own validator
  const tag = (schema: TagSchema['schema']): TagSchema => ({ key: canonicalSchemaKey(schema), schema });
  const number = { type: 'number' };
  const schemas = [
    tag(number),
    tag({ type: 'number' }),
    tag({ exprtValidation: { schema: number, bindings: ['callback:first'] } }),
    tag({ exprtValidation: { schema: number, bindings: ['callback:second'] } }),
    tag({ $ref: '#/$defs/Value', $defs: { Value: { type: 'number' } } }),
    tag({ $ref: '#/$defs/Value', $defs: { Value: { type: 'string' } } }),
  ];
  const compilations = deduplicateTagSchemas(schemas);
  assert.equal(compilations.length, 5);
  assert.deepEqual(compilations.map((item) => item.id), [0, 1, 2, 3, 4].map((index) => `golem:model-tag:${index}`));
  assert.equal(compilations.filter((item) => item.schema.exprtValidation !== undefined).length, 2);
  assert.equal(compilations.filter((item) => item.schema.$ref !== undefined).length, 2);
});

test('equivalent MinLength tags of two companions compile to one validators module and each keeps its own bound', async (t) => {
  const fixtureValue = fixture(t);
  const source = path.join(fixtureValue.sourceRoot, 'item.model.ts');
  writeFileSync(source, readFixture('models/model-artifact-efficiency/codec-compiles-equivalent-minlength-tags-in-each-companion/item.model.ts'));
  writeFileSync(path.join(fixtureValue.sourceRoot, 'other.model.ts'), readFixture("models/model-artifact-efficiency/codec-compiles-equivalent-minlength-tags-in-each-companion/other.model.ts"));
  writeModelGolemYaml(fixtureValue.root, { validation: true });
  await buildModelProject(fixtureValue.root);
  const artifacts = generatedModelFiles(fixtureValue.root);
  assert.equal(artifacts.filter((item) => item.path.endsWith('.validators.generated.ts')).length, 1, 'one validators module serves every companion');
  assert.equal(artifacts.filter((item) => item.path.endsWith('.model.generated.ts')).length, 2);
  const spy = await spyOnBuild(fixtureValue.root, {});
  let Item: new (values?: { value?: string; extra?: string }) => { value: string; extra: string };
  try {
    ({ Item } = await import(pathToFileURL(path.join(fixtureValue.root, 'build/item.model.js')).href));
    await import(pathToFileURL(path.join(fixtureValue.root, 'build/other.model.js')).href);
  } finally { spy.stop(); }
  assert.deepEqual(
    spy.requests.filter((request) => request.specifier.endsWith('models.validators.generated.js')).map((request) => request.importer).sort(),
    ['item.model.generated.js', 'other.model.generated.js'],
    'each companion loads the one validators module',
  );
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

test('validator bindings survive strict companion regeneration', async (t) => {
  const fixtureValue = fixture(t, { noUnusedLocals: true });
  const source = path.join(fixtureValue.sourceRoot, 'cart.model.ts');
  writeFileSync(path.join(fixtureValue.sourceRoot, 'rules.ts'), readFixture('models/model-artifact-efficiency/validator-regeneration/rules.ts'));
  writeFileSync(source, readFixture('models/model-artifact-efficiency/validator-regeneration/cart-initial.model.ts'));
  const profile = { validation: true } as const;

  // The first pass emits the base class. Adding the handwritten class mirrors
  // consumer use and forces prospective validation on the second generation.
  writeGeneratedArtifacts(generate({ root: fixtureValue.root, profile }).artifacts);
  writeFileSync(source, readFixture('models/model-artifact-efficiency/validator-regeneration/cart.model.ts'));

  // The build runs the models job, which regenerates the companions beside the existing ones.
  writeModelGolemYaml(fixtureValue.root, profile);
  await buildModelProject(fixtureValue.root);
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
  writeModelGolemYaml(fixtureValue.root, { validation: true });
  await buildModelProject(fixtureValue.root);
  const { Item } = await import(pathToFileURL(path.join(fixtureValue.root, 'build/item.model.js')).href) as {
    Item: new (values?: { value?: number }) => { value: number };
  };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(fixtureValue.root, 'TItem'));
  const model = new Item({ value: -5 });
  assert.equal(codec.validate(model), true, 'the model-plane number field carries no tag validator derived from the wire-only predicate');
  assert.throws(
    () => codec.parse(JSON.stringify({ value: '' })),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues.some((issue) => issue.code === 'custom'
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

  writeModelGolemYaml(fixtureValue.root, { validation: true });
  await buildModelProject(fixtureValue.root);
  const [
    { Parent: OneParent, Child: OneChild },
    { TParentBaseModel: OneParentBaseModel },
    { Parent: TwoParent, Child: TwoChild },
    { TParentBaseModel: TwoParentBaseModel },
  ] = await Promise.all([
    import(pathToFileURL(path.join(fixtureValue.root, 'build/one/things.model.js')).href),
    import(pathToFileURL(path.join(fixtureValue.root, 'build/one/things.model.generated.js')).href),
    import(pathToFileURL(path.join(fixtureValue.root, 'build/two/things.model.js')).href),
    import(pathToFileURL(path.join(fixtureValue.root, 'build/two/things.model.generated.js')).href),
  ]) as [
    { Parent: new (values?: never) => object; Child: new (values?: never) => object },
    { TParentBaseModel: abstract new (...args: never[]) => object },
    { Parent: new (values?: never) => object; Child: new (values?: never) => object },
    { TParentBaseModel: abstract new (...args: never[]) => object },
  ];
  const oneCodecId = findGeneratedModelDefinitionForConstructor(OneParentBaseModel)?.codecId;
  const twoCodecId = findGeneratedModelDefinitionForConstructor(TwoParentBaseModel)?.codecId;
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

test('shared projection helpers retain distinct validators', async t => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'item.model.ts'), readFixture("models/model-artifact-efficiency/model-artifact-efficiency-item-model/item.model.ts"));
  writeModelGolemYaml(value.root, { validation: true });
  await buildModelProject(value.root);
  const companion = generatedModelFiles(value.root).find(item => item.path.endsWith('/item.model.generated.ts'))?.content ?? '';
  assert.equal((companion.match(/function decodeTShortPickValue\(/g) ?? []).length, 1);
  const { Container } = await import(pathToFileURL(path.join(value.root, 'build/item.model.js')).href);
  const wire = { first: { value: 'a' }, second: { value: 'abc' } };
  const model = modelCodec(Container).fromWireFormat(wire);
  assert.deepEqual(modelCodec(model).toWireFormat(model), wire);
  assert.equal(Object.getPrototypeOf(model.first), Object.prototype);
  assert.equal(await getValidator(new Container(wire)).validate(), true);
  const invalid = new Container({ first: { value: 'a' }, second: { value: 'ab' } });
  assert.equal(await getValidator(invalid).validate(), false);
  assert.deepEqual(getValidator(invalid).issues.map((issue: { path: readonly (string | number)[] }) => issue.path), [['second', 'value']]);
});

test('validation-disabled serde artifacts omit executable predicate bindings', async t => {
  // An import the companion does not use fails the strict unused compile.
  const value = fixture(t, { noUnusedLocals: true });
  writeFileSync(path.join(value.sourceRoot, 'codecs.ts'), readFixture("models/model-artifact-efficiency/validation-disabled-serde-artifacts-omit-executable-predicate-bindings/codecs.ts"));
  writeFileSync(path.join(value.sourceRoot, 'item.model.ts'), readFixture("models/model-artifact-efficiency/validation-disabled-serde-artifacts-omit-executable-predicate-bindings/item.model.ts"));
  writeModelGolemYaml(value.root, { validation: false });
  await buildModelProject(value.root);
  // The deployed codecs module has no predicate: a companion that still referenced it would not link.
  writeFileSync(path.join(value.root, 'build/codecs.js'), 'export const encode = (value) => String(value);\nexport const decode = (value) => Number(value);\n');
  const { Item } = await import(pathToFileURL(path.join(value.root, 'build/item.model.js')).href);
  const item = new Item({ value: -5 });
  assert.deepEqual(modelCodec(item).toWireFormat(item), { value: '-5' });
  assert.equal(modelCodec(Item).fromWireFormat({ value: '7' }).value, 7);
  const codec = requireObjectCodec<{ value: number }>(generatedCodecIdFromRoot(value.root, 'TItem'));
  assert.equal(codec.stringify(item), '{"value":"-5"}');
  assert.equal(codec.parse('{"value":"7"}').value, 7);
  assert.throws(() => getValidator(item), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable);
});

test('array item models validate at their full path, recursive ones included', async (t) => {
  const fixtureValue = fixture(t);
  writeFileSync(path.join(fixtureValue.sourceRoot, 'company.model.ts'),
    readFixture('models/model-artifact-efficiency/array-items-inline/company.model.ts'));
  const profile = { validation: true } as const;
  writeModelGolemYaml(fixtureValue.root, profile);
  await buildModelProject(fixtureValue.root);
  const { Company, Node } = await import(pathToFileURL(path.join(fixtureValue.root, 'build/company.model.js')).href);
  const invalid = getValidator(new Company({
    departments: [{ title: 'R&D', employees: [{ name: 'a', age: 1 }, { name: '', age: 2 }] }],
  }));
  assert.equal(await invalid.validate(), false);
  assert.deepEqual(
    invalid.issues.map((issue: { path: readonly (string | number)[] }) => issue.path),
    [['departments', 0, 'employees', 1, 'name']],
    'the failing nested item keeps its full instance path',
  );
  assert.deepEqual(
    invalid.issues.map((issue: { source: IssueSource }) => issue.source),
    [IssueSource.TypeScript],
  );
  const tree = new Node({ label: 'a', children: [{ label: 'b', children: [{ label: 'c', children: [] }] }] });
  assert.equal(await getValidator(tree).validate(), true);
});

test('array item models that live in another file validate at their full path', async (t) => {
  const fixtureValue = fixture(t);
  for (const name of ['department', 'roster']) {
    writeFileSync(path.join(fixtureValue.sourceRoot, `${name}.model.ts`),
      readFixture(`models/model-artifact-efficiency/array-items-inline/cross-file/${name}.model.ts`));
  }
  writeModelGolemYaml(fixtureValue.root, { validation: true });
  await buildModelProject(fixtureValue.root);

  const { Roster } = await import(pathToFileURL(path.join(fixtureValue.root, 'build/roster.model.js')).href);
  const invalid = getValidator(new Roster({
    departments: [{ title: 'R&D', employees: [{ name: 'a', age: 1 }, { name: '', age: 2 }] }],
  }));
  assert.equal(await invalid.validate(), false);
  assert.deepEqual(
    invalid.issues.map((issue: { path: readonly (string | number)[] }) => issue.path),
    [['departments', 0, 'employees', 1, 'name']],
  );
});

test('an array item type from a golem-mode SDK reports the issue source of the model that validates it', async (t) => {
  const fixtureRoot = 'models/model-artifact-efficiency/array-items-inline/mixed-source';
  const wallet = readFixture(`${fixtureRoot}/wallet.model.ts`).replace("'./sdk/index.js'", "'../sdk/index.js'");
  const { root } = await loadGolemModeProject(t, 'golem-model-efficiency-mixed-', [{ document: parseYaml(readFixture(`${fixtureRoot}/money.yaml`)), folder: 'sdk', name: 'Payments' }], true, { 'src/wallet.model.ts': wallet });
  const { Wallet } = await import(pathToFileURL(path.join(root, 'build/src/wallet.model.js')).href);
  const invalid = getValidator(new Wallet({ coins: [{ amount: 1, currency: 'USD' }, { amount: -1, currency: 'USD' }] }));
  assert.equal(await invalid.validate(), false);
  assert.deepEqual(
    invalid.issues.map((issue: { path: readonly (string | number)[]; source: IssueSource }) => [issue.path, issue.source]),
    [[['coins', 1, 'amount'], IssueSource.TypeScript]],
    'one validator checks the whole value, so every issue carries the source of the model being validated',
  );
});

test('converted model fields call their converter without a per-field closure', async (t) => {
  const project = fixture(t);
  writeModelSources(project.sourceRoot, {
    'wallet.model.ts': [
      "import type { IModel, IObject } from '@exprtlabs/golem/model';",
      "import { TWalletBaseModel } from './wallet.model.generated.js';",
      'export type TMoney = IObject<{ amount: string; currency: string }>;',
      'export type TWallet = IModel<{ balance: TMoney; rebate: TMoney | null }>;',
      'export class Wallet extends TWalletBaseModel {}',
    ].join('\n'),
  });
  const spy = await buildAndSpy(project, ['convertModelField']);
  try {
    const { Wallet } = await import(pathToFileURL(path.join(project.root, 'build/wallet.model.js')).href);
    const wire = { balance: { amount: '1', currency: 'USD' }, rebate: { amount: '2', currency: 'EUR' } };
    // The model's own decode hook is not on the codec's fromWireFormat path; the nested-model decode of generated code (decodeGeneratedModelTrusted) is its only caller.
    // One decode: the converter each field passes, by direction and field.
    const round = () => {
      spy.calls.length = 0;
      decodeGeneratedModelTrusted(Wallet, wire);
      return new Map(spy.calls.map((call) => [`${String(call.args[0])} ${String(call.args[1])}`, call.args[2]]));
    };
    const first = round();
    const second = round();
    assert.deepEqual([...first.keys()].sort(), ['deserialize balance', 'deserialize rebate']);
    for (const [key, convert] of first) {
      assert.equal(typeof convert, 'function', key);
      assert.strictEqual(second.get(key), convert, `${key} passes one function on every call, not a closure made per call`);
    }
  } finally { spy.stop(); }
});

test('converted model items inside an array call their converter without a per-item closure', async (t) => {
  const project = fixture(t);
  writeModelSources(project.sourceRoot, {
    'wallet.model.ts': [
      "import type { IModel, IObject } from '@exprtlabs/golem/model';",
      "import { TWalletBaseModel } from './wallet.model.generated.js';",
      'export type TMoney = IObject<{ amount: string; currency: string }>;',
      'export type TWallet = IModel<{ history: TMoney[] }>;',
      'export class Wallet extends TWalletBaseModel {}',
    ].join('\n'),
  });
  const spy = await buildAndSpy(project, ['convertModelField', 'convertModelItems']);
  try {
    const { Wallet } = await import(pathToFileURL(path.join(project.root, 'build/wallet.model.js')).href);
    const wire = { history: [{ amount: '1', currency: 'USD' }, { amount: '2', currency: 'EUR' }, { amount: '3', currency: 'GBP' }] };
    const round = () => {
      spy.calls.length = 0;
      const wallet = decodeGeneratedModelTrusted(Wallet, wire);
      assert.deepEqual(modelCodec(wallet).toWireFormat(wallet), wire);
      return spy.calls.map((call) => ({ call: `${call.name} ${String(call.args[0])}`, convert: call.args.find((arg) => typeof arg === 'function') }));
    };
    const first = round();
    const second = round();
    // One call converts every item, so no item gets a converter of its own.
    assert.deepEqual(first.map((entry) => entry.call).filter((call) => call.startsWith('convertModelItems')).sort(), ['convertModelItems deserialize']);
    assert.equal(first.length, second.length);
    first.forEach((entry, index) => {
      assert.equal(typeof entry.convert, 'function', entry.call);
      assert.strictEqual(second[index].convert, entry.convert, `${entry.call} passes one function on every call, not a closure made per call`);
    });
  } finally { spy.stop(); }
});
