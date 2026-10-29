import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, type ModelProject } from './model-project.js';
import { command } from './support/process.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { pathToFileURL } from 'node:url';
import { modelCodec } from './support/model-codec.js';

function fixture(t: TestContext): ModelProject {
  return createModelProject(t, { prefix: 'golem-unify-validate-', name: 'unify-validate', linkWorkspaceNodeModules: true });
}

function writeArtifacts(result: { readonly artifacts: readonly { readonly path: string; readonly content: string }[] }): void {
  writeGeneratedArtifacts(result.artifacts);
}

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

function generatedText(root: string): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith('.generated.ts')) files.push(filename);
    }
  };
  visit(root);
  return files.map((filename) => fs.readFileSync(filename, 'utf8')).join('\n');
}

/** The text of every `models.validators.generated.ts` under `root`; empty when the job wrote none. */
function validatorsText(sourceRoot: string): string {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name === 'models.validators.generated.ts') found.push(fs.readFileSync(filename, 'utf8'));
    }
  };
  visit(sourceRoot);
  return found.join('\n');
}

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

test('a sanity model in a full project checks the shape only, alone and inside a full model', async (t: TestContext) => {
  // protects: T-678 a sanity model in a full project validates at shape only, and the full model around it keeps every limit
  const { root, sourceRoot } = fixture(t);
  writeMixedModels(sourceRoot);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  const { Checked } = await import(pathToFileURL(path.join(root, 'build/mixed.model.js')).href);
  const checkedCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TChecked'));
  const outerCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TOuter'));
  const trustedCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TTrusted'));
  const overLimit = { title: 'ok', note: ' ' };
  assert.equal(checkedCodec.validate(new Checked(overLimit)), true, 'a title under its limit and a blank note pass at sanity');
  assert.equal(checkedCodec.validate({ title: 5 }), false, 'the sanity model still rejects a wrong type');
  assert.equal(outerCodec.validate({ inner: overLimit, code: 'abc' }), true, 'the sanity model inside a full model checks the shape only');
  assert.equal(outerCodec.validate({ inner: { title: 5 }, code: 'abc' }), false, 'a wrong type inside it is still rejected');
  assert.equal(outerCodec.validate({ inner: overLimit, code: 'ab' }), false, 'the full model keeps its own limit');
  assert.throws(() => trustedCodec.validate({ id: '1' }));
  assert.throws(() => trustedCodec.stringify({ id: '1' }, { validate: true }));
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
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([{
    path: path.join(root, 'money.yaml'),
    content: readFixture('models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/money.yaml'),
  }]);
  const openapi = await generateOpenApi({
    input: path.join(root, 'money.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Payments',
    profile: { mobx: false, validation: true },
  });
  writeArtifacts(openapi);
  writeGeneratedArtifacts([
    {
      path: path.join(sourceRoot, 'rules.ts'),
      content: readFixture('models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/rules.ts'),
    },
    {
      path: path.join(sourceRoot, 'checkout.model.ts'),
      content: readFixture('models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/checkout.model.ts'),
    },
  ]);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  const source = generatedText(root);
  assertGeneratedValidatorsBound(source);
  const companion = fs.readFileSync(path.join(sourceRoot, 'checkout.model.generated.ts'), 'utf8');
  assert.equal((companion.match(/^import \{ [^}]*validate_[^}]+\} from /gm) ?? []).length, 1, 'the parent companion imports the shared validators once');
  const { Checkout } = await import(pathToFileURL(path.join(root, 'build/checkout.model.js')).href);
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
    code: -1,
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
  const rules = await import(pathToFileURL(path.join(root, 'build/rules.js')).href) as { extraMoneyCalls: number };
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
