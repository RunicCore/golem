import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildModelProject, createModelProject, writeModelGolemYaml, type ModelProject } from './model-project.js';
import { getValidator } from '@exprtlabs/golem/validation';

function fixture(t: TestContext): ModelProject {
  return createModelProject(t, { prefix: 'golem-constraint-callback-', name: 'constraint-callback-composition', linkTypescript: true });
}

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

test('nested Contains callback composition composes callbacks through generated validation', async t => {
  const fixtureData = fixture(t);
  writeGeneratedArtifacts([
    {
      path: path.join(fixtureData.sourceRoot, 'predicates.ts'),
      content: readFixture('models/constraint-callback-composition/constraint-callback-composition-predicates/predicates.ts'),
    },
    {
      path: path.join(fixtureData.sourceRoot, 'a.model.ts'),
      content: readFixture('models/constraint-callback-composition/nested-value-callbacks/a.model.ts'),
    },
    {
      path: path.join(fixtureData.sourceRoot, 'predicates-2.ts'),
      content: readFixture('models/constraint-callback-composition/constraint-callback-composition-predicates/predicates-2.ts'),
    },
    {
      path: path.join(fixtureData.sourceRoot, 'child.model.ts'),
      content: readFixture('models/constraint-callback-composition/handwritten-child/child.model.ts'),
    },
    {
      path: path.join(fixtureData.sourceRoot, 'parent.model.ts'),
      content: readFixture('models/constraint-callback-composition/handwritten-child-parent/a.model.ts'),
    },
  ]);

  writeModelGolemYaml(fixtureData.root, { validation: true });
  await compile(fixtureData.root);

  const generated = await import(path.toNamespacedPath(path.join(fixtureData.root, 'build/a.model.js')));
  const predicates = await import(path.toNamespacedPath(path.join(fixtureData.root, 'build/predicates.js')));
  assert.equal(predicates.positiveCalls, 0, 'generation must not execute the callback');
  assert.equal(predicates.nestedPositiveCalls, 0, 'generation must not execute the control callback');

  predicates.reset();
  const validContains = new generated.A({ values: [3] });
  assert.equal(await getValidator(validContains).validate(), true, 'a positive Contains element is accepted');
  assert.equal(predicates.positiveCalls, 1, 'Contains callback runs once for one matching candidate');
  assert.equal(predicates.nestedPositiveCalls, 0, 'unrelated nested control is not evaluated');

  predicates.reset();
  const invalidContains = new generated.A({ values: [-1] });
  assert.equal(await getValidator(invalidContains).validate(), false, 'a non-positive Contains element is rejected');
  assert.equal(predicates.positiveCalls, 1, 'a rejected Contains candidate does not invoke the callback twice');
  assert.equal(predicates.nestedPositiveCalls, 0, 'unrelated nested control is not evaluated');

  predicates.reset();
  const invalidTypeContains = new generated.A({ values: ['not-a-number'] });
  assert.equal(await getValidator(invalidTypeContains).validate(), false, 'a wrong-shaped Contains candidate is rejected');
  assert.equal(predicates.positiveCalls, 0, 'a wrong-shaped candidate does not invoke a number predicate');
  assert.equal(predicates.nestedPositiveCalls, 0, 'a wrong-shaped candidate does not invoke unrelated callbacks');

  predicates.reset();
  const validPlain = new generated.A({ plain: { value: 4 } });
  assert.equal(await getValidator(validPlain).validate(), true, 'the nested plain callback control is accepted');
  assert.equal(predicates.positiveCalls, 0, 'Contains callback is not evaluated for the control case');
  assert.equal(predicates.nestedPositiveCalls, 1, 'a nested plain callback runs exactly once');

  predicates.reset();
  const invalidPlain = new generated.A({ plain: { value: 0 } });
  assert.equal(await getValidator(invalidPlain).validate(), false, 'the nested plain callback control rejects a bad value');
  assert.equal(predicates.positiveCalls, 0, 'Contains callback is not evaluated for the control case');
  assert.equal(predicates.nestedPositiveCalls, 1, 'a rejected nested plain value does not invoke the callback twice');

  predicates.reset();
  const validOne = new generated.A({ one: 3 });
  assert.equal(await getValidator(validOne).validate(), true, 'oneOf accepts the positive numeric branch');
  assert.equal(predicates.positiveCalls, 1, 'oneOf invokes the selected numeric callback once');
  assert.equal(predicates.nonEmptyCalls, 0, 'oneOf does not invoke a mismatched string branch');

  predicates.reset();
  const invalidOne = new generated.A({ one: -1 });
  assert.equal(await getValidator(invalidOne).validate(), false, 'oneOf rejects a callback-invalid numeric branch');
  assert.equal(predicates.positiveCalls, 1, 'oneOf invokes the numeric callback once on failure');
  assert.equal(predicates.nonEmptyCalls, 0, 'oneOf suppresses the mismatched string callback');

  predicates.reset();
  const validNot = new generated.A({ blocked: -1 });
  assert.equal(await getValidator(validNot).validate(), true, 'not accepts a callback-invalid nested value');
  assert.equal(predicates.positiveCalls, 1, 'not invokes its nested callback once');

  predicates.reset();
  const invalidNot = new generated.A({ blocked: 2 });
  assert.equal(await getValidator(invalidNot).validate(), false, 'not rejects a callback-valid nested value');
  assert.equal(predicates.positiveCalls, 1, 'not invokes its nested callback once on failure');

  predicates.reset();
  const invalidConditional = new generated.A({ conditional: { kind: 'number', value: -1 } });
  assert.equal(await getValidator(invalidConditional).validate(), false, 'if/then rejects a callback-invalid selected branch');
  assert.equal(predicates.positiveCalls, 1, 'if/then invokes the selected callback once');

  predicates.reset();
  const validConditional = new generated.A({ conditional: { kind: 'text' } });
  assert.equal(await getValidator(validConditional).validate(), true, 'if/else accepts the alternate branch');
  assert.equal(predicates.positiveCalls, 0, 'if/else does not invoke the unselected callback');

  const childModule = await import(path.toNamespacedPath(path.join(fixtureData.root, 'build/child.model.js')));
  const parentModule = await import(path.toNamespacedPath(path.join(fixtureData.root, 'build/parent.model.js')));
  const childPredicates = await import(path.toNamespacedPath(path.join(fixtureData.root, 'build/predicates-2.js')));
  childPredicates.reset();
  const child = new childModule.Child({ name: 'nested' });
  const parent = new parentModule.Parent({ children: [child] });
  assert.equal(await getValidator(parent).validate(), true, 'the handwritten child satisfies the nested predicate');
  assert.equal(childPredicates.childCalls, 1, 'the nested callback runs once');
  assert.equal(childPredicates.lastChild, child, 'the nested callback receives the original child instance');
});
