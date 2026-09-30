import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { requireObjectCodec } from '@exprtlabs/codegen/serde';
import { getValidator } from '@exprtlabs/codegen/validation';
import { validationTagKey } from '@exprtlabs/codegen/schema';
import type { ModelTypeDescriptor } from '@exprtlabs/codegen/model';
import { generatedCodecIdFromRoot } from './packed/helpers.js';
import { generate, type ModelCodegenResult } from '#model/generator';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';

function fixture(t: TestContext) {
  return createModelProject(t, {
    prefix: 'runic-tag-model-boundaries-',
    name: 'tag-model-boundaries',
  });
}

function copyStandaloneArtifacts(result: ModelCodegenResult, root: string, sourceRoot: string): void {
  for (const artifact of result.artifacts.filter(item => item.path.endsWith('.generated.js'))) {
    const built = path.join(root, 'build', path.relative(sourceRoot, artifact.path));
    fs.mkdirSync(path.dirname(built), { recursive: true });
    fs.copyFileSync(artifact.path, built);
  }
}

async function runProfile(
  t: TestContext,
  writeSource: (sourceRoot: string) => void,
  modelName: string,
  ajvStandalone: boolean,
): Promise<{ readonly root: string; readonly model: Record<string, unknown> }> {
  const { root, sourceRoot } = fixture(t);
  writeSource(sourceRoot);
  const result = generate({ root, profile: { mobx: false, validation: true, ajvStandalone } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  if (ajvStandalone) copyStandaloneArtifacts(result, root, sourceRoot);
  const moduleValue: unknown = await import(path.toNamespacedPath(path.join(root, `build/${modelName.toLowerCase()}.model.js`)));
  if (moduleValue === null || typeof moduleValue !== 'object') throw new Error(`Missing generated ${modelName} module.`);
  const modelConstructor: unknown = Reflect.get(moduleValue, modelName);
  if (typeof modelConstructor !== 'function') throw new Error(`Missing generated ${modelName} constructor.`);
  return { root, model: { constructor: modelConstructor } };
}

function constructorOf(value: Record<string, unknown>): new (values?: never) => object {
  const constructor = value.constructor;
  if (typeof constructor !== 'function') throw new TypeError('Generated model constructor is unavailable.');
  return constructor as new (values?: never) => object;
}

test('tag keys preserve user fields named like descriptor metadata', () => {
  const schema = (property: string, value: ModelTypeDescriptor): ModelTypeDescriptor => ({
    kind: 'object',
    properties: { [property]: value },
    required: [property],
    additionalProperties: false,
  });
  const array: ModelTypeDescriptor = { kind: 'array', item: { kind: 'unknown' } };
  const dateKey = validationTagKey(array, {
    constraints: [{ kind: 'contains', schema: schema('date', { kind: 'string' }) }],
    validations: [],
  }, { representation: 'model' });
  const serdeKey = validationTagKey(array, {
    constraints: [{ kind: 'contains', schema: schema('serde', { kind: 'number' }) }],
    validations: [],
  }, { representation: 'model' });
  assert.notEqual(dateKey, serdeKey, 'user property names must remain part of the tag identity');
});

test('root property cardinality ignores handwritten state and still checks serde wire output', async t => {
  for (const ajvStandalone of [false, true]) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async profileTest => {
      const loaded = await runProfile(profileTest, sourceRoot => {
      fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/tag-model-boundaries/root-property-cardinality-ignores-handwritten-state-and-still-checks-serde-w/codecs.ts"));
      fs.writeFileSync(path.join(sourceRoot, 'box.model.ts'), readFixture("models/tag-model-boundaries/root-property-cardinality-ignores-handwritten-state-and-still-checks-serde-w/box.model.ts"));
      }, 'Box', ajvStandalone);
      const Box = constructorOf(loaded.model);
      const valid = Reflect.construct(Box, [{ code: 7 }]);
      const empty = Reflect.construct(Box, [{}]);
      const two = Reflect.construct(Box, [{ code: 7, label: 'too many' }]);
      const validator = (value: object): { readonly validate: () => Promise<boolean>; readonly issues: readonly unknown[] } => {
        const candidate = getValidator(value);
        return { validate: () => candidate.validate(), issues: candidate.issues };
      };
      assert.equal(await validator(valid).validate(), true, `${ajvStandalone ? 'AOT' : 'JIT'} accepts a valid model with handwritten state`);
      const wire = encodeGeneratedModel(valid);
      assert.deepEqual(wire, { code: '7' }, `${ajvStandalone ? 'AOT' : 'JIT'} preserves the declared serde wire shape`);
      assert.equal(await validator(empty).validate(), false, `${ajvStandalone ? 'AOT' : 'JIT'} enforces minProperties`);
      assert.equal(await validator(two).validate(), false, `${ajvStandalone ? 'AOT' : 'JIT'} enforces maxProperties`);
    });
  }
});

test('Contains<TChild> accepts a handwritten child instance with exact child fields', async t => {
  for (const ajvStandalone of [false, true]) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async profileTest => {
      const loaded = await runProfile(profileTest, sourceRoot => {
      fs.writeFileSync(path.join(sourceRoot, 'child.model.ts'), readFixture("models/tag-model-boundaries/contains-tchild-accepts-a-handwritten-child-instance-with-exact-child-fields/child.model.ts"));
      fs.writeFileSync(path.join(sourceRoot, 'parent.model.ts'), readFixture("models/tag-model-boundaries/contains-tchild-accepts-a-handwritten-child-instance-with-exact-child-fields/parent.model.ts"));
      }, 'Parent', ajvStandalone);
      const childModule: unknown = await import(path.toNamespacedPath(path.join(loaded.root, 'build/child.model.js')));
      if (childModule === null || typeof childModule !== 'object') throw new Error('Missing generated Child module.');
      const childConstructor: unknown = Reflect.get(childModule, 'Child');
      const Parent = constructorOf(loaded.model);
      if (typeof childConstructor !== 'function') throw new Error('Missing generated Child constructor.');
      const child = Reflect.construct(childConstructor, [{ name: 'nested' }]);
      const parent = Reflect.construct(Parent, [{ children: [child], metadata: { children: [child], mode: 'loaded' } }]);
      const candidate = getValidator(parent);
      const valid = await candidate.validate();
      const issues = candidate.issues;
      assert.equal(
        valid,
        true,
        `${ajvStandalone ? 'AOT' : 'JIT'} accepts a nested handwritten child through Contains and DependentSchemas: ${JSON.stringify(issues)}`,
      );
      assert.deepEqual(issues, [], 'nested child validation issues');
      const empty = Reflect.construct(Parent, [{ children: [], metadata: { children: [child], mode: 'loaded' } }]);
      const emptyValidator = getValidator(empty);
      assert.equal(
        await emptyValidator.validate(),
        false,
        `${ajvStandalone ? 'AOT' : 'JIT'} still enforces Contains after accepting a handwritten child`,
      );
    });
  }
});

test('exact objects keep pattern properties aligned with generated validation', async t => {
  for (const ajvStandalone of [false, true]) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async profileTest => {
      const loaded = await runProfile(profileTest, sourceRoot => {
        fs.writeFileSync(path.join(sourceRoot, 'predicates.ts'), readFixture("models/tag-model-boundaries/exact-objects-keep-pattern-properties-aligned-with-generated-validation/predicates.ts"));
        fs.writeFileSync(path.join(sourceRoot, 'box.model.ts'), readFixture("models/tag-model-boundaries/exact-objects-keep-pattern-properties-aligned-with-generated-validation/box.model.ts"));
      }, 'Box', ajvStandalone);
      const Box = constructorOf(loaded.model);
      const predicates = await import(path.toNamespacedPath(path.join(loaded.root, 'build/predicates.js')));
      predicates.reset();
      const valid = Reflect.construct(Box, [{ payload: { known: 'yes', x_count: 2 } }]);
      assert.equal(await getValidator(valid).validate(), true, 'pattern-declared key is accepted by exact model validation');
      assert.equal(predicates.calls, 1, 'pattern predicate runs once');
      const invalidPattern = Reflect.construct(Box, [{ payload: { known: 'yes', x_count: -1 } }]);
      assert.equal(await getValidator(invalidPattern).validate(), false, 'pattern predicate rejects invalid value');
      assert.throws(
        () => requireObjectCodec(generatedCodecIdFromRoot(loaded.root, 'Box')).fromWireFormat({
          payload: { known: 'yes', other: 2 },
        }),
        'unmatched exact key remains rejected',
      );
    });
  }
});

test('Date descriptors in Contains and DependentSchemas validate model Date values', async t => {
  for (const ajvStandalone of [false, true]) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async profileTest => {
      const loaded = await runProfile(profileTest, sourceRoot => {
      fs.writeFileSync(path.join(sourceRoot, 'calendar.model.ts'), readFixture("models/tag-model-boundaries/date-descriptors-in-contains-and-dependentschemas-validate-model-date-values/calendar.model.ts"));
      }, 'Calendar', ajvStandalone);
      const Calendar = constructorOf(loaded.model);
      const calendar = Reflect.construct(Calendar, [{ dates: [new Date('2025-01-02T03:04:05.000Z')], metadata: { dates: [new Date('2025-01-02T03:04:05.000Z')], mode: 'dated' } }]);
      const candidate = getValidator(calendar);
      const valid = await candidate.validate();
      const issues = candidate.issues;
      assert.equal(
        valid,
        true,
        `${ajvStandalone ? 'AOT' : 'JIT'} accepts model Date values in structural schemas: ${JSON.stringify(issues)}`,
      );
      assert.deepEqual(issues, [], 'Date structural validation issues');
      const wireInput = {
        dates: ['2025-01-02T03:04:05.000Z'],
        metadata: { dates: ['2025-01-02T03:04:05.000Z'], mode: 'dated' },
      };
      const decoded = await (await import('@exprtlabs/codegen/conversion')).decodeGeneratedModel(
        constructorOf(loaded.model),
        wireInput,
      ) as { dates: unknown[]; metadata: { dates: unknown[] } };
      assert.ok(decoded.dates[0] instanceof Date, `${ajvStandalone ? 'AOT' : 'JIT'} accepts wire date-time strings`);
      const assigned = Reflect.construct(constructorOf(loaded.model), [{
        dates: [new Date('2025-01-02T03:04:05.000Z')],
        metadata: { dates: [new Date('2025-01-02T03:04:05.000Z')], mode: 'dated' },
      }]);
      Reflect.set(assigned, 'dates', ['2025-01-02T03:04:05.000Z']);
      const invalidValidator = getValidator(assigned);
      assert.equal(
        await invalidValidator.validate(),
        false,
        `${ajvStandalone ? 'AOT' : 'JIT'} rejects wire strings when supplied as model-plane Date values`,
      );
    });
  }
});

test('discriminated union tag projections retain the selected branch fields', async t => {
  for (const ajvStandalone of [false, true]) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async profileTest => {
      const loaded = await runProfile(profileTest, sourceRoot => {
        fs.writeFileSync(path.join(sourceRoot, 'zoo.model.ts'), readFixture("models/tag-model-boundaries/discriminated-union-tag-projections-retain-the-selected-branch-fields/zoo.model.ts"));
      }, 'Zoo', ajvStandalone);
      const Zoo = constructorOf(loaded.model);
      const zoo = Reflect.construct(Zoo, [{ pets: [{ kind: 'dog', name: 'Rex', bark: true }] }]);
      const validator = getValidator(zoo);
      assert.equal(
        await validator.validate(),
        true,
        `${ajvStandalone ? 'AOT' : 'JIT'} keeps the dog branch fields during Contains validation`,
      );
      const invalid = Reflect.construct(Zoo, [{ pets: [{ kind: 'dog', name: 'Rex' }] }]);
      assert.equal(await getValidator(invalid).validate(), false, 'missing selected-branch fields remain invalid');
    });
  }
});

test('shared generated instances are projected independently for different tag descriptors', async t => {
  for (const ajvStandalone of [false, true]) {
    await t.test(ajvStandalone ? 'standalone' : 'runtime', async profileTest => {
      const loaded = await runProfile(profileTest, sourceRoot => {
        fs.writeFileSync(path.join(sourceRoot, 'child.model.ts'), readFixture("models/tag-model-boundaries/shared-generated-instances-are-projected-independently-for-different-tag-des/child.model.ts"));
        fs.writeFileSync(path.join(sourceRoot, 'shared.model.ts'), readFixture("models/tag-model-boundaries/shared-generated-instances-are-projected-independently-for-different-tag-des/shared.model.ts"));
      }, 'Shared', ajvStandalone);
      const childModule: unknown = await import(path.toNamespacedPath(path.join(loaded.root, 'build/child.model.js')));
      if (childModule === null || typeof childModule !== 'object') throw new Error('Missing generated Child module.');
      const Child = Reflect.get(childModule, 'Child');
      if (typeof Child !== 'function') throw new Error('Missing generated Child constructor.');
      const Shared = constructorOf(loaded.model);
      const child = Reflect.construct(Child, [{ value: 'ok', extra: 1 }]);
      const shared = Reflect.construct(Shared, [{ first: { value: 'ok' }, second: child }]);
      const validator = getValidator(shared);
      assert.equal(
        await validator.validate(),
        true,
        `${ajvStandalone ? 'AOT' : 'JIT'} validates Pick and full nested models independently`,
      );
      Reflect.set(shared, 'first', child);
      assert.equal(
        await getValidator(shared).validate(),
        false,
        `${ajvStandalone ? 'AOT' : 'JIT'} rejects extra enumerable fields on an exact Pick field`,
      );
    });
  }
});
