import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { runPipeline } from '#codegen/pipeline';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';

function fixture(t: TestContext) {
  const root = createFixtureProject(t, 'runic-validator-transition-');

  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const model = path.join(root, 'src/cart.model.ts');
  copyFixtureFile(root, 'pipeline/standalone-transition/cart.model.ts', 'src/cart.model.ts');
  const config = path.join(root, 'golem.yaml');
  const setStandalone = (enabled: boolean) => {
    const text = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(config, text.replace(/ajvStandalone: (?:true|false)/, `ajvStandalone: ${enabled}`));
  };
  return { root, model, config, setStandalone, inventory: path.join(root, '.golem/outputs.json') };
}

test('JIT to standalone inventory interruption recovers and switching back retires generated validators', async t => {
  const setup = fixture(t);
  await runPipeline(setup.config);
  const originalInventory = fs.readFileSync(setup.inventory, 'utf8');
  setup.setStandalone(true);
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === setup.inventory) throw new Error('interrupted inventory replacement');
    rename(source, destination);
  });
  await assert.rejects(runPipeline(setup.config), /interrupted inventory replacement/);
  fault.mock.restore();
  assert.equal(fs.readFileSync(setup.inventory, 'utf8'), originalInventory);
  assert.ok(fs.existsSync(path.join(setup.root, 'sdk/validators.generated.js')));
  const standalone = await runPipeline(setup.config);
  await runPipeline(setup.config, { check: true });
  const files: Record<string, unknown> = JSON.parse(fs.readFileSync(setup.inventory, 'utf8')).files;
  const validators = Object.keys(files).filter(filename => filename.endsWith('.generated.js'));
  const emittedValidators = [...standalone.results.values()].flatMap(result => result.artifacts)
    .filter(artifact => artifact.path.endsWith('.generated.js'))
    .map(artifact => path.relative(setup.root, artifact.path));
  assert.deepEqual(new Set(validators), new Set(emittedValidators), 'inventory includes every emitted validator module');
  assert.ok(validators.some(filename => filename.startsWith('sdk/models/')), 'SDK model validators are inventoried');
  assert.ok(validators.some(filename => filename.startsWith('sdk/operations/')), 'SDK operation validators are inventoried');
  assert.ok(validators.some(filename => filename.startsWith('src/')), 'frontend validators are inventoried');
  setup.setStandalone(false);
  await runPipeline(setup.config);
  for (const filename of validators) assert.equal(fs.existsSync(path.join(setup.root, filename)), false, filename);
  await runPipeline(setup.config, { check: true });
});

test('watch regenerates SDK then frontend through both validator modes without output loops', async t => {
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
  const runs = () => output.split('Generated configured outputs.').length - 1;
  const untilRun = async (count: number) => {
    const deadline = Date.now() + 30_000;
    while (runs() < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(runs(), count, errors || output);
  };
  await untilRun(1);
  setup.setStandalone(true);
  await untilRun(2);
  assert.ok(fs.existsSync(path.join(setup.root, 'sdk/validators.generated.js')));
  await runPipeline(setup.config, { check: true });
  setup.setStandalone(false);
  await untilRun(3);
  assert.equal(fs.existsSync(path.join(setup.root, 'sdk/validators.generated.js')), false);
  const before = fs.statSync(setup.inventory).mtimeMs;
  await runPipeline(setup.config, { check: true });
  assert.equal(fs.statSync(setup.inventory).mtimeMs, before, 'check leaves the inventory untouched');
  // The next source edit is the observation point: an output-triggered run would precede its single run.
  fs.writeFileSync(setup.model, fs.readFileSync(setup.model, 'utf8').replace('note: string', 'note: string; probe?: string'));
  await untilRun(4);
  assert.match(fs.readFileSync(path.join(setup.root, 'src/cart.model.generated.ts'), 'utf8'), /probe/);
  assert.equal(errors, '');
});
