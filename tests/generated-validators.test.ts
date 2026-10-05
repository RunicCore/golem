import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { buildCodecValidationPlan, type CodecSchemaClosureEntry } from '@exprtlabs/golem/validation-plan';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { createSchemaGraph } from '@exprtlabs/golem/schema-graph';
import { workspace } from './support/process.js';
import { buildModelProject, generatedModelFiles, writeModelGolemYaml } from './model-project.js';
import type { ModelValidationContext } from '@exprtlabs/golem/model';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compileSchema } from './support/compiled-validators.js';
import { runPipeline } from '#golem/pipeline';

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'golem-generated-validators-'));
  const sourceRoot = path.join(root, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  symlinkSync(path.join(workspace, 'packages/golem'), path.join(root, 'node_modules/@exprtlabs/golem'), 'dir');
  symlinkSync(path.join(workspace, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  symlinkSync(path.join(workspace, 'packages/golem-model'), path.join(root, 'node_modules/@exprtlabs/golem-model'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'generated-validators', private: true, type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
      outDir: 'build',
      rootDir: 'src',
    },
    include: ['src/**/*.ts'],
  }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sourceRoot };
}

function copyValidators(value: Fixture): string {
  const artifact = generatedModelFiles(value.root).find(item => item.path.endsWith('/models.validators.generated.js'));
  assert.ok(artifact, 'generated validators artifact');
  const target = path.join(value.root, 'build', path.relative(value.sourceRoot, artifact.path));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(artifact.path, target);
  return target;
}

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

function schemaRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a schema object`);
  }
  return value as Record<string, unknown>;
}

function withoutRootDefinitions(value: unknown): unknown {
  const result = structuredClone(schemaRecord(value, 'schema'));
  delete result.$defs;
  return result;
}

function changePropertySchema(
  schema: unknown,
  property: string,
  keyword: string,
  value: number,
): Record<string, unknown> {
  const result = structuredClone(schemaRecord(schema, 'root schema'));
  const properties = schemaRecord(result.properties, 'schema properties');
  properties[property] = { ...schemaRecord(properties[property], `${property} schema`), [keyword]: value };
  return result;
}

test('validation plan identity compares owned definitions per model and wire plane and retains real child conflicts', () => {
  const moneyDescriptor: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      amount: { kind: 'number', serde: { id: 'decimal', wire: { kind: 'string' } } },
      currency: { kind: 'string' },
    },
    required: ['amount', 'currency'],
    additionalProperties: false,
  };
  const paymentDescriptor: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      money: { kind: 'reference', name: 'Money', construct: true },
      paid: { kind: 'boolean' },
    },
    required: ['money', 'paid'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(moneyDescriptor, 'Money');
  graph.intern(paymentDescriptor, 'Payment');
  graph.seal();
  const nodes = [...graph.nodes.values()].filter(node => node.kind !== 'reference');
  const money = nodes.find(node => node.name === 'Money');
  const payment = nodes.find(node => node.name === 'Payment');
  assert.ok(money);
  assert.ok(payment);
  assert.equal(money.sameSchema, false, 'TSerde creates distinct model and wire schemas for the child codec');
  assert.equal(payment.sameSchema, false, 'the parent carries the child schema on both representations');

  const compactPaymentSchema = (schema: unknown, childReference: string): Record<string, unknown> => {
    const result = structuredClone(schemaRecord(schema, 'Payment schema'));
    const definitions = schemaRecord(result.$defs, 'Payment graph definitions');
    assert.deepEqual(
      withoutRootDefinitions(definitions[money.codecId]),
      withoutRootDefinitions(schema === payment.modelJsonSchema ? money.modelJsonSchema : money.jsonSchema),
      'the Payment graph definition is owned by the corresponding Money schema node',
    );
    definitions[money.codecId] = { $ref: childReference };
    return result;
  };
  const closure: CodecSchemaClosureEntry[] = nodes.map(node => ({
    codecId: node.codecId,
    modelSchema: node === payment
      ? compactPaymentSchema(node.modelJsonSchema, money.codecId)
      : structuredClone(node.modelJsonSchema),
    ...(!node.sameSchema ? {
      wireSchema: node === payment
        ? compactPaymentSchema(node.jsonSchema, `${money.codecId}#wire`)
        : structuredClone(node.jsonSchema),
    } : {}),
  }));

  // One full graph candidate and two equivalent compact closure candidates
  // exercise repeated comparison without detaching the first graph context.
  const plan = buildCodecValidationPlan(graph, [...closure, ...closure]);
  assert.ok(Object.hasOwn(plan.schemas, `${money.codecId}#wire`));
  assert.ok(Object.hasOwn(plan.schemas, `${payment.codecId}#wire`));

  const modelConflict = closure.map(entry => entry.codecId === money.codecId
    ? { ...entry, modelSchema: changePropertySchema(entry.modelSchema, 'amount', 'minimum', 1) }
    : entry);
  assert.throws(
    () => buildCodecValidationPlan(graph, modelConflict),
    error => error instanceof TypeError && error.message === `Conflicting standalone schema identity "${money.codecId}".`,
    'a changed child model constraint is still rejected',
  );

  const wireConflict = closure.map(entry => entry.codecId === money.codecId && entry.wireSchema !== undefined
    ? { ...entry, wireSchema: changePropertySchema(entry.wireSchema, 'amount', 'maxLength', 12) }
    : entry);
  assert.throws(
    () => buildCodecValidationPlan(graph, wireConflict),
    error => error instanceof TypeError && error.message === `Conflicting standalone schema identity "${money.codecId}#wire".`,
    'a changed child wire constraint cannot be mistaken for the model schema',
  );
});

test('generated object codecs close nested schemas and keep first/all and context behavior', async t => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'root.model.ts'), readFixture("models/generated-validators/generated-object-codecs-close-nested-schemas-and-preserve-first-all-sync-and-context/root.model.ts"));

  writeModelGolemYaml(value.root, { mobx: false, validation: true });
  await compile(value.root);
  const generated = generatedModelFiles(value.root).filter(item => item.path.endsWith('.ts')).map(item => item.content).join('\n');
  assert.match(generated, /requireModelValidator\(validators, /, 'object codecs bind to the generated validators');
  assert.doesNotMatch(
    generated,
    /@exprtlabs\/golem\/ajv|createOpenApi(?:Sync)?AjvEngine/,
    'generated model modules do not import a runtime Ajv engine',
  );

  const validatorsPath = copyValidators(value);
  const [{ Root }, { TLeafBaseModel, TMiddleBaseModel, TRootBaseModel }, validatorModule] = await Promise.all([
    import(pathToFileURL(path.join(value.root, 'build/root.model.js')).href),
    import(pathToFileURL(path.join(value.root, 'build/root.model.generated.js')).href),
    import(pathToFileURL(validatorsPath).href),
  ]) as [{ Root: new (values?: never) => object }, {
    TLeafBaseModel: abstract new (...args: never[]) => object;
    TMiddleBaseModel: abstract new (...args: never[]) => object;
    TRootBaseModel: abstract new (...args: never[]) => object;
  }, { readonly validators: Readonly<Record<string, Validator>> }];
  const { findCodecIdForConstructor, requireObjectCodec } = await import('@exprtlabs/golem/serde');
  const { getValidator, validateInstance } = await import('@exprtlabs/golem/validation');
  const codecId = findCodecIdForConstructor(TRootBaseModel);
  assert.ok(codecId, 'generated root model has a registered codec id');
  const codec = requireObjectCodec(codecId);
  const wire = {
    label: 'x',
    first: { label: 'first', child: { code: 'y' } },
    second: { label: 'second', child: { code: 'z' } },
  };
  const invalid = new Root(wire as never);
  const { validators } = validatorModule;
  assert.ok(findCodecIdForConstructor(TLeafBaseModel));
  assert.ok(findCodecIdForConstructor(TMiddleBaseModel));
  assert.equal(validators[codecId]?.(wire, false).length, 1, 'the first issue only');
  assert.deepEqual(
    validators[codecId]?.(wire, true).map(issue => issue.path.join('.')).sort(),
    ['first.child.code', 'label', 'second.child.code'],
    'every issue, nested models included',
  );

  assert.equal(codec.validate(invalid), false);
  assert.equal(codec.validate(invalid, { failFast: false }), false);
  assert.throws(() => codec.assert(invalid), error => error instanceof LibError && error.issues.length === 1);
  assert.throws(
    () => codec.assert(invalid, { failFast: false }),
    error => error instanceof LibError && error.issues.length === 3,
    'generated assert honors the all-issues option',
  );

  const stateful = getValidator(invalid);
  assert.equal(await stateful.validate({ failFast: false }), false);
  assert.equal(stateful.issues.length, 3);
  assert.equal(await stateful.validate({ failFast: true }), false);
  assert.equal(stateful.issues.length, 1);
  assert.equal((await validateInstance(invalid, { failFast: false })).length, 3);

  const accept: Validator = () => [];
  const lookups: string[] = [];
  const context: ModelValidationContext = {
    resolve(reference, mode) {
      lookups.push(`${reference}|${mode}`);
      return accept;
    },
  };
  assert.equal(codec.validate(invalid, { validationContext: context }), true);
  assert.equal(codec.validate(invalid, { validationContext: context }), true);
  assert.equal(codec.validate(invalid, { failFast: false, validationContext: context }), true);
  assert.equal(codec.validate(invalid, { failFast: false, validationContext: context }), true);
  assert.deepEqual(lookups, [`${codecId}|first`, `${codecId}|all`], 'context resolution is reused separately for each mode');

  assert.throws(
    () => codec.validate(invalid, { validationContext: { resolve: () => undefined } }),
    error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    'an incomplete explicit context does not fall back to the generated validators',
  );
  await assert.rejects(
    () => validateInstance(invalid, { validationContext: null as unknown as ModelValidationContext }),
    error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    'an explicitly supplied null context does not fall back to the generated validators',
  );

  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', captureUnhandled);
  try {
    for (const asyncValidator of [
      async (): Promise<boolean> => false,
      async (): Promise<boolean> => { throw new Error('async validation failure'); },
    ]) {
      const asyncOverride: ModelValidationContext = { resolve: () => asyncValidator as unknown as Validator };
      assert.throws(
        () => codec.validate(invalid, { validationContext: asyncOverride }),
        error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
      );
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, [], 'sync rejection consumes async override promises safely');
});

test('generated validators permit equal model names in independent source graphs', async t => {
  const value = fixture(t);
  mkdirSync(path.join(value.sourceRoot, 'first'), { recursive: true });
  mkdirSync(path.join(value.sourceRoot, 'second'), { recursive: true });
  writeFileSync(path.join(value.sourceRoot, 'first/item.model.ts'), readFixture("models/generated-validators/generated-validators-permit-equal-model-names-in-independent-source-graphs/item.model.ts"));
  writeFileSync(path.join(value.sourceRoot, 'second/item.model.ts'), readFixture("models/generated-validators/generated-validators-permit-equal-model-names-in-independent-source-graphs/item.model-2.ts"));

  writeModelGolemYaml(value.root, { mobx: false, validation: true });
  await compile(value.root);
  assert.ok(generatedModelFiles(value.root).some(item => item.path.endsWith('/models.validators.generated.js')));
  copyValidators(value);
  const [{ Item: FirstItem }, { Item: SecondItem }] = await Promise.all([
    import(pathToFileURL(path.join(value.root, 'build/first/item.model.js')).href),
    import(pathToFileURL(path.join(value.root, 'build/second/item.model.js')).href),
  ]) as [
    { Item: new (values?: never) => object },
    { Item: new (values?: never) => object },
  ];
  const { getValidator } = await import('@exprtlabs/golem/validation');
  assert.equal(await getValidator(new FirstItem({ label: 'first' } as never)).validate(), true);
  assert.equal(await getValidator(new SecondItem({ count: 2 } as never)).validate(), true);
});

test('a project with validation off generates no validators and refuses validate: true', async t => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'root.model.ts'), readFixture("models/generated-validators/generated-object-codecs-close-nested-schemas-and-preserve-first-all-sync-and-context/root.model.ts"));
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await compile(value.root);
  assert.equal(generatedModelFiles(value.root).some(item => item.path.endsWith('.validators.generated.js')), false);
  const { TRootBaseModel } = await import(pathToFileURL(path.join(value.root, 'build/root.model.generated.js')).href) as {
    TRootBaseModel: abstract new (...args: never[]) => object;
  };
  const { findCodecIdForConstructor, requireObjectCodec } = await import('@exprtlabs/golem/serde');
  const codecId = findCodecIdForConstructor(TRootBaseModel);
  assert.ok(codecId);
  const wire = '{"label":"x","first":{"label":"first","child":{"code":"y"}},"second":{"label":"second","child":{"code":"z"}}}';
  assert.throws(
    () => requireObjectCodec(codecId).parse(wire, { validate: true }),
    error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
  assert.doesNotThrow(() => requireObjectCodec(codecId).parse(wire));
});

test('unknownFormats: error makes generation fail with VALIDATE_UNKNOWN_FORMAT', async t => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'contact.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Format } from '@exprtlabs/golem/tags';",
    "export type TContact = IModel<{ phone: string & Format<'phone-number'> }>;",
    '',
  ].join('\n'));
  writeModelGolemYaml(value.root, { mobx: false, validation: true });
  const config = path.join(value.root, 'golem.yaml');
  // The default warns and writes the validators; the format is not checked.
  await runPipeline(config);
  assert.ok(generatedModelFiles(value.root).some(item => item.path.endsWith('/models.validators.generated.js')));
  writeFileSync(config, `${readFileSync(config, 'utf8')}unknownFormats: error\n`);
  await assert.rejects(runPipeline(config), /VALIDATE_UNKNOWN_FORMAT/);
});

test('a model class registered at run time satisfies a generated model-instance check', async () => {
  const { registerIModelClass } = await import('@exprtlabs/golem/serde');
  class Cat {}
  class Dog {}
  registerIModelClass('GeneratedValidatorsCat_0a1b2c3d', Cat);
  registerIModelClass('GeneratedValidatorsDog_0a1b2c3d', Dog);
  const validate = await compileSchema({
    golemModelInstance: { of: 'GeneratedValidatorsCat_0a1b2c3d', among: ['GeneratedValidatorsCat_0a1b2c3d', 'GeneratedValidatorsDog_0a1b2c3d'], required: true },
  });
  assert.deepEqual(validate(new Cat(), true), []);
  assert.deepEqual(validate(new Dog(), true), [{ path: [], code: 'instance', model: 'GeneratedValidatorsCat_0a1b2c3d' }]);
  assert.deepEqual(validate({}, true), [{ path: [], code: 'instance', model: 'GeneratedValidatorsCat_0a1b2c3d' }]);
});
