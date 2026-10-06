import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { runPipeline, watchPipeline } from '#golem/cli';
import { contains } from '#golem/config';
import { resolveTypeScript } from '#golem/typescript-version';
import { GeneratorSessionResources } from '#golem/pipeline';
import { OwnedOutputIndex } from '#golem/watch';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';

// These tests count the TypeScript 7 compiler's server processes and sessions, which TypeScript 6 does not have.
const skipOnTypeScript6 = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd()).major === 6
  && 'TypeScript 6 runs no compiler server process';

function fixture(t: TestContext): { root: string; config: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-watch-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of ['golem', 'golem-model', 'golem-openapi']) {
    fs.symlinkSync(path.join(workspace, 'packages', name), path.join(root, 'node_modules/@exprtlabs', name), 'dir');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"watch-recovery-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(
    'validation: true\n',
    'validation: true\nallowAny: false\n',
  ));
  return { root, config };
}

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
    assert.equal(index.covers(input), owned.some(output => contains(input, output)), input);
  }
  assert.equal(index.covers(path.join(root, 'sdk2/models.ts')), false, 'a sibling with a shared prefix is not owned');
});

/** A message that reports state is a function: it runs when the wait times out, not when the wait starts. */
async function until(check: () => boolean, message: string | (() => string), timeout = 25000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${typeof message === 'function' ? message() : message}`);
}

test('watch recovers when a referenced local schema file is introduced after the document that references it', async (t: TestContext) => {
  const { root, config } = fixture(t);
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

test('watch keeps model dependencies outside the models root after a run that reuses the models job', async (t: TestContext) => {
  const { root, config } = fixture(t);
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
  const { root, config } = fixture(t);
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

test('watch generates a model file added beside a shared model and one added in a new subfolder of its shared folder', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const app = path.join(root, 'app');
  const shared = path.join(root, 'shared');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(path.join(shared, 'src'), { recursive: true });
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"shared","private":true,"type":"module"}');
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts', '../shared/**/*.ts'],
  }));
  const model = (name: string): string => `import type { IModel } from '@exprtlabs/golem/model';\n\nexport type T${name} = IModel<{ id: string }>;\n`;
  fs.writeFileSync(path.join(app, 'src/cart.model.ts'), model('Cart'));
  fs.writeFileSync(path.join(shared, 'src/money.model.ts'), model('Money'));
  fs.writeFileSync(config, `tsconfig: app/tsconfig.json\n${fs.readFileSync(config, 'utf8').replace('root: .', 'root: app')}`);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;
  try {
    await until(() => fs.existsSync(path.join(shared, 'src/money.model.generated.ts')), () => `initial generation ${context()}`);
    fs.writeFileSync(path.join(shared, 'src/tax.model.ts'), model('Tax'));
    await until(() => fs.existsSync(path.join(shared, 'src/tax.model.generated.ts')), () => `a model beside a shared model is generated ${context()}`);
    fs.mkdirSync(path.join(shared, 'vat'));
    fs.writeFileSync(path.join(shared, 'vat/rate.model.ts'), model('Rate'));
    await until(() => fs.existsSync(path.join(shared, 'vat/rate.model.generated.ts')), () => `a model in a new shared subfolder is generated ${context()}`);
  } finally {
    stop();
  }
});

test('watch scans only the directory of a shared model when its shared folder is the repository that holds the app', async (t: TestContext) => {
  const { root, config } = fixture(t);
  // The package.json of the repository is the nearest one above `shared`, which has none of its own.
  const app = path.join(root, 'app');
  const shared = path.join(root, 'shared/src');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(path.join(root, 'unrelated/deep'), { recursive: true });
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts', '../shared/**/*.ts'],
  }));
  const model = (name: string): string => `import type { IModel } from '@exprtlabs/golem/model';\n\nexport type T${name} = IModel<{ id: string }>;\n`;
  fs.writeFileSync(path.join(app, 'src/cart.model.ts'), model('Cart'));
  fs.writeFileSync(path.join(shared, 'money.model.ts'), model('Money'));
  fs.writeFileSync(config, `tsconfig: app/tsconfig.json\n${fs.readFileSync(config, 'utf8').replace('root: .', 'root: app')}`);
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;
  try {
    await until(() => runs() === 1 && fs.existsSync(path.join(shared, 'money.model.generated.ts')), () => `initial generation ${context()}`);

    // A model file in an unrelated subtree of the repository is no input of the models job: it starts no run. The wait
    // keeps the two writes in different polls, so a run that the unrelated file starts is not merged with the next one.
    fs.writeFileSync(path.join(root, 'unrelated/deep/other.model.ts'), model('Other'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(path.join(shared, 'tax.model.ts'), model('Tax'));
    await until(() => runs() >= 2 && fs.existsSync(path.join(shared, 'tax.model.generated.ts')), () => `a model beside the shared model is generated ${context()}`);
    assert.equal(runs(), 2, 'one run for the model beside the shared model, none for the unrelated file');
  } finally {
    stop();
  }
});

test('watch scans only the shared folder of a shared model that has its package.json beside it', async (t: TestContext) => {
  const { root, config } = fixture(t);
  // A workspace outside the project holds the shared folder and an unrelated subtree; no package.json lies above them.
  const workspaceDirectory = path.join(path.dirname(root), `${path.basename(root)}-workspace`);
  const shared = path.join(workspaceDirectory, 'shared');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(path.join(workspaceDirectory, 'unrelated/deep'), { recursive: true });
  t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspaceDirectory, 'node_modules'), 'dir');
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"shared","private":true,"type":"module"}');
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts', `${path.relative(app, shared).split(path.sep).join('/')}/**/*.ts`],
  }));
  const model = (name: string): string => `import type { IModel } from '@exprtlabs/golem/model';\n\nexport type T${name} = IModel<{ id: string }>;\n`;
  fs.writeFileSync(path.join(app, 'src/cart.model.ts'), model('Cart'));
  fs.writeFileSync(path.join(shared, 'money.model.ts'), model('Money'));
  fs.writeFileSync(config, `tsconfig: app/tsconfig.json\n${fs.readFileSync(config, 'utf8').replace('root: .', 'root: app')}`);
  const runs = countRuns(t);
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); });
  const context = (): string => `(errors=${errors.map(String).join('; ')})`;
  try {
    await until(() => runs() === 1 && fs.existsSync(path.join(shared, 'money.model.generated.ts')), () => `initial generation ${context()}`);

    // The wait keeps the two writes in different polls, so a run that the unrelated file starts is not merged with the next one.
    fs.writeFileSync(path.join(workspaceDirectory, 'unrelated/deep/other.model.ts'), model('Other'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(path.join(shared, 'tax.model.ts'), model('Tax'));
    await until(() => runs() >= 2 && fs.existsSync(path.join(shared, 'tax.model.generated.ts')), () => `a model beside the shared model is generated ${context()}`);
    assert.equal(runs(), 2, 'one run for the model beside the shared model, none for the unrelated file');
  } finally {
    stop();
  }
});

function compilerChildren(parent: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null && Number(match[2]) === parent && match[3].includes('--api'))
    .map(match => Number(match[1]));
}

test('watch reuses one compiler across edits and tsconfig path-mapping changes', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const { root, config } = fixture(t);
  const tsconfigFile = path.join(root, 'tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigFile, 'utf8')) as { compilerOptions: Record<string, unknown>; include: string[] };
  const writeTsconfig = (paths: string, include: readonly string[]): void => {
    fs.writeFileSync(tsconfigFile, JSON.stringify({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, paths: { '@extra/types': [paths] } },
      include,
    }));
  };
  fs.mkdirSync(path.join(root, 'shared'));
  fs.mkdirSync(path.join(root, 'types'));
  fs.writeFileSync(path.join(root, 'shared/v1.ts'), 'export type Extra = { firstShape: string };\n');
  fs.writeFileSync(path.join(root, 'shared/v2.ts'), 'export type Extra = { secondShape: string };\n');
  fs.writeFileSync(path.join(root, 'types/ambient.d.ts'), 'interface AmbientNote { ambientShape: string }\n');
  writeTsconfig('./shared/v1.ts', tsconfig.include);
  const modelSource = path.join(root, 'src/cart.model.ts');
  const original = fs.readFileSync(modelSource, 'utf8');
  const writeModel = (imports: readonly string[], fields: string): void => {
    fs.writeFileSync(modelSource, [...imports, original.replace('note: string', `note: string; ${fields}`)].join('\n'));
  };
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';

  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const child = spawn(process.execPath, [binary, 'watch', '--config', config], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const runs = (): number => stdout.split('Generated configured outputs.').length - 1;
  const context = (): string => `(stdout=${stdout}, stderr=${stderr})`;
  const failsAfter = async (edit: () => void, pattern: RegExp, message: string): Promise<void> => {
    const reported = stderr.length;
    edit();
    await until(() => pattern.test(stderr.slice(reported)), () => `${message} ${context()}`);
  };

  try {
    await until(() => runs() >= 1, () => `initial generation ${context()}`);
    // Only TypeScript 7 runs its compiler in a child process; the edits below must regenerate on both versions.
    const [compiler] = compilerChildren(child.pid!);
    if (!skipOnTypeScript6) assert.ok(compiler, 'the watch keeps its compiler process between runs');

    // Every edit must reach the warm compiler, not only the first one.
    for (const field of ['firstEdit', 'secondEdit', 'thirdEdit']) {
      writeModel([], `${field}?: boolean`);
      await until(() => generated().includes(field), () => `edit ${field} regenerates ${context()}`);
    }

    writeModel(["import type { Extra } from '@extra/types';"], 'extra: Extra');
    await until(() => generated().includes('firstShape'), () => `the tsconfig path mapping resolves ${context()}`);

    // tsconfig edits change path mapping and the project file list.
    writeTsconfig('./shared/v2.ts', tsconfig.include);
    await until(() => generated().includes('secondShape'), () => `a path mapping edit is applied ${context()}`);
    await failsAfter(
      () => writeModel(["import type { Extra } from '@extra/types';"], 'extra: Extra; ambient: AmbientNote'),
      /AmbientNote/,
      'an ambient type outside the project is reported',
    );
    writeTsconfig('./shared/v2.ts', [...tsconfig.include, 'types/**/*.d.ts']);
    await until(() => generated().includes('ambientShape'), () => `an include edit is applied ${context()}`);
    if (!skipOnTypeScript6) assert.deepEqual(compilerChildren(child.pid!), [compiler], 'edits reuse the running compiler');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
  }
});

test('stopping an in-process watch closes its compiler', { skip: process.platform === 'win32' || skipOnTypeScript6 }, async (t: TestContext) => {
  const { root, config } = fixture(t);
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
  const { config } = fixture(t);
  const session = new GeneratorSessionResources();
  t.after(() => session[Symbol.dispose]());
  await runPipeline(config, { session });
  assert.equal(compilerChildren(process.pid).length, 1, 'the models job keeps its compiler');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('models:\n  root: .\n', ''));
  await runPipeline(config, { session });
  await until(() => compilerChildren(process.pid).length === 0, 'the removed job closes its compiler');
});

/** Count completed watch runs by the line the watch prints after each successful generation. */
function countRuns(t: TestContext): () => number {
  let runs = 0;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    if (String(chunk) === 'Generated configured outputs.\n') {
      runs++;
      return true;
    }
    return write(chunk, ...rest);
  });
  return () => runs;
}

test('edits that land between two polls produce one run with the final content', async (t: TestContext) => {
  const { root, config } = fixture(t);
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
    // Both writes run in one turn of the event loop, so no poll can observe the first alone.
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
  const { root, config } = fixture(t);
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
