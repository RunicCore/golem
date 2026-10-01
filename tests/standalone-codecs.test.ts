import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { buildCodecValidationPlan, type CodecSchemaClosureEntry } from '@exprtlabs/golem/ajv-tooling';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { createSchemaGraph } from '@exprtlabs/golem/schema-graph';
import { generate } from '#model/generator';
import { command, workspace } from './support/process.js';
import type { ModelValidationContext } from '@exprtlabs/golem/model';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'golem-standalone-codecs-'));
  const sourceRoot = path.join(root, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  symlinkSync(path.join(workspace, 'packages/golem'), path.join(root, 'node_modules/@exprtlabs/golem'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'standalone-codecs', private: true, type: 'module' }));
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

function materialize(result: ReturnType<typeof generate>): void {
  for (const artifact of result.artifacts) {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content);
  }
}

function copyStandalone(result: ReturnType<typeof generate>, value: Fixture): string {
  const artifact = result.artifacts.find(item => item.path.endsWith('/models.validators.generated.js'));
  assert.ok(artifact, 'standalone validator artifact');
  const target = path.join(value.root, 'build', path.relative(value.sourceRoot, artifact.path));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(artifact.path, target);
  return target;
}

async function compile(root: string): Promise<void> {
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
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

test('standalone schema identity compares owned definitions per model and wire plane and retains real child conflicts', () => {
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

test('standalone object codecs close nested schemas and preserve first/all sync and async-context behavior', async t => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'root.model.ts'), readFixture("models/standalone-codecs/standalone-object-codecs-close-nested-schemas-and-preserve-first-all-sync-an/root.model.ts"));

  const result = generate({ root: value.root, profile: { mobx: false, validation: true, ajvStandalone: true } });
  materialize(result);
  const generated = result.artifacts.filter(item => item.path.endsWith('.ts')).map(item => item.content).join('\n');
  assert.match(generated, /modelValidatorSet\.(?:first|all)\[/, 'object codecs bind directly to precompiled validators');
  assert.doesNotMatch(
    generated,
    /@exprtlabs\/golem\/ajv|createOpenApi(?:Sync)?AjvEngine/,
    'standalone codecs bind to precompiled validators instead of importing a runtime Ajv engine',
  );

  await compile(value.root);
  const validatorsPath = copyStandalone(result, value);
  const [{ Root }, { TLeafBaseModel, TMiddleBaseModel, TRootBaseModel }, validators] = await Promise.all([
    import(pathToFileURL(path.join(value.root, 'build/root.model.js')).href),
    import(pathToFileURL(path.join(value.root, 'build/root.model.generated.js')).href),
    import(pathToFileURL(validatorsPath).href),
  ]) as [{ Root: new (values?: never) => object }, {
    TLeafBaseModel: abstract new (...args: never[]) => object;
    TMiddleBaseModel: abstract new (...args: never[]) => object;
    TRootBaseModel: abstract new (...args: never[]) => object;
  }, {
    createValidatorSet(bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>): {
      readonly first: Readonly<Record<string, ((input: unknown) => boolean) & { readonly errors?: readonly unknown[] | null }>>;
      readonly all: Readonly<Record<string, ((input: unknown) => boolean) & { readonly errors?: readonly unknown[] | null }>>;
      readonly schemas: Readonly<Record<string, object | boolean>>;
    };
  }];
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
  const standalone = validators.createValidatorSet();
  const leafId = findCodecIdForConstructor(TLeafBaseModel);
  const middleId = findCodecIdForConstructor(TMiddleBaseModel);
  assert.ok(Object.hasOwn(standalone.schemas, codecId));
  assert.ok(leafId);
  assert.ok(middleId);
  const rootSchema = standalone.schemas[codecId] as {
    readonly properties?: Readonly<Record<string, { readonly $ref?: string }>>;
    readonly $defs?: Readonly<Record<string, unknown>>;
  };
  const middleSchema = standalone.schemas[middleId] as {
    readonly properties?: Readonly<Record<string, { readonly $ref?: string }>>;
  };
  assert.equal(rootSchema.properties?.first?.$ref, middleId);
  assert.equal(rootSchema.properties?.second?.$ref, middleId);
  assert.equal(middleSchema.properties?.child?.$ref, leafId);
  assert.equal(rootSchema.$defs?.[middleId], undefined, 'graph-owned nested definitions are removed from the root payload');
  assert.equal(rootSchema.$defs?.[leafId], undefined, 'transitive graph definitions are not repeated in the root payload');
  assert.equal(standalone.first[codecId]?.(wire), false);
  assert.equal(standalone.first[codecId]?.errors?.length, 1);
  assert.equal(standalone.all[codecId]?.(wire), false);
  assert.equal(standalone.all[codecId]?.errors?.length, 3);

  assert.equal(codec.validate(invalid), false);
  assert.equal(codec.errors?.length, 1, 'generated codec defaults to first-error validation');
  assert.equal(codec.validate(invalid, { failFast: false }), false);
  assert.equal(codec.errors?.length, 3, 'generated codec selects all-errors validation when requested');
  assert.throws(() => codec.assert(invalid), error => error instanceof LibError && error.issues.length === 1);
  assert.throws(
    () => codec.assert(invalid, { failFast: false }),
    error => error instanceof LibError && error.issues.length === 3,
    'generated assert honors the all-errors option',
  );

  const stateful = getValidator(invalid);
  assert.equal(await stateful.validate({ failFast: false }), false);
  assert.equal(stateful.issues.length, 3);
  assert.equal(await stateful.validate({ failFast: true }), false);
  assert.equal(stateful.issues.length, 1);
  assert.equal((await validateInstance(invalid, { failFast: false })).length, 3);

  const accept = (_input: unknown): boolean => true;
  Object.defineProperty(accept, 'errors', { value: [] });
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

  const engineLookups: string[] = [];
  const engineContext: ModelValidationContext = {
    engine: {
      addSchema() {},
      getSchema(reference) {
        engineLookups.push(reference);
        return accept;
      },
    },
  };
  assert.equal(codec.validate(invalid, { validationContext: engineContext }), true);
  assert.equal(codec.validate(invalid, { validationContext: engineContext }), true);
  assert.equal(codec.validate(invalid, { failFast: false, validationContext: engineContext }), true);
  assert.deepEqual(engineLookups, [codecId, codecId], 'generated codecs resolve and reuse explicit engine validators for first/all modes');

  assert.throws(
    () => codec.validate(invalid, { validationContext: { resolve: () => undefined } }),
    error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    'an incomplete explicit context does not fall back to the global Ajv engine',
  );
  assert.throws(
    () => codec.validate(invalid, { validationContext: { engine: { addSchema() {}, getSchema: () => undefined } } }),
    error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    'an explicit engine with a missing schema does not fall back to the global Ajv engine',
  );
  await assert.rejects(
    () => validateInstance(invalid, { validationContext: null as unknown as ModelValidationContext }),
    error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    'an explicitly supplied null instance context does not fall back to the global validator',
  );

  const asyncContext: ModelValidationContext = {
    resolve: () => async input => input !== null && typeof input === 'object' && 'label' in input,
  };
  assert.deepEqual(await validateInstance(invalid, { validationContext: asyncContext }), [], 'async contexts are supported by async validation APIs');

  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', captureUnhandled);
  try {
    for (const asyncValidator of [
      async (_input: unknown): Promise<boolean> => false,
      async (_input: unknown): Promise<boolean> => { throw new Error('async validation failure'); },
    ]) {
      const asyncOverride: ModelValidationContext = { resolve: () => asyncValidator };
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

test('standalone plans permit equal model names in independent source graphs', async t => {
  const value = fixture(t);
  mkdirSync(path.join(value.sourceRoot, 'first'), { recursive: true });
  mkdirSync(path.join(value.sourceRoot, 'second'), { recursive: true });
  writeFileSync(path.join(value.sourceRoot, 'first/item.model.ts'), readFixture("models/standalone-codecs/standalone-plans-permit-equal-model-names-in-independent-source-graphs/item.model.ts"));
  writeFileSync(path.join(value.sourceRoot, 'second/item.model.ts'), readFixture("models/standalone-codecs/standalone-plans-permit-equal-model-names-in-independent-source-graphs/item.model-2.ts"));

  const result = generate({ root: value.root, profile: { mobx: false, validation: true, ajvStandalone: true } });
  materialize(result);
  assert.ok(result.artifacts.some(item => item.path.endsWith('/models.validators.generated.js')));
  await compile(value.root);
  copyStandalone(result, value);
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
