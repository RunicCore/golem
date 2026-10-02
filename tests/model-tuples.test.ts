import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { createSchemaGraph } from '@exprtlabs/golem/schema-graph';
import { command } from './support/process.js';
import { generatedCodecId } from './support/consumer.js';
import { copyFixture, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';
import { generate } from '#model/generator';

function tupleModelProject(t: TestContext, name: string) {
  return createModelProject(t, {
    prefix: `golem-${name}-`,
    name,
    linkWorkspaceNodeModules: true,
  });
}

test('generated optional and rest tuples retain exact lengths through every serde direction with validation on and off', async t => {
  for (const validation of [false, true]) {
    const { root, sourceRoot } = tupleModelProject(t, `tuple-${validation ? 'validated' : 'trusted'}`);
    const sourceFile = path.join(sourceRoot, 'tuple.model.ts');
    fs.writeFileSync(sourceFile, readFixture('models/model-tuples/tuple.model.ts'));
    const result = generate({ root, sources: [sourceFile], profile: { mobx: false, validation } });
    writeGeneratedArtifacts(result.artifacts);
    await compileModelProject(root);

    const loaded = await import(pathToFileURL(path.join(root, 'build/tuple.model.js')).href) as {
      readonly Tuple: new (values?: object) => object;
    };
    const codecId = generatedCodecId(result.artifacts.map(artifact => artifact.content).join('\n'), 'TTuple');
    const codec = requireObjectCodec(codecId);
    const omitted = new loaded.Tuple({ required: ['required', 9], maybe: ['x'], rest: ['prefix', true] });
    const full = new loaded.Tuple({ required: ['required', 9], maybe: ['x', 2], nested: ['inner'], rest: ['prefix', 1, 2, true] });
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

    const invalidRequired = new loaded.Tuple({ required: ['only'] as never, maybe: ['x'], rest: ['prefix'] as never });
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
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-model-tuples-',
    name: 'model-tuples',
    compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
  });
  copyFixture(root, 'models/model-tuples/readonly');
  const model = path.join(sourceRoot, 'snapshot.model.ts');
  const result = generate({ root, sources: [model], profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
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
  const sourceRoot = path.join(root, 'src');
  const model = path.join(sourceRoot, 'snapshot.model.ts');
  const result = generate({ root, sources: [model], profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  const codecId = generatedCodecId(result.artifacts.map((artifact) => artifact.content).join('\n'), 'TSnapshot');
  const verifier = path.join(root, 'verify-array-getters.mjs');
  await command(root, process.execPath, [verifier, codecId]);
});
