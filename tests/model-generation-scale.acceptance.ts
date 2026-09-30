import assert from 'node:assert/strict';
import test from 'node:test';

import { compileAndVerifyScaleProject, generateScaleProject } from './scale-project.js';

// The Full tier compiles and executes 10 models; 100 may catch a shared-binding
// bug that 10 does not.
test('one hundred model companions compile and execute against shared standalone validation', async t => {
  const count = 100;
  const { root, result } = generateScaleProject(t, count);
  assert.equal(result.artifacts.filter(artifact => artifact.path.endsWith('.model.generated.ts')).length, count);
  assert.equal(result.artifacts.filter(artifact => artifact.path.endsWith('models.validators.generated.js')).length, 1);
  await compileAndVerifyScaleProject(root, result, count);
});
