import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { runPipeline, watchPipeline } from '#golem/cli';
import { isInsideDirectory } from '#golem/generator-api';
import { GeneratorSessionResources } from '#golem/pipeline';
import { OwnedOutputIndex } from '#golem/input-watcher';
import { workspace } from './support/process.js';
import { compilerChildren, generationWatchFixture, skipOnTypeScript6 } from './support/generation-watch.js';
import { quietly, trackWatchers, until } from './support/watch-wait.js';
import { isRunLine } from './support/watch-runs.js';

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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });

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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  const lines = watchRunLines(t);
  const errors: unknown[] = [];
  const reported = (): string => errors.map(String).join('; ');
  const results = (line: string): string[] => line.replace(/^Recovered: /, '').split(' · ').slice(0, -1);
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const companion = path.join(root, 'src/cart.model.generated.ts');
  let createWhileRunning = false;
  const rename = fs.renameSync.bind(fs);
  // The companion is published by rename after the run read its sources: create a model file at that moment.
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike): void => {
    if (createWhileRunning && path.resolve(String(to)) === companion) {
      createWhileRunning = false;
      fs.writeFileSync(path.join(root, 'src/pet.model.ts'), newModel('Pet'));
    }
    rename(from, to);
  });
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  // protects: T-331 the events of an editor's save and of a delete reach the watch as one run each
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const pet = path.join(root, 'src/pet.model.ts');
  const original = fs.readFileSync(source, 'utf8');
  const edited = (field: string): string => original.replace('note: string', `note: string; ${field}?: boolean`);
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  // protects: T-331 installed packages are not watched; an install is told by its marker and reads everything again
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
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

test('an idle watch reads no file, and stopping it closes its file watches', async (t: TestContext) => {
  // protects: R-31 an idle watch costs nothing; the stop closes every watcher
  const { config } = generationWatchFixture(t);
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const watchers = trackWatchers(t);
  let reads = 0;
  for (const name of ['statSync', 'readdirSync', 'lstatSync'] as const) {
    const original = fs[name].bind(fs) as (...args: unknown[]) => unknown;
    t.mock.method(fs, name, (...args: unknown[]) => { reads += 1; return original(...args); });
  }
  const stop = watchPipeline(config, error => { errors.push(error); });
  try {
    await until(() => runs() === 1, 'initial generation');
    assert.ok(watchers.open() > 0, 'the folders are watched');
    // The first run's own writes cause ticks that find nothing; they end within the quiet period.
    await quietly(1_000);
    const settled = reads;
    await quietly(1_000);
    assert.equal(reads, settled, 'a quiet watch reads no file');
    assert.equal(runs(), 1);
  } finally {
    stop();
  }
  assert.equal(watchers.open(), 0, 'every watcher is closed');
  assert.deepEqual(errors, []);
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
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

/** The lines the watch prints after each successful generation, in order. */
function watchRunLines(t: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    if (isRunLine(String(chunk))) {
      lines.push(String(chunk).trimEnd());
      return true;
    }
    return write(chunk, ...rest);
  });
  return lines;
}

/** Count completed watch runs by the line the watch prints after each successful generation. */
function countRuns(t: TestContext): () => number {
  const lines = watchRunLines(t);
  return () => lines.length;
}

test('edits that land between two ticks produce one run with the final content', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const original = fs.readFileSync(source, 'utf8');
  const edit = (field: string): void => fs.writeFileSync(source, original.replace('note: string', `note: string; ${field}?: boolean`));
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';
  const stop = watchPipeline(config, error => { errors.push(error); });
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
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const source = path.join(root, 'src/cart.model.ts');
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const original = fs.readFileSync(source, 'utf8');
  const edit = (field: string): void => fs.writeFileSync(source, original.replace('note: string', `note: string; ${field}?: boolean`));
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';
  let editWhileRunning = false;
  const rename = fs.renameSync.bind(fs);
  // The companion is published by rename while the run is still in progress: edit the source at that moment.
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike): void => {
    if (editWhileRunning && path.resolve(String(to)) === companion) {
      editWhileRunning = false;
      edit('duringRunEdit');
      edit('latestDuringRunEdit');
    }
    rename(from, to);
  });
  const stop = watchPipeline(config, error => { errors.push(error); });
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
