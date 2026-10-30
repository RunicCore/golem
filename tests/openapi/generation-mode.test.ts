import { createFixtureProject, copyFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#openapi/generator';

const profile = { mobx: false, validation: true };

test('generate takes the standalone or golem mode of the job and refuses any other value', async (t) => {
  // protects: T-695 the mode reaches the generator and is validated there
  const directory = createFixtureProject(t, 'golem-openapi-mode-');
  copyFixture(directory, 'openapi/api/standalone');
  const input = path.join(directory, 'openapi.yaml');
  for (const mode of ['standalone', 'golem'] as const) {
    const result = await generate({ input, output: path.join(directory, mode), profile, mode });
    assert.equal(result.apiVersion, 1);
  }
  await assert.rejects(
    () => Reflect.apply(generate, undefined, [{ input, output: path.join(directory, 'hybrid'), profile, mode: 'hybrid' }]),
    new TypeError('context.mode must be "standalone" or "golem" when provided'),
  );
});
