// lane: typescript6 ProgramSession resolution updates and the compiler process of a watch
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { runPipeline, watchPipeline } from '#golem/cli';
import { isInsideDirectory } from '#golem/generator-api';
import { GeneratorSessionResources } from '#golem/pipeline';
import { OwnedOutputIndex, realInputFiles } from '#golem/input-watcher';
import type { InputFiles } from '#golem/input-watcher';
import { write } from './support/build-project.js';
import { workspace } from './support/process.js';
import { compilerChildren, generationWatchFixture, skipOnTypeScript6 } from './support/generation-watch.js';
import { countingInputFiles, quietly, until } from './support/watch-wait.js';

test('owned output index excludes exactly the outputs and the directories containing them', () => {
  const root = path.resolve(os.tmpdir(), 'owned-index');
  const owned = [path.join(root, 'sdk/models.ts'), path.join(root, 'src/cart.model.generated.ts')];
  const index = new OwnedOutputIndex([owned[0]]);
  index.add(owned[1]);
  const inputs = [
    ...owned,
    path.join(root, 'sdk'),
    path.join(root, 'sdk/'),
    root,
    path.parse(root).root,
    path.join(root, 'src'),
    path.join(root, 'sdk2/models.ts'),
    path.join(root, 'sd'),
    path.join(root, 'sdk/models.tsx'),
    path.join(root, 'sdk/models.ts/nested'),
    path.join(root, 'src/cart.model.ts'),
    path.join(root, 'src/sub/../cart.model.generated.ts'),
  ];
  for (const input of inputs) {
    assert.equal(index.covers(input), owned.some(output => isInsideDirectory(input, output)), input);
  }
  assert.equal(index.covers(path.join(root, 'sdk2/models.ts')), false, 'a sibling with a shared prefix is not owned');
});

test('watch recovers when a referenced local schema file is introduced after the document that references it', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });

  try {
    await until(() => runs() === 1, 'initial generation');

    // Update api.json with a ref to schemas/user.json BEFORE creating schemas/user.json
    const apiFile = path.join(root, 'api.json');
    const apiWithRef = {
      openapi: '3.1.0',
      info: { title: 'Ref API', version: '1' },
      paths: {
        '/user': {
          get: {
            operationId: 'getUser',
            responses: {
              200: {
                description: 'User',
                content: { 'application/json': { schema: { $ref: './schemas/user.json' } } },
              },
            },
          },
        },
      },
    };
    fs.writeFileSync(apiFile, JSON.stringify(apiWithRef));

    await until(() => errors.length > 0, 'missing reference error reported');

    // Create the missing schemas/user.json
    fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'schemas/user.json'), JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
    }));

    // Watcher must detect the created file and recover
    await until(
      () => fs.existsSync(path.join(root, 'sdk/client.ts')) && fs.readFileSync(path.join(root, 'sdk/client.ts'), 'utf8').includes('getUser'),
      () => `watcher recovers after missing schema is created (errors=${errors.map(String).join('; ')})`,
    );
  } finally {
    stop();
  }
  await until(() => compilerChildren(process.pid).length === 0, 'the compiler closes with the watch');
});

test('watch started on a golem.yaml that is not YAML reports its file, line and column, and runs again once the file is fixed', async (t: TestContext) => {
  // protects: T-311 a YAML parse error names the file; a failed run does not stop watch
  const { config } = generationWatchFixture(t);
  const valid = fs.readFileSync(config, 'utf8');
  fs.writeFileSync(config, `${valid}version: 1\n`);
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  try {
    await until(() => errors.length > 0, 'the broken golem.yaml is reported');
    assert.ok(errors[0] instanceof Error);
    assert.ok(errors[0].message.startsWith(`${path.relative(process.cwd(), config)}:`), errors[0].message);
    assert.match(errors[0].message, /^\S+:\d+:\d+ /);
    assert.ok(errors[0].cause instanceof YAML.YAMLParseError);
    fs.writeFileSync(config, valid);
    await until(() => runs() === 1, () => `the fixed golem.yaml runs (errors=${errors.map(String).join('; ')})`);
  } finally {
    stop();
  }
  await until(() => compilerChildren(process.pid).length === 0, 'the compiler closes with the watch');
});

test('each watch run prints the result of every job and its time; the run after a failure starts with Recovered:', async (t: TestContext) => {
  // protects: T-312 each watch run says what it did; only a job that failed before writing says its last good output stays
  const { root, config } = generationWatchFixture(t);
  const valid = fs.readFileSync(config, 'utf8');
  const runs = countRuns();
  const lines = runs.lines;
  const errors: unknown[] = [];
  const reported = (): string => errors.map(String).join('; ');
  const results = (line: string): string[] => line.replace(/^Recovered: /, '').split(' · ').slice(0, -1);
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  try {
    await until(() => lines.length === 1, 'the first run is summarized');
    assert.match(lines[0], / · \d+ ms$/);
    assert.ok(results(lines[0]).length >= 2, lines[0]);
    for (const result of results(lines[0])) assert.match(result, /^\S+: \d+ files? updated$/);

    // The same golem.yaml again: every job reruns and writes nothing.
    fs.writeFileSync(config, valid);
    await until(() => lines.length === 2, 'the run that changes nothing is summarized');
    for (const result of results(lines[1])) assert.match(result, /^\S+: unchanged$/);
    assert.ok(!lines[1].startsWith('Recovered:'), lines[1]);

    // No job failed: the configuration did not load, so the error stands alone.
    fs.writeFileSync(config, `${valid}version: 1\n`);
    await until(() => errors.length === 1, 'the broken golem.yaml is reported');
    assert.doesNotMatch(String(errors[0]), /wrote no files/);
    fs.writeFileSync(config, valid);
    await until(() => lines.length === 3, () => `the fixed golem.yaml runs (errors=${reported()})`);
    assert.ok(lines[2].startsWith('Recovered: '), lines[2]);
    for (const result of results(lines[2])) assert.match(result, /^\S+: unchanged$/);

    // A job that throws before it writes says its last good output stays.
    const model = path.join(root, 'src/cart.model.ts');
    const goodModel = fs.readFileSync(model, 'utf8');
    fs.writeFileSync(model, "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCart = IModel<{ half: string & }>;\n");
    await until(() => errors.length === 2, () => `the broken model is reported (errors=${reported()})`);
    assert.match(errors[1] instanceof Error ? errors[1].message : '', /error TS\d+:[^]*\nThe job that failed wrote no files; its last good output stays in place\.$/);
    fs.writeFileSync(model, goodModel);
    await until(() => lines.length === 4, () => `the fixed model runs (errors=${reported()})`);
    assert.ok(lines[3].startsWith('Recovered: '), lines[3]);
  } finally {
    stop();
  }
  await until(() => compilerChildren(process.pid).length === 0, 'the compiler closes with the watch');
});

test('a scan that fails after a good run is reported, and the run keeps its line with Recovered:', async (t: TestContext) => {
  // protects: T-429 a fault of the scan after a run must not drop the run line the caller prints
  const { root, config } = generationWatchFixture(t);
  const model = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const goodModel = fs.readFileSync(model, 'utf8');
  const runs = countRuns();
  const errors: unknown[] = [];
  // The scan after the run is the first stat that finds the run's output: the scans before it do not.
  let armed = false;
  const files: Partial<InputFiles> = {
    stat: (filename) => {
      if (armed && fs.readFileSync(companion, 'utf8').includes('afterFault')) {
        armed = false;
        throw Object.assign(new Error('EMFILE: too many open files, stat'), { code: 'EMFILE' });
      }
      return realInputFiles.stat(filename);
    },
  };
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun, files });
  try {
    await until(() => runs() === 1, 'initial generation');
    fs.writeFileSync(model, "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCart = IModel<{ half: string & }>;\n");
    await until(() => errors.length === 1, 'the broken model is reported');
    armed = true;
    fs.writeFileSync(model, goodModel.replace('note: string', 'note: string; afterFault?: boolean'));
    await until(() => runs() === 2, () => `the fixed model runs (errors=${errors.map(String).join('; ')})`);
    assert.match(runs.lines[1], /^Recovered: .* · \d+ ms$/);
    assert.match(String(errors[1]), /EMFILE/);
    assert.equal(errors.length, 2, 'the scan fault is reported once');
  } finally {
    stop();
  }
});

test('a job record that cannot be saved after the job wrote its files is reported as files written', async (t: TestContext) => {
  // protects: T-484 a failed record save does not say that the job wrote no files
  const { root, config } = generationWatchFixture(t);
  const model = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const runs = countRuns();
  const errors: unknown[] = [];
  let armed = false;
  const rename = (from: string, to: string): void => {
    if (armed && path.basename(to) === 'jobs.json') {
      armed = false;
      throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' });
    }
    fs.renameSync(from, to);
  };
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun, files: { rename } });
  try {
    await until(() => runs() === 1, 'initial generation');
    armed = true;
    fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace('note: string', 'note: string; afterWrite?: boolean'));
    await until(() => errors.length === 1, () => `the record save fault is reported (errors=${errors.map(String).join('; ')})`);
    assert.ok(fs.readFileSync(companion, 'utf8').includes('afterWrite'), 'the job wrote its file before the save failed');
    assert.ok(errors[0] instanceof Error);
    assert.match(errors[0].message, /EACCES[^]*\nThe job that failed wrote its files, but could not save its record\.$/);
    assert.doesNotMatch(errors[0].message, /wrote no files/);
  } finally {
    stop();
  }
});

test('watch keeps model dependencies outside the models root after a run that reuses the models job', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    // The shared type is reached only through the import, not the project file list.
    include: ['src/**/*.ts'],
  }));
  const shared = path.join(root, 'shared/note.ts');
  fs.writeFileSync(shared, 'export type Note = { text: string };\n');
  fs.writeFileSync(path.join(app, 'src/cart.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Note } from '../../shared/note.js';",
    '',
    'export type TCart = IModel<{ note: Note }>;',
    '',
  ].join('\n'));
  // The models job lies in `app`, so the yaml names the tsconfig of `app`.
  fs.writeFileSync(config, `tsconfig: app/tsconfig.json\n${fs.readFileSync(config, 'utf8').replace('root: .', 'root: app')}`);
  const state = await runPipeline(config);
  const modelInputs = state.results.get('models:app')?.watchInputs ?? [];
  assert.ok(modelInputs.includes(shared), 'the out-of-root import is a models dependency');
  assert.deepEqual(
    modelInputs.filter((input) => input.split(path.sep).includes('node_modules')
      || /[\\/]lib\.[^\\/]*\.d\.ts$/.test(input)
      || input.startsWith(path.join(workspace, 'packages'))),
    [],
    'installed, linked and TypeScript library files are not models dependencies',
  );
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;

  try {
    const companion = path.join(app, 'src/cart.model.generated.ts');
    await until(() => runs() >= 1 && fs.existsSync(companion), () => `initial generation ${context()}`);
    assert.doesNotMatch(fs.readFileSync(companion, 'utf8'), /\btag\b/);

    // An OpenAPI-only edit regenerates the SDK and reuses the cached models job.
    const companionMtime = fs.statSync(companion).mtimeMs;
    const client = path.join(root, 'sdk/client.ts');
    const api = path.join(root, 'api.json');
    fs.writeFileSync(api, fs.readFileSync(api, 'utf8').replace('getMoney', 'listItems'));
    await until(() => fs.readFileSync(client, 'utf8').includes('listItems'), () => `SDK regenerates ${context()}`);
    await until(() => runs() >= 2, () => `incremental run completes ${context()}`);
    assert.equal(fs.statSync(companion).mtimeMs, companionMtime, 'the models job is reused');

    fs.writeFileSync(shared, 'export type Note = { text: string; tag?: string };\n');
    await until(
      () => fs.readFileSync(companion, 'utf8').includes('tag'),
      () => `an edit outside the models root regenerates the companion ${context()}`,
    );
  } finally {
    stop();
  }
  await until(() => compilerChildren(process.pid).length === 0, 'the compiler closes with the watch');
});

test('watch generates a new file that ends in a configured model suffix', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('models:\n  root: .\n', 'models:\n  root: .\n  suffixes: [.entity.ts]\n'));
  const entity = (name: string): string => `import type { IModel } from '@exprtlabs/golem/model';\n\nexport type T${name} = IModel<{ id: string }>;\n`;
  fs.writeFileSync(path.join(root, 'src/cart.entity.ts'), entity('Cart'));
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;
  try {
    await until(() => fs.existsSync(path.join(root, 'src/cart.entity.generated.ts')), () => `initial generation ${context()}`);
    fs.writeFileSync(path.join(root, 'src/pet.entity.ts'), entity('Pet'));
    await until(() => fs.existsSync(path.join(root, 'src/pet.entity.generated.ts')), () => `the new file is generated ${context()}`);
  } finally {
    stop();
  }
});

test('watch generates a new model file in a folder of the models root outside src', async (t: TestContext) => {
  // protects: T-29 watch finds new model files in every included folder of the root
  const { root, config } = generationWatchFixture(t);
  const tsconfig = path.join(root, 'tsconfig.json');
  fs.writeFileSync(tsconfig, fs.readFileSync(tsconfig, 'utf8').replace('"src/**/*.ts"', '"src/**/*.ts", "lib/**/*.ts"'));
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  try {
    await until(() => runs() === 1, 'initial generation');
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib/pet.model.ts'), "import type { IModel } from '@exprtlabs/golem/model';\n\nexport type TPet = IModel<{ name: string }>;\n");
    await until(() => fs.existsSync(path.join(root, 'lib/pet.model.generated.ts')), () => `the companion is written (errors=${errors.map(String).join('; ')})`);
    assert.equal(runs(), 2, 'one regeneration for the new file');
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('watch generates a new file that a run in flight did not read', async (t: TestContext) => {
  // protects: T-307 a model file created during a run is generated without another edit
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const companion = path.join(root, 'src/cart.model.generated.ts');
  let createWhileRunning = false;
  // The companion is published by rename after the run read its sources: create a model file at that moment.
  const rename = (from: string, to: string): void => {
    if (createWhileRunning && path.resolve(to) === companion) {
      createWhileRunning = false;
      fs.writeFileSync(path.join(root, 'src/pet.model.ts'), newModel('Pet'));
    }
    fs.renameSync(from, to);
  };
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun, files: { rename } });
  try {
    await until(() => runs() === 1, 'initial generation');
    createWhileRunning = true;
    fs.writeFileSync(path.join(root, 'src/cart.model.ts'), fs.readFileSync(path.join(root, 'src/cart.model.ts'), 'utf8').replace('note: string', 'note: string; edited?: boolean'));
    await until(() => fs.existsSync(path.join(root, 'src/pet.model.generated.ts')), () => `the model created during the run is generated (errors=${errors.map(String).join('; ')})`);
    assert.equal(createWhileRunning, false, 'the file was created while the triggered run was writing');
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('a file that is no source, added to a watched folder, starts no run', async (t: TestContext) => {
  // protects: T-307 only a source name added to a folder starts a run
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  try {
    await until(() => runs() === 1, 'initial generation');
    fs.writeFileSync(path.join(root, 'src/style.css'), 'a { color: red }\n');
    fs.writeFileSync(path.join(root, 'src/cart.model.ts~'), 'editor backup');
    // The sentinel edit starts run 2 only if the files above started none before it.
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('note: string', 'note: string; sentinel?: boolean'));
    await until(() => fs.readFileSync(path.join(root, 'src/cart.model.generated.ts'), 'utf8').includes('sentinel'), 'the sentinel edit is generated');
    assert.equal(runs(), 2);
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('an editor save by renaming over the file, a save through a backup file and a delete each start one run', async (t: TestContext) => {
  // protects: R-31 the events of an editor's save and of a delete reach the watch as one run each
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const pet = path.join(root, 'src/pet.model.ts');
  const original = fs.readFileSync(source, 'utf8');
  const edited = (field: string): string => original.replace('note: string', `note: string; ${field}?: boolean`);
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;
  try {
    await until(() => runs() === 1, `initial generation ${context()}`);
    fs.writeFileSync(`${source}.new`, edited('renamedOver'));
    fs.renameSync(`${source}.new`, source);
    await until(() => generated().includes('renamedOver'), `the rename over the file is generated ${context()}`);
    assert.equal(runs(), 2, 'one run for the save');

    fs.renameSync(source, `${source}~`);
    fs.writeFileSync(source, edited('throughBackup'));
    await until(() => generated().includes('throughBackup'), `the save through a backup is generated ${context()}`);
    assert.equal(runs(), 3, 'one run for the save');

    fs.writeFileSync(pet, newModel('Pet'));
    const petCompanion = path.join(root, 'src/pet.model.generated.ts');
    await until(() => fs.existsSync(petCompanion), `the new model is generated ${context()}`);
    fs.rmSync(pet);
    await until(() => !fs.existsSync(petCompanion), `the output of the deleted model is removed ${context()}`);
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('a package manager marker starts one full run, and a change inside node_modules alone starts none', async (t: TestContext) => {
  // protects: R-31 installed packages are not watched; an install is told by its marker and reads everything again
  const { root, config } = generationWatchFixture(t);
  const schema = path.join(root, 'node_modules/shared-schemas/user.json');
  const sdk = path.join(root, 'sdk');
  const text = (): string => fs.readdirSync(sdk, { recursive: true, encoding: 'utf8' }).map((name) => path.join(sdk, name)).filter((file) => fs.statSync(file).isFile()).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  fs.mkdirSync(path.dirname(schema), { recursive: true });
  const user = (field: string): string => JSON.stringify({ type: 'object', properties: { [field]: { type: 'string' } } });
  fs.writeFileSync(schema, user('firstName'));
  const api = path.join(root, 'api.json');
  const document = JSON.parse(fs.readFileSync(api, 'utf8')) as { paths: Record<string, unknown> };
  document.paths['/user'] = { get: { operationId: 'getUser', responses: { 200: { description: 'User', content: { 'application/json': { schema: { $ref: './node_modules/shared-schemas/user.json' } } } } } } };
  fs.writeFileSync(api, JSON.stringify(document));
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;
  try {
    await until(() => runs() === 1, () => `initial generation runs=${runs()} ${context()}`);
    assert.match(text(), /firstName/);

    fs.writeFileSync(schema, user('lastName'));
    await quietly();
    assert.equal(runs(), 1, 'the installed file changed and nothing ran');
    assert.doesNotMatch(text(), /lastName/);

    fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{}');
    await until(() => runs() === 2, `the marker starts a run ${context()}`);
    assert.match(text(), /lastName/, 'the run read the installed file again');
    await quietly();
    assert.equal(runs(), 2, 'one run for the marker');
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('an idle watch makes no stat or folder listing, and stopping it closes its file watches', async (t: TestContext) => {
  // protects: R-31 an idle watch costs nothing; the stop closes every watcher
  // The count is of the calls the InputFiles seam carries (stat, list). Real paths are read only when a run ends, and files only by a run.
  const { config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const counted = countingInputFiles();
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun, files: counted.files });
  try {
    await until(() => runs() === 1, 'initial generation');
    assert.ok(counted.openWatches() > 0, 'the folders are watched');
    // The first run's own writes cause ticks that find nothing; they end within the quiet period.
    await quietly(1_000);
    const settled = counted.reads();
    await quietly(1_000);
    assert.equal(counted.reads(), settled, 'a quiet watch scans nothing');
    assert.equal(runs(), 1);
  } finally {
    stop();
  }
  assert.equal(counted.openWatches(), 0, 'every watcher is closed');
  assert.deepEqual(errors, []);
});

test('watch generates once a missing file outside the models root, imported by a model, is created', async (t: TestContext) => {
  // protects: R-31 a failed run's missing import outside the root is an input; its folder is watched
  const { root, config } = generationWatchFixture(t);
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts'],
  }));
  fs.writeFileSync(path.join(root, 'shared/other.ts'), 'export type Other = number;\n');
  fs.writeFileSync(path.join(app, 'src/cart.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Note } from '../../shared/note.js';",
    '',
    'export type TCart = IModel<{ note: Note }>;',
    '',
  ].join('\n'));
  fs.writeFileSync(config, `tsconfig: app/tsconfig.json\n${fs.readFileSync(config, 'utf8').replace('root: .', 'root: app')}`);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
  try {
    await until(() => errors.length > 0, 'the missing import is reported');
    fs.writeFileSync(path.join(root, 'shared/note.ts'), 'export type Note = { text: string };\n');
    await until(() => fs.existsSync(path.join(app, 'src/cart.model.generated.ts')), () => `the created file starts a run (errors=${errors.map(String).join('; ')})`);
  } finally {
    stop();
  }
});

test('a watch that can watch no folder reports it with its fix, runs nothing and tells its caller', async (t: TestContext) => {
  // protects: R-31 no working watcher ends the watch with a failure instead of an idle process
  const { config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: Error[] = [];
  let unwatchable = 0;
  const stop = watchPipeline(config, error => { errors.push(error as Error); }, { onUnwatchable: () => { unwatchable += 1; }, onRun: runs.onRun, files: { watch: () => { throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' }); } } });
  try {
    await until(() => unwatchable === 1, 'the caller is told');
    assert.match(errors.map(String).join('\n'), /fs\.inotify\.max_user_watches/);
    assert.match(errors.map(String).join('\n'), /cannot watch any source folder, so it stops/);
    assert.equal(runs(), 0);
  } finally {
    stop();
  }
});

/** An app whose tsconfig includes the `shared` folder beside it; `linked` in the app is a folder link to it. */
function sharedModelFixture(t: TestContext, include: string): { root: string; config: string } {
  const { root, config } = generationWatchFixture(t);
  const app = path.join(root, 'app');
  const shared = path.join(root, 'shared');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(shared);
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.symlinkSync('../shared', path.join(app, 'linked'), 'dir');
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts', include],
  }));
  fs.writeFileSync(path.join(shared, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(app, 'src/cart.model.ts'), newModel('Cart'));
  fs.writeFileSync(path.join(shared, 'money.model.ts'), newModel('Money'));
  fs.writeFileSync(config, `tsconfig: app/tsconfig.json\n${fs.readFileSync(config, 'utf8').replace('root: .', 'root: app')}`);
  return { root, config };
}

function newModel(name: string): string {
  return `import type { IModel } from '@exprtlabs/golem/model';\n\nexport type T${name} = IModel<{ id: string }>;\n`;
}

for (const [way, include] of [['outside the root', '../shared/**/*.ts'], ['behind a folder link', 'linked/**/*.ts']] as const) {
  test(`watch generates a new model file in a shared folder ${way}`, async (t: TestContext) => {
    // protects: T-308 a model file added to a shared folder is generated by golem watch
    const { root, config } = sharedModelFixture(t, include);
    const errors: unknown[] = [];
    const stop = watchPipeline(config, error => { errors.push(error); });
    const context = (): string => `(errors=${errors.map(String).join('; ')})`;
    try {
      // The app writes the companion of a shared model into its own output, in the folder of the shared package.
      const companion = (name: string): string => path.join(root, 'app/src/generated/models/shared', `${name}.model.generated.ts`);
      await until(() => fs.existsSync(companion('money')), () => `initial generation ${context()}`);
      fs.writeFileSync(path.join(root, 'shared/order.model.ts'), newModel('Order'));
      await until(() => fs.existsSync(companion('order')), () => `the new shared model is generated ${context()}`);
    } finally {
      stop();
    }
  });
}

test('watch generates a new model file in a shared folder that holds only a helper so far', async (t: TestContext) => {
  // protects: T-308 an outside folder is scanned for every input in it, not only for a model
  const { root, config } = sharedModelFixture(t, '../shared/**/*.ts');
  fs.rmSync(path.join(root, 'shared/money.model.ts'));
  fs.mkdirSync(path.join(root, 'shared/billing'));
  fs.writeFileSync(path.join(root, 'shared/billing/rules.ts'), 'export type Rate = number;\n');
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  try {
    await until(() => runs() === 1, () => `initial generation (errors=${errors.map(String).join('; ')})`);
    fs.writeFileSync(path.join(root, 'shared/billing/invoice.model.ts'), newModel('Invoice'));
    const companion = path.join(root, 'app/src/generated/models/shared/billing/invoice.model.generated.ts');
    await until(() => fs.existsSync(companion), () => `the model beside the helper is generated (errors=${errors.map(String).join('; ')})`);
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('stopping an in-process watch closes its compiler', { skip: process.platform === 'win32' || skipOnTypeScript6 }, async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
  const companion = path.join(root, 'src/cart.model.generated.ts');
  try {
    await until(() => fs.existsSync(companion) && compilerChildren(process.pid).length > 0, 'initial generation starts the compiler');
  } finally {
    stop();
  }
  await until(() => compilerChildren(process.pid).length === 0, 'the compiler closes with the watch');
  assert.deepEqual(errors, []);
});

test('a pipeline session closes the compiler of a removed job', { skip: process.platform === 'win32' || skipOnTypeScript6 }, async (t: TestContext) => {
  const { config } = generationWatchFixture(t);
  const session = new GeneratorSessionResources();
  t.after(() => session[Symbol.dispose]());
  await runPipeline(config, { session });
  assert.equal(compilerChildren(process.pid).length, 1, 'the models job keeps its compiler');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('models:\n  root: .\n', ''));
  await runPipeline(config, { session });
  await until(() => compilerChildren(process.pid).length === 0, 'the removed job closes its compiler');
});

/** Counts the good runs of a watch: pass `onRun` to `watchPipeline`; `lines` holds the line of each run, in order. */
function countRuns(): (() => number) & { readonly lines: string[]; readonly onRun: (line: string) => void } {
  const lines: string[] = [];
  return Object.assign(() => lines.length, { lines, onRun: (line: string): void => { lines.push(line); } });
}

test('edits that land between two ticks produce one run with the final content', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const original = fs.readFileSync(source, 'utf8');
  const edit = (field: string): void => fs.writeFileSync(source, original.replace('note: string', `note: string; ${field}?: boolean`));
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun });
  try {
    await until(() => runs() === 1, 'initial generation');
    // Both writes run in one turn of the event loop, so no tick can observe the first alone.
    edit('firstBurstEdit');
    edit('finalBurstEdit');
    await until(() => generated().includes('finalBurstEdit'), 'the final edit is generated');
    assert.equal(runs(), 2, 'one run for both edits');
    assert.doesNotMatch(generated(), /firstBurstEdit/);
    // A later edit is the observation point: an extra queued run would be counted before it.
    edit('sentinelEdit');
    await until(() => generated().includes('sentinelEdit'), 'the sentinel edit is generated');
    assert.equal(runs(), 3);
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('an edit during a running generation triggers exactly one follow-up run with the latest content', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns();
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const original = fs.readFileSync(source, 'utf8');
  const edit = (field: string): void => fs.writeFileSync(source, original.replace('note: string', `note: string; ${field}?: boolean`));
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';
  let editWhileRunning = false;
  // The companion is published by rename while the run is still in progress: edit the source at that moment.
  const rename = (from: string, to: string): void => {
    if (editWhileRunning && path.resolve(to) === companion) {
      editWhileRunning = false;
      edit('duringRunEdit');
      edit('latestDuringRunEdit');
    }
    fs.renameSync(from, to);
  };
  const stop = watchPipeline(config, error => { errors.push(error); }, { onRun: runs.onRun, files: { rename } });
  try {
    await until(() => runs() === 1, 'initial generation');
    editWhileRunning = true;
    edit('triggerEdit');
    await until(() => generated().includes('latestDuringRunEdit'), 'the follow-up run generates the latest edit');
    assert.equal(editWhileRunning, false, 'the source changed while the triggered run was writing');
    assert.equal(runs(), 3, 'the triggered run and exactly one follow-up run');
    edit('sentinelEdit');
    await until(() => generated().includes('sentinelEdit'), 'the sentinel edit is generated');
    assert.equal(runs(), 4, 'no further run was queued');
  } finally {
    stop();
  }
  assert.deepEqual(errors, []);
});

test('a watch that reports with the default reporter prints the stack and cause of a TypeError in a generator', async (t: TestContext) => {
  // protects: T-490 the default reporter of watchPipeline printed errorMessage only, so a generator's TypeError lost its stack and cause
  const { root, config } = generationWatchFixture(t);
  write(root, 'node_modules/@fixture/throwing/package.json', JSON.stringify({ name: '@fixture/throwing', version: '1.0.0', type: 'module', exports: { './generator': './index.js' } }));
  write(root, 'node_modules/@fixture/throwing/index.js', `export const apiVersion = 1;
export function generate() { throw new TypeError('generator state is broken', { cause: new RangeError('index out of range') }); }
`);
  const document = YAML.parse(fs.readFileSync(config, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(config, YAML.stringify({ ...document, generators: [{ package: '@fixture/throwing', output: 'out' }] }));
  let printed = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(); return true; });
  const stop = watchPipeline(config);
  try {
    await until(() => printed.includes('index out of range'), () => `the failure is reported (output=${printed})`);
    assert.match(printed, /TypeError: generator state is broken\n\s+at /);
    assert.match(printed, /\[cause\]: RangeError: index out of range/);
  } finally {
    stop();
  }
});
