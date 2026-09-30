import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { validationTagKey } from '@exprtlabs/golem/schema';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { generatedCodecId } from './support/consumer.js';
import { generate, type GolemModelResult } from '#model/generator';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';

function fixture(t: TestContext) {
  return createModelProject(t, {
    prefix: 'golem-tag-model-boundaries-',
    name: 'tag-model-boundaries',
  });
}

function copyStandaloneArtifacts(result: GolemModelResult, root: string, sourceRoot: string): void {
  for (const artifact of result.artifacts.filter(item => item.path.endsWith('.generated.js'))) {
    const built = path.join(root, 'build', path.relative(sourceRoot, artifact.path));
    fs.mkdirSync(path.dirname(built), { recursive: true });
    fs.copyFileSync(artifact.path, built);
  }
}

const fixtureRoot = 'models/tag-model-boundaries';
// Each scenario keeps its own directory in the shared project, so the same file names never collide.
const scenarios: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cardinality: {
    'codecs.ts': `${fixtureRoot}/root-property-cardinality-ignores-handwritten-state-and-still-checks-serde-w/codecs.ts`,
    'box.model.ts': `${fixtureRoot}/root-property-cardinality-ignores-handwritten-state-and-still-checks-serde-w/box.model.ts`,
  },
  contains: {
    'child.model.ts': `${fixtureRoot}/contains-tchild-accepts-a-handwritten-child-instance-with-exact-child-fields/child.model.ts`,
    'parent.model.ts': `${fixtureRoot}/contains-tchild-accepts-a-handwritten-child-instance-with-exact-child-fields/parent.model.ts`,
  },
  patterns: {
    'predicates.ts': `${fixtureRoot}/exact-objects-keep-pattern-properties-aligned-with-generated-validation/predicates.ts`,
    'box.model.ts': `${fixtureRoot}/exact-objects-keep-pattern-properties-aligned-with-generated-validation/box.model.ts`,
  },
  dates: {
    'calendar.model.ts': `${fixtureRoot}/date-descriptors-in-contains-and-dependentschemas-validate-model-date-values/calendar.model.ts`,
  },
  zoo: {
    'zoo.model.ts': `${fixtureRoot}/discriminated-union-tag-projections-retain-the-selected-branch-fields/zoo.model.ts`,
  },
  shared: {
    'child.model.ts': `${fixtureRoot}/shared-generated-instances-are-projected-independently-for-different-tag-des/child.model.ts`,
    'shared.model.ts': `${fixtureRoot}/shared-generated-instances-are-projected-independently-for-different-tag-des/shared.model.ts`,
  },
};

interface ScenarioProject {
  readonly root: string;
  readonly sourceRoot: string;
  /** Load a built module of one scenario directory, for example ('zoo', 'zoo.model.js'). */
  readonly load: (directory: string, file: string) => Promise<Record<string, unknown>>;
}

/** Generate and compile the named scenarios once, for one validator engine. */
async function buildScenarioProject(t: TestContext, ajvStandalone: boolean, names: readonly string[]): Promise<ScenarioProject> {
  const { root, sourceRoot } = fixture(t);
  for (const directory of names) {
    for (const [name, fixturePath] of Object.entries(scenarios[directory])) {
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, directory, name), readFixture(fixturePath));
    }
  }
  const result = generate({ root, profile: { mobx: false, validation: true, ajvStandalone } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  if (ajvStandalone) copyStandaloneArtifacts(result, root, sourceRoot);
  return {
    root,
    sourceRoot,
    load: async (directory, file) => {
      const moduleValue: unknown = await import(path.toNamespacedPath(path.join(root, 'build', directory, file)));
      if (moduleValue === null || typeof moduleValue !== 'object') throw new Error(`Missing generated module ${directory}/${file}.`);
      return moduleValue as Record<string, unknown>;
    },
  };
}

async function loadModel(project: ScenarioProject, directory: string, file: string, modelName: string): Promise<new (values?: never) => object> {
  const modelConstructor: unknown = Reflect.get(await project.load(directory, file), modelName);
  if (typeof modelConstructor !== 'function') throw new Error(`Missing generated ${modelName} constructor.`);
  return modelConstructor as new (values?: never) => object;
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

interface Check {
  readonly title: string;
  /** The scenario directory this check reads; a standalone project holds only this one. */
  readonly directory: string;
  readonly run: (project: ScenarioProject, engine: 'JIT' | 'AOT') => Promise<void>;
}

const checks: readonly Check[] = [
  {
    title: 'root property cardinality ignores handwritten state and still checks serde wire output',
    directory: 'cardinality',
    run: async (project, engine) => {
      const Box = await loadModel(project, 'cardinality', 'box.model.js', 'Box');
      const valid = Reflect.construct(Box, [{ code: 7 }]);
      const empty = Reflect.construct(Box, [{}]);
      const two = Reflect.construct(Box, [{ code: 7, label: 'too many' }]);
      const validator = (value: object): { readonly validate: () => Promise<boolean>; readonly issues: readonly unknown[] } => {
        const candidate = getValidator(value);
        return { validate: () => candidate.validate(), issues: candidate.issues };
      };
      assert.equal(await validator(valid).validate(), true, `${engine} accepts a valid model with handwritten state`);
      const wire = encodeGeneratedModel(valid);
      assert.deepEqual(wire, { code: '7' }, `${engine} preserves the declared serde wire shape`);
      assert.equal(await validator(empty).validate(), false, `${engine} enforces minProperties`);
      assert.equal(await validator(two).validate(), false, `${engine} enforces maxProperties`);
    },
  },
  {
    title: 'Contains<TChild> accepts a handwritten child instance with exact child fields',
    directory: 'contains',
    run: async (project, engine) => {
      const Parent = await loadModel(project, 'contains', 'parent.model.js', 'Parent');
      const Child = await loadModel(project, 'contains', 'child.model.js', 'Child');
      const child = Reflect.construct(Child, [{ name: 'nested' }]);
      const parent = Reflect.construct(Parent, [{ children: [child], metadata: { children: [child], mode: 'loaded' } }]);
      const candidate = getValidator(parent);
      const valid = await candidate.validate();
      const issues = candidate.issues;
      assert.equal(
        valid,
        true,
        `${engine} accepts a nested handwritten child through Contains and DependentSchemas: ${JSON.stringify(issues)}`,
      );
      assert.deepEqual(issues, [], 'nested child validation issues');
      const empty = Reflect.construct(Parent, [{ children: [], metadata: { children: [child], mode: 'loaded' } }]);
      const emptyValidator = getValidator(empty);
      assert.equal(
        await emptyValidator.validate(),
        false,
        `${engine} still enforces Contains after accepting a handwritten child`,
      );
    },
  },
  {
    title: 'exact objects keep pattern properties aligned with generated validation',
    directory: 'patterns',
    run: async (project, engine) => {
      const Box = await loadModel(project, 'patterns', 'box.model.js', 'PatternBox');
      const predicates = await project.load('patterns', 'predicates.js') as { reset(): void; calls: number };
      predicates.reset();
      const valid = Reflect.construct(Box, [{ payload: { known: 'yes', x_count: 2 } }]);
      assert.equal(await getValidator(valid).validate(), true, 'pattern-declared key is accepted by exact model validation');
      assert.equal(predicates.calls, 1, 'pattern predicate runs once');
      const invalidPattern = Reflect.construct(Box, [{ payload: { known: 'yes', x_count: -1 } }]);
      assert.equal(await getValidator(invalidPattern).validate(), false, 'pattern predicate rejects invalid value');
      const patternBoxCodec = generatedCodecId(fs.readFileSync(path.join(project.sourceRoot, 'patterns/box.model.generated.ts'), 'utf8'), 'PatternBox');
      assert.throws(
        () => requireObjectCodec(patternBoxCodec).fromWireFormat({
          payload: { known: 'yes', other: 2 },
        }),
        'unmatched exact key remains rejected',
      );
    },
  },
  {
    title: 'Date descriptors in Contains and DependentSchemas validate model Date values',
    directory: 'dates',
    run: async (project, engine) => {
      const Calendar = await loadModel(project, 'dates', 'calendar.model.js', 'Calendar');
      const calendar = Reflect.construct(Calendar, [{ dates: [new Date('2025-01-02T03:04:05.000Z')], metadata: { dates: [new Date('2025-01-02T03:04:05.000Z')], mode: 'dated' } }]);
      const candidate = getValidator(calendar);
      const valid = await candidate.validate();
      const issues = candidate.issues;
      assert.equal(
        valid,
        true,
        `${engine} accepts model Date values in structural schemas: ${JSON.stringify(issues)}`,
      );
      assert.deepEqual(issues, [], 'Date structural validation issues');
      const wireInput = {
        dates: ['2025-01-02T03:04:05.000Z'],
        metadata: { dates: ['2025-01-02T03:04:05.000Z'], mode: 'dated' },
      };
      const decoded = decodeGeneratedModel(Calendar, wireInput) as { dates: unknown[]; metadata: { dates: unknown[] } };
      assert.ok(decoded.dates[0] instanceof Date, `${engine} accepts wire date-time strings`);
      const assigned = Reflect.construct(Calendar, [{
        dates: [new Date('2025-01-02T03:04:05.000Z')],
        metadata: { dates: [new Date('2025-01-02T03:04:05.000Z')], mode: 'dated' },
      }]);
      Reflect.set(assigned, 'dates', ['2025-01-02T03:04:05.000Z']);
      const invalidValidator = getValidator(assigned);
      assert.equal(
        await invalidValidator.validate(),
        false,
        `${engine} rejects wire strings when supplied as model-plane Date values`,
      );
    },
  },
  {
    title: 'discriminated union tag projections retain the selected branch fields',
    directory: 'zoo',
    run: async (project, engine) => {
      const Zoo = await loadModel(project, 'zoo', 'zoo.model.js', 'Zoo');
      const zoo = Reflect.construct(Zoo, [{ pets: [{ kind: 'dog', name: 'Rex', bark: true }] }]);
      const validator = getValidator(zoo);
      assert.equal(
        await validator.validate(),
        true,
        `${engine} keeps the dog branch fields during Contains validation`,
      );
      const invalid = Reflect.construct(Zoo, [{ pets: [{ kind: 'dog', name: 'Rex' }] }]);
      assert.equal(await getValidator(invalid).validate(), false, 'missing selected-branch fields remain invalid');
    },
  },
  {
    title: 'shared generated instances are projected independently for different tag descriptors',
    directory: 'shared',
    run: async (project, engine) => {
      const Child = await loadModel(project, 'shared', 'child.model.js', 'SharedChild');
      const Shared = await loadModel(project, 'shared', 'shared.model.js', 'Shared');
      const child = Reflect.construct(Child, [{ value: 'ok', extra: 1 }]);
      const shared = Reflect.construct(Shared, [{ first: { value: 'ok' }, second: child }]);
      const validator = getValidator(shared);
      assert.equal(
        await validator.validate(),
        true,
        `${engine} validates Pick and full nested models independently`,
      );
      Reflect.set(shared, 'first', child);
      assert.equal(
        await getValidator(shared).validate(),
        false,
        `${engine} rejects extra enumerable fields on an exact Pick field`,
      );
    },
  },
];

// The runtime engine holds every scenario in one project. Standalone validation cannot: models in one
// project each name their first anonymous structural schema `__anon_1`, and generate() throws "Conflicting
// standalone schema identity" when two models carry different ones. So each standalone check keeps its own
// project.
test('tag boundary scenarios share one runtime project', async t => {
  const project = await buildScenarioProject(t, false, checks.map(check => check.directory));
  for (const check of checks) await t.test(check.title, () => check.run(project, 'JIT'));
});

test('tag boundary scenarios each compile in their own standalone project', async t => {
  for (const check of checks) {
    await t.test(check.title, async subtest => {
      await check.run(await buildScenarioProject(subtest, true, [check.directory]), 'AOT');
    });
  }
});
