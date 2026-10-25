// lane: typescript6 ProgramSession resolution updates when a validator module recovers
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { runPipeline } from '#golem/pipeline';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';
import { until } from './support/watch-wait.js';
import { runLines } from './support/watch-runs.js';

/** A validators module: `validators.generated.ts` of an SDK, or `<name>.validators.generated.ts` of a model job. */
const VALIDATOR_MODULE = /(?:^|\/)(?:[^/]*\.)?validators\.generated\.ts$/;

/** The SDK writes one validators module at its root, for its models and its operations. */
function sdkValidatorModules(root: string): string[] {
  return fs.existsSync(path.join(root, 'sdk/validators.generated.ts')) ? ['validators.generated.ts'] : [];
}

function fixture(t: TestContext) {
  const root = createFixtureProject(t, 'golem-validator-recovery-');

  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const model = path.join(root, 'src/cart.model.ts');
  copyFixtureFile(root, 'pipeline/validator-module-recovery/cart.model.ts', 'src/cart.model.ts');
  const config = path.join(root, 'golem.yaml');
  /** A model edit that changes the generated outputs, so the next run rewrites them. */
  const addProbe = (name: string) => {
    fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace('note: string', `note: string; ${name}?: string`));
  };
  return { root, model, config, addProbe, inventory: path.join(root, '.golem/outputs.json') };
}

test('an interrupted inventory replacement recovers and the validators stay in place', async t => {
  const setup = fixture(t);
  await runPipeline(setup.config);
  assert.equal(sdkValidatorModules(setup.root).length, 1, 'the SDK has one validators module');
  const originalInventory = fs.readFileSync(setup.inventory, 'utf8');
  setup.addProbe('first');
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === setup.inventory) throw new Error('interrupted inventory replacement');
    rename(source, destination);
  });
  await assert.rejects(runPipeline(setup.config), /interrupted inventory replacement/);
  fault.mock.restore();
  assert.equal(fs.readFileSync(setup.inventory, 'utf8'), originalInventory);
  assert.equal(sdkValidatorModules(setup.root).length, 1, 'the interrupted run left the SDK validators in place');
  const recovered = await runPipeline(setup.config);
  await runPipeline(setup.config, { check: true });
  const files: Record<string, unknown> = JSON.parse(fs.readFileSync(setup.inventory, 'utf8')).files;
  const validators = Object.keys(files).filter(filename => VALIDATOR_MODULE.test(filename));
  const emittedValidators = [...recovered.results.values()].flatMap(result => result.artifacts)
    .filter(artifact => VALIDATOR_MODULE.test(artifact.path))
    .map(artifact => path.relative(setup.root, artifact.path));
  assert.ok(emittedValidators.length > 0, 'the recovered run emitted a validator module');
  // The probe changes only the frontend module; the SDK files the interrupted run wrote are not emitted again, so the recovered run emits a subset.
  for (const filename of emittedValidators) assert.ok(validators.includes(filename), `${filename} is inventoried`);
  const validatorsOf = (inventory: string) => Object.keys((JSON.parse(inventory) as { files: Record<string, unknown> }).files)
    .filter(filename => VALIDATOR_MODULE.test(filename));
  assert.deepEqual(new Set(validators), new Set(validatorsOf(originalInventory)), 'recovery inventories exactly the validator modules of the first run');
  assert.ok(validators.includes('sdk/validators.generated.ts'), 'the SDK validators are inventoried');
  assert.ok(validators.some(filename => filename.startsWith('src/')), 'frontend validators are inventoried');
  for (const filename of validators) assert.equal(fs.existsSync(path.join(setup.root, filename)), true, filename);
});

test('watch regenerates SDK then frontend without output loops', async t => {
  const setup = fixture(t);
  const child = spawn(process.execPath, [path.join(workspace, 'packages/golem/dist/bin/golem.js'), 'watch', '--config', setup.config], {
    cwd: setup.root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  const runs = () => runLines(output).length;
  const untilRun = async (count: number) => {
    await until(() => runs() >= count, () => `run ${count} (runs=${runs()}, stderr=${errors})`);
    assert.equal(runs(), count, errors || output);
  };
  await untilRun(1);
  setup.addProbe('first');
  await untilRun(2);
  assert.equal(sdkValidatorModules(setup.root).length, 1);
  await runPipeline(setup.config, { check: true });
  const before = fs.statSync(setup.inventory).mtimeMs;
  await runPipeline(setup.config, { check: true });
  assert.equal(fs.statSync(setup.inventory).mtimeMs, before, 'check leaves the inventory untouched');
  // The next source edit is the observation point: an output-triggered run would precede its single run.
  setup.addProbe('probe');
  await untilRun(3);
  assert.match(fs.readFileSync(path.join(setup.root, 'src/cart.model.generated.ts'), 'utf8'), /probe/);
});
