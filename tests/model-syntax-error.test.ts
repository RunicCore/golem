import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { watchPipeline } from '#golem/cli';
import { generationWatchFixture } from './support/generation-watch.js';
import { command, golem } from './support/process.js';
import { until } from './support/watch-wait.js';

const HALF_TYPED = [
  "import type { IModel } from '@exprtlabs/golem/model';",
  '',
  'export type TCart = IModel<{',
  '  note: string;',
  '  half: string &',
  '}>;',
  '',
].join('\n');
const SYNTAX_ERROR = /cart\.model\.ts:6:1 - error TS1110: Type expected/;

/** A project whose valid model has been generated once, then edited to a half-typed field. */
async function brokenProject(t: TestContext): Promise<{ root: string; config: string }> {
  const project = generationWatchFixture(t);
  await command(project.root, process.execPath, [golem, 'generate']);
  fs.writeFileSync(path.join(project.root, 'src/cart.model.ts'), HALF_TYPED);
  return project;
}

// protects: T-310 a syntax error in a model source is reported as itself, not as RUNM1011
for (const verb of ['generate', 'check']) {
  test(`golem ${verb} reports the syntax error of a model source and not RUNM1011`, async (t: TestContext) => {
    const { root } = await brokenProject(t);
    const result = await command(root, process.execPath, [golem, verb], { allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, SYNTAX_ERROR);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /RUNM1011/);
  });
}

test('golem watch reports the syntax error of a model source and not RUNM1011', async (t: TestContext) => {
  const { config } = await brokenProject(t);
  const errors: string[] = [];
  const stop = watchPipeline(config, error => { errors.push(String(error)); });
  try {
    await until(() => errors.some(error => SYNTAX_ERROR.test(error)), () => `the syntax error is reported (errors=${errors.join('; ')})`);
    assert.deepEqual(errors.filter(error => error.includes('RUNM1011')), []);
  } finally {
    stop();
  }
});
