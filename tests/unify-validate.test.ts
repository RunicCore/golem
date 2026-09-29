import { createFixtureProject, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { decodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { requireObjectCodec } from '@exprtlabs/codegen/serde';
import { getValidator, validateInstance } from '@exprtlabs/codegen/validation';
import { generate as generateOpenApi } from '@exprtlabs/openapi-to-ts/generator';
import { generate } from '#model/generator';
import { command, generatedCodecIdFromRoot, workspace } from './packed/helpers.js';
import { pathToFileURL } from 'node:url';

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

function fixture(t: TestContext): Fixture {
  const root = createFixtureProject(t, 'runic-unify-validate-');
  const sourceRoot = path.join(root, 'src');
  fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeGeneratedArtifacts([
    {
      path: path.join(root, 'package.json'),
      content: JSON.stringify({ name: 'unify-validate', private: true, type: 'module' }),
    },
    {
      path: path.join(root, 'tsconfig.json'),
      content: JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          outDir: 'build',
          rootDir: 'src',
          plugins: [{ transform: '@exprtlabs/codegen/ttsc-plugin' }],
        },
        include: ['src/**/*.ts'],
      }),
    },
  ]);
  return { root, sourceRoot };
}

function writeArtifacts(result: { readonly artifacts: readonly { readonly path: string; readonly content: string }[] }): void {
  writeGeneratedArtifacts(result.artifacts);
}

async function compile(root: string): Promise<void> {
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
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

function assertAjvEngineCreated(source: string): void {
  const engines = source.match(/createOpenApiSyncAjvEngine/g) ?? [];
  assert.ok(engines.length >= 1, 'codec Ajv engine is emitted');
}

test('global validation true emits codec Ajv for IObject and IModel', async (t: TestContext) => {
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([{
    path: path.join(sourceRoot, 'payload.model.ts'),
    content: readFixture('models/unify-validate/global-validation-true-emits-codec-ajv-for-iobject-and-imodel/payload.model.ts'),
  }]);
  writeArtifacts(generate({ root, profile: { mobx: false, validation: true } }));
  const source = generatedText(root);
  assertAjvEngineCreated(source);
  assert.match(source, /export function validatePayload\b/);
  assert.match(source, /export function validateAlias\b/);
  await compile(root);
  const { Payload } = await import(pathToFileURL(path.join(root, 'build/payload.model.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'Payload'));
  const model = new Payload({ title: 'ok' });
  assert.equal(codec.validate(model), false, 'interned Ajv sees handwritten extra keys');
  assert.deepEqual((await validateInstance(model)).map((issue) => issue.path), []);
  assert.equal(await getValidator(model).validate(), true);
  const invalid = new Payload({ title: 1 as never });
  assert.equal(codec.validate(invalid), false);
  const issues = await validateInstance(invalid);
  assert.equal(await getValidator(invalid).validate(), false);
  assert.deepEqual(issues.map((issue) => issue.path), getValidator(invalid).issues.map((issue) => issue.path));
});

test('I* validation option overrides the global flag in both directions and mixed files', async (t: TestContext) => {
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([{
    path: path.join(sourceRoot, 'mixed.model.ts'),
    content: readFixture('models/unify-validate/i-validation-option-overrides-the-global-flag-in-both-directions-and-mixed-f/mixed.model.ts'),
  }]);
  writeArtifacts(generate({ root, profile: { mobx: false, validation: false } }));
  await compile(root);
  const { Checked } = await import(pathToFileURL(path.join(root, 'build/mixed.model.js')).href);
  const checkedCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'Checked'));
  const trustedCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'Trusted'));
  assert.equal(checkedCodec.validate(new Checked({ title: 'ok' })), true);
  assert.equal(checkedCodec.validate({ title: 5 }), false, 'the per-type override still runs a real Ajv schema check');
  assert.throws(() => trustedCodec.validate({ id: '1' }));
  assert.throws(() => trustedCodec.stringify({ id: '1' }, { validate: true }));
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
  writeArtifacts(generate({ root, profile: { mobx: false, validation: true } }));
  await compile(root);
  const { Parent } = await import(pathToFileURL(path.join(root, 'build/nested.model.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'Parent'));
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
  writeArtifacts(generate({
    root,
    profile: { mobx: false, validation: true },
    manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')],
  }));
  const source = generatedText(root);
  assertAjvEngineCreated(source);
  const companion = fs.readFileSync(path.join(sourceRoot, 'checkout.model.generated.ts'), 'utf8');
  assert.equal((companion.match(/createOpenApiSyncAjvEngine\(\{ allErrors: false/g) ?? []).length, 1, 'one fast engine in the parent companion');
  await compile(root);
  const { Checkout } = await import(pathToFileURL(path.join(root, 'build/checkout.model.js')).href);
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'Checkout'));
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
  const valid = decodeGeneratedModel(Checkout, validWire);
  assert.equal(codec.validate(valid), true);
  assert.deepEqual((await validateInstance(valid, { failFast: false })).map((issue) => issue.path), []);

  const extra = decodeGeneratedModel(Checkout, { ...validWire, money: { amount: 12, currency: 'XXX' } });
  const extraIssues = await validateInstance(extra, { failFast: false });
  assert.equal(codec.validate(extra, { failFast: false }), false);
  assert.ok(extraIssues.some((issue) => issue.path[0] === 'money'));

  const nested = decodeGeneratedModel(Checkout, { ...validWire, money: { amount: 12, currency: 'usd' } });
  const nestedIssues = await validateInstance(nested, { failFast: false });
  assert.ok(nestedIssues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(['money', 'currency'])));

  const local = decodeGeneratedModel(Checkout, { ...validWire, note: '  ' });
  assert.ok((await validateInstance(local, { failFast: false })).some((issue) => issue.path[0] === 'note'));

  const combined = decodeGeneratedModel(Checkout, {
    ...validWire,
    money: { amount: -1, currency: 'usd' },
    note: '  ',
    code: -1,
  });
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

  const jsonCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'JsonCheckout'));
  const text = codec.stringify(valid);
  const parsed = codec.parse(text) as { note: string };
  assert.equal(codec.validate(parsed), true);
  assert.equal(parsed.note, 'ok');
  const jsonValue = jsonCodec.parse(text);
  assert.equal(jsonCodec.validate(jsonValue), true);
  assert.throws(() => codec.parse(JSON.stringify({ ...validWire, code: 'gg' })));
  assert.equal((companion.match(/function validateCheckout\b/g) ?? []).length, 1);
  assert.doesNotMatch(companion, /function validateMoney\b/, 'the parent companion does not duplicate the interned Money validator');
  const nestedCalls = companion.match(/addNestedCodecSchema\([\s\S]*?\);/g) ?? [];
  assert.ok(nestedCalls.length >= 1, 'interned Money codec schema is registered on the parent Ajv engines');
  assert.equal(nestedCalls.length, new Set(nestedCalls).size, nestedCalls.join('\n---\n'));
  assert.equal(
    (companion.match(/ = resolveGeneratedModelSchemaRefs/g) ?? []).length,
    (companion.match(/const __resolved(?:Model|Wire|ModelOnly|WireOnly)Schema_/g) ?? []).length,
    'interned $ref rewrite runs once per hoisted schema, residual schemas included',
  );
  const validateCheckout = companion.match(/export function validateCheckout[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(validateCheckout, '', 'validateCheckout is found in the companion');
  assert.match(validateCheckout, /runSynchronousValidation\(validator, value\)/);
  assert.doesNotMatch(
    validateCheckout,
    /addNestedCodecSchema|resolveGeneratedModelSchemaRefs|createOpenApiSyncAjvEngine/,
    'engine setup and schema ref resolution run once at module scope, not on every validateCheckout call',
  );
});
