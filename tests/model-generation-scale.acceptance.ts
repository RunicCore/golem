import assert from 'node:assert/strict';
import test from 'node:test';

import { compileAndVerifyScaleProject, createScaleProject } from './scale-project.js';

// The Full tier compiles and executes 10 models; 100 may catch a shared-binding
// bug that 10 does not.
test('one hundred model companions compile and execute against shared standalone validation', async t => {
  const count = 100;
  const { root } = createScaleProject(t, count);
  const artifacts = await compileAndVerifyScaleProject(root, count);
  assert.equal(artifacts.filter(artifact => artifact.path.endsWith('.model.generated.ts')).length, count);
  assert.equal(artifacts.filter(artifact => artifact.path.endsWith('models.validators.generated.ts')).length, 1);
});
