import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { LibErrorKind } from '@exprtlabs/golem/errors';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { buildModelProject, createModelProject, writeModelGolemYaml, type ModelProject } from './model-project.js';
import { command } from './support/process.js';
import { parse as parseYaml } from 'yaml';
import { loadGolemModeProject } from './openapi/sdk-client-fixture.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { pathToFileURL } from 'node:url';
import { modelCodec } from './support/model-codec.js';

function fixture(t: TestContext): ModelProject {
  return createModelProject(t, { prefix: 'golem-unify-validate-', name: 'unify-validate', linkWorkspaceNodeModules: true });
}

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

/** The text of every file under `root` whose name `matches`, joined; empty when there is none. */
function textOfFiles(root: string, matches: (name: string) => boolean): string {
  const texts: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (matches(entry.name)) texts.push(fs.readFileSync(filename, 'utf8'));
    }
  };
  visit(root);
  return texts.join('\n');
}

const generatedText = (root: string): string => textOfFiles(root, name => name.endsWith('.generated.ts'));

/** The text of every `models.validators.generated.ts` under `root`; empty when the job wrote none. */
const validatorsText = (sourceRoot: string): string => textOfFiles(sourceRoot, name => name === 'models.validators.generated.ts');

function assertGeneratedValidatorsBound(source: string): void {
  assert.ok((source.match(/\bvalidate_\w+_[0-9a-f]{8}\b/g) ?? []).length >= 1, 'a codec binds to the generated validators');
}

test('global validation true binds IObject and IModel codecs to generated validators', async (t: TestContext) => {
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([{
    path: path.join(sourceRoot, 'payload.model.ts'),
    content: readFixture('models/unify-validate/global-validation-true-emits-codec-validator-for-iobject-and-imodel/payload.model.ts'),
  }]);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  const source = generatedText(root);
  assertGeneratedValidatorsBound(source);
  const companion = await import(pathToFileURL(path.join(root, 'build/payload.model.generated.js')).href) as Record<string, unknown>;
  assert.equal(typeof companion.validateTPayload, 'function', 'the companion exports the validator of the interface');
  assert.equal(typeof companion.validateTAlias, 'function', 'the companion exports the validator of the alias');
  const { Payload } = await import(pathToFileURL(path.join(root, 'build/payload.model.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TPayload'));
  const model = new Payload({ title: 'ok' });
  assert.equal(codec.validate(model), true, 'the handwritten own state of a model instance is not an extra key');
  assert.deepEqual((await validateInstance(model)).map((issue) => issue.path), []);
  assert.equal(await getValidator(model).validate(), true);
  const invalid = new Payload({ title: 1 as never });
  assert.equal(codec.validate(invalid), false);
  const issues = await validateInstance(invalid);
  assert.equal(await getValidator(invalid).validate(), false);
  assert.deepEqual(issues.map((issue) => issue.path), getValidator(invalid).issues.map((issue) => issue.path));
});

const MIXED_FIXTURE = 'models/unify-validate/i-validation-option-lowers-the-project-level-per-type-in-mixed-files';

function writeMixedModels(sourceRoot: string): void {
  writeGeneratedArtifacts(['mixed.model.ts', 'rules.ts'].map((name) => ({
    path: path.join(sourceRoot, name),
    content: readFixture(`${MIXED_FIXTURE}/${name}`),
  })));
}

test('a model registers its own validation level as the default of its calls', async (t: TestContext) => {
  // protects: T-678 the generated code records each model's level (R-76: the model's level is a default, not a cap)
  const { root, sourceRoot } = fixture(t);
  writeMixedModels(sourceRoot);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  const { Checked } = await import(pathToFileURL(path.join(root, 'build/mixed.model.js')).href);
  assert.deepEqual(findGeneratedModelDefinition(new Checked({ title: 'abc' }))?.profile, { validation: 'sanity' });
  const checkedCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TChecked'));
  const trustedCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TTrusted'));
  assert.equal(checkedCodec.validate({ title: 'abc' }), true);
  assert.equal(checkedCodec.validate({ title: 5 }), false, 'a wrong type is rejected at every level');
  assert.throws(() => trustedCodec.validate({ id: '1' }), { kind: LibErrorKind.ValidationUnavailable });
  assert.throws(() => trustedCodec.stringify({ id: '1' }, { validate: true }), { kind: LibErrorKind.ValidationUnavailable });
});

test('a sanity project emits no value limit and no validation function, and its models check the shape only', async (t: TestContext) => {
  // protects: T-678 a sanity project emits no value-limit or TValidation code
  const { root, sourceRoot } = fixture(t);
  writeMixedModels(sourceRoot);
  writeModelGolemYaml(root, { mobx: false, validation: 'sanity' });
  await compile(root);
  const validators = validatorsText(sourceRoot);
  assert.notEqual(validators, '', 'the sanity project writes its validators module');
  assert.equal(/notBlank|rules\.js|\.length\s*<|codePointLength/.test(validators), false, 'the validators module holds no limit and imports no validation function');
  await import(pathToFileURL(path.join(root, 'build/mixed.model.js')).href);
  const outerCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TOuter'));
  assert.equal(outerCodec.validate({ inner: { title: 'ok', note: ' ' }, code: 'ab' }), true);
  assert.equal(outerCodec.validate({ inner: { title: 'ok' }, code: 5 }), false);
});

test('a project at true whose models are all off writes no validators module', async (t: TestContext) => {
  // protects: T-678 project true with only off models writes no models.validators.generated.ts, as project false does
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([{
    path: path.join(sourceRoot, 'off.model.ts'),
    content: "import type { IObject } from '@exprtlabs/golem/model';\nimport type { MinLength } from '@exprtlabs/golem/tags';\nexport type TOff = IObject<{ id: string & MinLength<3> }, { validation: false }>;\n",
  }]);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  assert.equal(validatorsText(sourceRoot), '');
});

test('an off model with a validation function in its own file, held by a validating model, generates', async (t: TestContext) => {
  // protects: T-678 bug: an off model's tag schema named a validation function that was not imported (VALIDATE_UNKNOWN_VALIDATION)
  const { root, sourceRoot } = fixture(t);
  const files: Record<string, string> = {
    'rules.ts': 'export function notBlank(value: string): boolean | string { return value.trim().length > 0 || "blank"; }\n',
    'child.model.ts': "import type { IObject } from '@exprtlabs/golem/model';\nimport type { TValidation } from '@exprtlabs/golem/tags';\nimport { notBlank } from './rules.js';\nexport type TChild = IObject<{ secret: string & TValidation<typeof notBlank> }, { validation: false }>;\n",
    'parent.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nimport type { TChild } from './child.model.js';\nexport type TParent = IModel<{ child: TChild; note: string }>;\n",
  };
  writeGeneratedArtifacts(Object.entries(files).map(([name, content]) => ({ path: path.join(sourceRoot, name), content })));
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  await import(pathToFileURL(path.join(root, 'build/parent.model.generated.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TParent'));
  assert.equal(codec.validate({ child: { secret: '  ' }, note: 'ok' }), true, 'the off child is not checked');
  assert.equal(codec.validate({ child: { secret: 'x' }, note: 5 }), false);
});

test('nested interned child with validation false is opaque; parent field tags still run', async (t: TestContext) => {
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([
    {
      path: path.join(sourceRoot, 'predicates.ts'),
      content: readFixture('models/unify-validate/nested-interned-child-with-validation-false-is-opaque-parent-field-tags-stil/predicates.ts'),
    },
    {
      path: path.join(sourceRoot, 'nested.model.ts'),
      content: readFixture('models/unify-validate/nested-interned-child-with-validation-false-is-opaque-parent-field-tags-stil/nested.model.ts'),
    },
  ]);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  const { Parent } = await import(pathToFileURL(path.join(root, 'build/nested.model.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TParent'));
  const valid = new Parent({ child: { secret: 7 as never }, note: 'ok' });
  assert.equal(codec.validate(valid), true);
  const blank = new Parent({ child: { secret: 'x' }, note: '  ' });
  assert.equal(codec.validate(blank), false);
  assert.ok((await validateInstance(blank)).some((issue) => issue.path[0] === 'note'));
});

test('SDK Money $ref plus extra TValidation, local TValidation, and TSerde compile into one companion', async (t: TestContext) => {
  // protects: F-804 the limits of a golem-mode SDK type reach the validator of an app model that holds it
  const fixtureFile = (name: string): string => readFixture(`models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/${name}`);
  const { root } = await loadGolemModeProject(t, 'golem-unify-validate-', [{ document: parseYaml(fixtureFile('money.yaml')), folder: 'sdk', name: 'Payments' }], true, {
    'src/rules.ts': fixtureFile('rules.ts'),
    'src/checkout.model.ts': fixtureFile('checkout.model.ts').replace("'./sdk/index.js'", "'../sdk/index.js'"),
  });
  const sourceRoot = path.join(root, 'src');
  const source = generatedText(root);
  assertGeneratedValidatorsBound(source);
  const companion = fs.readFileSync(path.join(sourceRoot, 'checkout.model.generated.ts'), 'utf8');
  assert.equal((companion.match(/^import \{ [^}]*validate_[^}]+\} from /gm) ?? []).length, 1, 'the parent companion imports the shared validators once');
  const { Checkout } = await import(pathToFileURL(path.join(root, 'build/src/checkout.model.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TCheckout'));
  const validWire = {
    money: { amount: 12, currency: 'USD' },
    note: 'ok',
    code: 'ff',
    when: '2026-01-01T00:00:00.000Z',
    items: [{ sku: 'ABC' }],
    primary: { sku: 'ABC', quantity: 1, price: 2 },
    flags: { rush: 'yes' },
    channel: { kind: 'hold', until: '2026-01-03T00:00:00.000Z' },
    span: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
    hold: null,
    bag: { lane: 'A' },
  };
  const valid = modelCodec(Checkout).fromWireFormat(validWire, { validate: false });
  assert.equal(codec.validate(valid), true);
  assert.deepEqual((await validateInstance(valid, { failFast: false })).map((issue) => issue.path), []);

  const extra = modelCodec(Checkout).fromWireFormat({ ...validWire, money: { amount: 12, currency: 'XXX' } }, { validate: false });
  const extraIssues = await validateInstance(extra, { failFast: false });
  assert.equal(codec.validate(extra, { failFast: false }), false);
  assert.ok(extraIssues.some((issue) => issue.path[0] === 'money'));

  const nested = modelCodec(Checkout).fromWireFormat({ ...validWire, money: { amount: 12, currency: 'usd' } }, { validate: false });
  const nestedIssues = await validateInstance(nested, { failFast: false });
  assert.ok(nestedIssues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(['money', 'currency'])));

  const local = modelCodec(Checkout).fromWireFormat({ ...validWire, note: '  ' }, { validate: false });
  assert.ok((await validateInstance(local, { failFast: false })).some((issue) => issue.path[0] === 'note'));

  const combined = modelCodec(Checkout).fromWireFormat({
    ...validWire,
    money: { amount: -1, currency: 'usd' },
    note: '  ',
    code: '-1',
  }, { validate: false });
  const collected = await validateInstance(combined, { failFast: false });
  const helper = await getValidator(combined).validate({ failFast: false });
  assert.equal(helper, false);
  assert.equal(codec.validate(combined, { failFast: false }), false);
  assert.ok(collected.some((issue) => issue.path[0] === 'money'));
  assert.ok(collected.some((issue) => issue.path[0] === 'note'));
  assert.ok(collected.some((issue) => issue.path[0] === 'code'));
  assert.deepEqual(
    collected.map((issue) => issue.path.join('.')).sort(),
    getValidator(combined).issues.map((issue) => issue.path.join('.')).sort(),
  );

  const jsonCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TJsonCheckout'));
  const text = codec.stringify(valid);
  const parsed = codec.parse(text) as { note: string };
  assert.equal(codec.validate(parsed), true);
  assert.equal(parsed.note, 'ok');
  const rules = await import(pathToFileURL(path.join(root, 'build/src/rules.js')).href) as { extraMoneyCalls: number };
  const callsBefore = rules.extraMoneyCalls;
  const jsonValue = jsonCodec.parse(text);
  assert.equal(rules.extraMoneyCalls - callsBefore, 1, 'extraMoney runs once per parse');
  assert.equal(jsonCodec.validate(jsonValue), true);
  assert.throws(() => codec.parse(JSON.stringify({ ...validWire, code: 'gg' })));
  assert.equal((companion.match(/function validateTCheckout\b/g) ?? []).length, 1);
  const validateTCheckout = companion.match(/export function validateTCheckout[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(validateTCheckout, '', 'validateTCheckout is found in the companion');
  // Kept pin: how the emitted validator calls its shared check is the claim; the validation results above run it.
  assert.match(validateTCheckout, /isValidModelValue\(value, options, options\?\.validationContext === undefined && structure_(\w+_[0-9a-f]{8})\(value\) \? predicates_\1 : validate_\1, /);
});

test('an extra TValidation on an SDK-typed field rejects what the SDK accepts, and the SDK rejects what the extra rule accepts', async (t: TestContext) => {
  // protects: T-720 the SDK check and the app rule of an SDK-typed field both run in golem mode
  const fixtureFile = (name: string): string => readFixture(`models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/${name}`);
  const { root } = await loadGolemModeProject(t, 'golem-unify-validate-', [{ document: parseYaml(fixtureFile('money.yaml')), folder: 'sdk', name: 'Payments' }], true, {
    'src/rules.ts': fixtureFile('rules.ts'),
    'src/checkout.model.ts': fixtureFile('checkout.model.ts').replace("'./sdk/index.js'", "'../sdk/index.js'"),
  });
  const { Checkout } = await import(pathToFileURL(path.join(root, 'build/src/checkout.model.js')).href);
  const rules = await import(pathToFileURL(path.join(root, 'build/src/rules.js')).href) as { extraMoneyCalls: number };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TCheckout'));
  const wire = { note: 'ok', code: 'ff', when: '2026-01-01T00:00:00.000Z', items: [], primary: { sku: 'ABC', quantity: 1, price: 2 }, flags: {}, channel: { kind: 'open' }, span: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'], hold: null };
  const issuesOf = async (money: { amount: number; currency: string }): Promise<{ path: readonly (string | number)[]; message: string }[]> =>
    (await validateInstance(modelCodec(Checkout).fromWireFormat({ ...wire, money }, { validate: false }), { failFast: false })).map((issue) => ({ path: issue.path, message: issue.message }));

  const before = rules.extraMoneyCalls;
  assert.deepEqual(await issuesOf({ amount: 12, currency: 'XXX' }), [{ path: ['money'], message: 'reserved' }]);
  assert.equal(rules.extraMoneyCalls - before, 1, 'the extra rule ran for the value the SDK accepts');
  assert.deepEqual((await issuesOf({ amount: 12, currency: 'usd' })).map((issue) => issue.path), [['money', 'currency']]);
  assert.deepEqual(await issuesOf({ amount: 12, currency: 'USD' }), []);
  assert.equal(codec.validate(modelCodec(Checkout).fromWireFormat({ ...wire, money: { amount: 12, currency: 'XXX' } }, { validate: false })), false);
});
