import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { watchPipeline } from '#golem/cli';
import { generationWatchFixture } from './support/generation-watch.js';
import { command, golem } from './support/process.js';
import { until } from './support/watch-wait.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { readFixture } from './fixture-project.js';

const HALF_TYPED = [
  "import type { IModel } from '@exprtlabs/golem/model';",
  '',
  'export type TCart = IModel<{',
  '  note: string;',
  '  half: string &',
  '}>;',
  '',
].join('\n');
const SYNTAX_ERROR = /cart\.model\.ts\(6,1\): error TS1110: Type expected/;

/** A project whose valid model has been generated once, then edited to a half-typed field. */
async function brokenProject(t: TestContext): Promise<{ root: string; config: string }> {
  const project = generationWatchFixture(t);
  await command(project.root, process.execPath, [golem, 'generate']);
  fs.writeFileSync(path.join(project.root, 'src/cart.model.ts'), HALF_TYPED);
  return project;
}

/** The errors that `golem watch` reports on the project once it has reported the syntax error. */
async function watchErrors(config: string): Promise<readonly string[]> {
  const errors: string[] = [];
  const stop = watchPipeline(config, error => { errors.push(String(error)); });
  try {
    await until(() => errors.some(error => SYNTAX_ERROR.test(error)), () => `the syntax error is reported (errors=${errors.join('; ')})`);
  } finally {
    stop();
  }
  return errors;
}

// protects: T-310 a syntax error in a model source is reported as itself, not as RUNM1011
test('golem check reports the syntax error of a model source and not RUNM1011', async (t: TestContext) => {
  const { root } = await brokenProject(t);
  const result = await command(root, process.execPath, [golem, 'check'], { allowFailure: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, SYNTAX_ERROR);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /RUNM1011/);
});

// protects: T-310 golem watch reports the syntax error of a model source, not RUNM1011
test('golem watch reports the syntax error of a model source and not RUNM1011', async (t: TestContext) => {
  const { config } = await brokenProject(t);
  const errors = await watchErrors(config);
  assert.deepEqual(errors.filter(error => error.includes('RUNM1011')), []);
});

/** A project whose controllers job runs before its models job: the half-typed model is a model the controllers job analyses first. */
function controllersProject(t: TestContext): { root: string; config: string } {
  const root = createControllerFixture(t, {
    prefix: 'golem-syntax-error-controllers-',
    packageName: 'syntax-error-controllers',
    links: 'workspace',
    files: {
      'golem.yaml': 'version: 1\ncontrollers:\n  - framework: nestjs\n    root: .\n    output: ./generated/openapi.json\n    info:\n      title: Catalog API\n      version: "1"\nmodels:\n  root: .\n',
      'src/catalog.controller.ts': readFixture('controllers/watch/project/controller.ts').replace("import { routeFor } from './route-helper.js';\n", '').replace('routeFor(\'list\')', "'list'"),
      'src/cart.model.ts': HALF_TYPED,
    },
  });
  return { root, config: path.join(root, 'golem.yaml') };
}

// protects: T-310 a syntax error in a model source is reported as itself when a controllers job analyses the model first
for (const verb of ['generate', 'check']) {
  test(`golem ${verb} reports the syntax error of a model source and not RUNM1011 in a project with a controllers job`, async (t: TestContext) => {
    const { root } = controllersProject(t);
    if (verb === 'check') {
      fs.writeFileSync(path.join(root, 'src/cart.model.ts'), HALF_TYPED.replace('  half: string &\n', ''));
      await command(root, process.execPath, [golem, 'generate']);
      fs.writeFileSync(path.join(root, 'src/cart.model.ts'), HALF_TYPED);
    }
    const result = await command(root, process.execPath, [golem, verb], { allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, SYNTAX_ERROR);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /RUNM1011/);
  });
}

// protects: T-310 golem watch reports the syntax error of a model source, not RUNM1011, with a controllers job
test('golem watch reports the syntax error of a model source and not RUNM1011 in a project with a controllers job', async (t: TestContext) => {
  const { config } = controllersProject(t);
  const errors = await watchErrors(config);
  assert.deepEqual(errors.filter(error => error.includes('RUNM1011')), []);
});
