import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { command } from './support/process.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { copyFixture, fileFixtureScope, onceShared, readFixture, type FixtureScope } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';

function tupleModelProject(scope: FixtureScope, name: string) {
  return createModelProject(scope, {
    prefix: `golem-${name}-`,
    name,
    linkWorkspaceNodeModules: true,
  });
}

interface BuiltTuple {
  readonly Tuple: new (values?: object) => object;
  readonly codec: ReturnType<typeof requireObjectCodec>;
}

/** Builds the tuple model with `validation` and loads it. */
async function buildTuple(scope: FixtureScope, name: string, validation: boolean): Promise<BuiltTuple> {
  const { root, sourceRoot } = tupleModelProject(scope, name);
  fs.writeFileSync(path.join(sourceRoot, 'tuple.model.ts'), readFixture('models/model-tuples/tuple.model.ts'));
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  const loaded = await import(pathToFileURL(path.join(root, 'build/tuple.model.js')).href) as Pick<BuiltTuple, 'Tuple'>;
  return { Tuple: loaded.Tuple, codec: requireObjectCodec(generatedCodecIdFromRoot(root, 'TTuple')) };
}

// The tests that only read the tuple model with validation off share one build of it.
const fileScope = fileFixtureScope();
const trustedTuple = onceShared(() => buildTuple(fileScope, 'tuple-trusted', false));

test('generated optional and rest tuples retain exact lengths through every serde direction with validation on and off', async t => {
  for (const validation of [false, true]) {
    const { Tuple, codec } = await buildTuple(t, `tuple-${validation ? 'validated' : 'trusted'}`, validation);
    const omitted = new Tuple({ required: ['required', 9], maybe: ['x'], rest: ['prefix', true] });
    const full = new Tuple({ required: ['required', 9], maybe: ['x', 2], nested: ['inner'], rest: ['prefix', 1, 2, true] });
    const options = { validate: validation };

    for (const value of [omitted, full]) {
      const wire = codec.toWireFormat(value, options) as Record<string, unknown>;
      const text = codec.stringify(value, options);
      const parsed = codec.parse(text, options) as Record<string, unknown>;
      const decoded = codec.fromWireFormat(wire, options) as Record<string, unknown>;
      assert.deepEqual(decoded, wire);
      const json = JSON.parse(text) as Record<string, unknown>;
      for (const field of ['required', 'maybe', 'rest'] as const) {
        assert.deepEqual(parsed[field], wire[field]);
        assert.deepEqual(json[field], wire[field]);
        assert.equal((wire[field] as unknown[]).length, (value as { required: unknown[]; maybe: unknown[]; rest: unknown[] })[field].length);
      }
      if ((value as { nested?: unknown }).nested !== undefined) {
        assert.deepEqual(parsed.nested, wire.nested);
        assert.deepEqual(json.nested, wire.nested);
        assert.equal((wire.nested as unknown[]).length, 1);
      } else {
        assert.equal(Object.hasOwn(wire, 'nested'), false);
        assert.equal(Object.hasOwn(json, 'nested'), false);
      }
    }

    const invalidRequired = new Tuple({ required: ['only'] as never, maybe: ['x'], rest: ['prefix'] as never });
    if (validation) {
      assert.throws(() => codec.stringify(invalidRequired, options), /validation|tuple|boolean/i);
    } else {
      for (const maybe of [null, 17, { unexpected: true }]) {
        const value = { required: ['fixed', 1], maybe, rest: ['prefix', true] };
        const wire = codec.toWireFormat(value, options);
        assert.deepEqual(codec.fromWireFormat(wire, options), wire);
        assert.deepEqual(JSON.parse(codec.stringify(value, options)), value);
      }
    }
  }
});

test('readonly array and tuple contracts survive model generation and strict consumer compilation', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-model-tuples-',
    name: 'model-tuples',
    compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
  });
  copyFixture(root, 'models/model-tuples/readonly');
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
});

test('readonly container metadata does not fork semantic runtime codec identity', () => {
  const descriptor = (readonly: boolean) => ({
    kind: 'object' as const,
    properties: {
      names: { kind: 'array' as const, ...(readonly ? { isReadonly: true as const } : {}), item: { kind: 'string' as const } },
      trailing: {
        kind: 'tuple' as const,
        ...(readonly ? { isReadonly: true as const } : {}),
        items: [{ kind: 'string' as const }, { kind: 'boolean' as const }],
        rest: { index: 1, item: { kind: 'number' as const } },
      },
    },
    required: ['names', 'trailing'],
    additionalProperties: false as const,
  });
  const mutable = createSchemaGraph().intern(descriptor(false), 'Collections');
  const readonly = createSchemaGraph().intern(descriptor(true), 'Collections');
  assert.equal(readonly.codecId, mutable.codecId);
});

test('validation-enabled codec emission compiles and preserves array and tuple getter reads', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-model-tuples-',
    name: 'model-tuples',
    compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
  });
  copyFixture(root, 'models/model-tuples/getter');
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const codecId = generatedCodecIdFromRoot(root, 'TSnapshot');
  const verifier = path.join(root, 'verify-array-getters.mjs');
  await command(root, process.execPath, [verifier, codecId]);
});

test('a model keeps a short rest tuple at its own length and a hole in it a hole, with validation off', async () => {
  const { Tuple } = await trustedTuple();
  const field = (value: unknown, name: string): unknown => {
    assert.ok(typeof value === 'object' && value !== null && name in value);
    return Reflect.get(value, name);
  };
  const init = { required: ['required', 9], maybe: ['x'], rest: ['only'] };
  assert.deepEqual(field(new Tuple(init), 'rest'), ['only']);
  assert.deepEqual(field(decodeGeneratedModel(Tuple, init), 'rest'), ['only']);
  assert.deepEqual(field(encodeGeneratedModel(new Tuple(init)), 'rest'), ['only']);

  // The Date item after the rest has no input, so converting it would throw on `undefined`.
  const short = { ...init, dated: ['only'] };
  assert.deepEqual(field(new Tuple(short), 'dated'), ['only']);
  assert.deepEqual(field(decodeGeneratedModel(Tuple, short), 'dated'), ['only']);
  assert.deepEqual(field(encodeGeneratedModel(new Tuple(short)), 'dated'), ['only']);

  const holey: unknown[] = ['first'];
  holey[2] = '2024-05-06T07:08:09.000Z';
  const sparse = { ...init, dated: holey };
  for (const dated of [field(new Tuple(sparse), 'dated'), field(decodeGeneratedModel(Tuple, sparse), 'dated')]) {
    assert.ok(Array.isArray(dated));
    assert.equal(dated.length, 3);
    assert.equal(1 in dated, false);
  }
  const decoded = field(decodeGeneratedModel(Tuple, sparse), 'dated');
  assert.ok(Array.isArray(decoded));
  assert.deepEqual(decoded[2], new Date('2024-05-06T07:08:09.000Z'));
});

test('a codec decode error names the index of a bad tuple item and of a bad item in a scalar-or-array union', async () => {
  const { codec } = await trustedTuple();

  const decode = (override: object) => () =>
    codec.fromWireFormat({ required: ['required', 9], maybe: ['x'], rest: ['prefix', true], ...override }, { validate: false });
  const failsAt = (path: readonly (string | number)[]) => (error: unknown): true => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  };

  assert.throws(decode({ dated: ['first', '2024-05-06T07:08:09.000Z', 'not a date', '2024-05-06T07:08:09.000Z'] }), failsAt(['dated', 2]));
  assert.throws(decode({ dated: ['first', '2024-05-06T07:08:09.000Z', 'not a date'] }), failsAt(['dated', 2]));
  assert.throws(decode({ when: ['2024-05-06T07:08:09.000Z', 'not a date'] }), failsAt(['when', 1]));
});

test('a scalar value of a scalar-or-array union stays as it is, and the array items still convert', async () => {
  const { Tuple, codec } = await trustedTuple();
  const options = { validate: false };
  const field = (value: unknown, name: string): unknown => {
    assert.ok(typeof value === 'object' && value !== null && name in value);
    return Reflect.get(value, name);
  };
  const base = { required: ['required', 9], maybe: ['x'], rest: ['prefix', true] };
  const day = '2024-05-06T07:08:09.000Z';

  // codec decode
  assert.equal(field(codec.fromWireFormat({ ...base, when: 'hello' }, options), 'when'), 'hello');
  assert.equal(field(codec.fromWireFormat({ ...base, when: '12' }, options), 'when'), '12');
  assert.deepEqual(field(codec.fromWireFormat({ ...base, when: [day] }, options), 'when'), [new Date(day)]);
  assert.equal(field(codec.parse(JSON.stringify({ ...base, when: '12' }), options), 'when'), '12');

  // codec encode and the JSON text
  assert.equal(field(codec.toWireFormat(new Tuple({ ...base, when: 'hello' }), options), 'when'), 'hello');
  assert.deepEqual(field(codec.toWireFormat(new Tuple({ ...base, when: [new Date(day)] }), options), 'when'), [day]);
  assert.equal(field(JSON.parse(codec.stringify(new Tuple({ ...base, when: 'hello' }), options)), 'when'), 'hello');
  assert.deepEqual(field(JSON.parse(codec.stringify(new Tuple({ ...base, when: [new Date(day)] }), options)), 'when'), [day]);

  // model fromJSON and toJSON
  assert.equal(field(decodeGeneratedModel(Tuple, { ...base, when: 'hello' }), 'when'), 'hello');
  assert.equal(field(decodeGeneratedModel(Tuple, { ...base, when: '12' }), 'when'), '12');
  assert.deepEqual(field(decodeGeneratedModel(Tuple, { ...base, when: [day] }), 'when'), [new Date(day)]);
  assert.equal(field(encodeGeneratedModel(new Tuple({ ...base, when: 'hello' })), 'when'), 'hello');
  assert.deepEqual(field(encodeGeneratedModel(new Tuple({ ...base, when: [new Date(day)] })), 'when'), [day]);
});

test('a scalar-or-tuple union keeps its scalar and converts the items of its tuple', async () => {
  const { Tuple, codec } = await trustedTuple();
  const options = { validate: false };
  const field = (value: unknown, name: string): unknown => {
    assert.ok(typeof value === 'object' && value !== null && name in value);
    return Reflect.get(value, name);
  };
  const failsAt = (path: readonly (string | number)[]) => (error: unknown): true => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  };
  const base = { required: ['required', 9], maybe: ['x'], rest: ['prefix', true] };
  const day = '2024-05-06T07:08:09.000Z';

  // codec decode
  assert.equal(field(codec.fromWireFormat({ ...base, pair: 'plain' }, options), 'pair'), 'plain');
  assert.deepEqual(field(codec.fromWireFormat({ ...base, pair: [day] }, options), 'pair'), [new Date(day)]);
  assert.equal(field(codec.parse(JSON.stringify({ ...base, pair: 'plain' }), options), 'pair'), 'plain');
  assert.deepEqual(field(codec.parse(JSON.stringify({ ...base, pair: [day] }), options), 'pair'), [new Date(day)]);
  assert.throws(() => codec.fromWireFormat({ ...base, pair: ['not a date'] }, options), failsAt(['pair', 0]));

  // codec encode and the JSON text
  assert.equal(field(codec.toWireFormat(new Tuple({ ...base, pair: 'plain' }), options), 'pair'), 'plain');
  assert.deepEqual(field(codec.toWireFormat(new Tuple({ ...base, pair: [new Date(day)] }), options), 'pair'), [day]);
  assert.equal(field(JSON.parse(codec.stringify(new Tuple({ ...base, pair: 'plain' }), options)), 'pair'), 'plain');
  assert.deepEqual(field(JSON.parse(codec.stringify(new Tuple({ ...base, pair: [new Date(day)] }), options)), 'pair'), [day]);

  // model fromJSON and toJSON
  assert.equal(field(decodeGeneratedModel(Tuple, { ...base, pair: 'plain' }), 'pair'), 'plain');
  assert.deepEqual(field(decodeGeneratedModel(Tuple, { ...base, pair: [day] }), 'pair'), [new Date(day)]);
  assert.equal(field(encodeGeneratedModel(new Tuple({ ...base, pair: 'plain' })), 'pair'), 'plain');
  assert.deepEqual(field(encodeGeneratedModel(new Tuple({ ...base, pair: [new Date(day)] })), 'pair'), [day]);
});
