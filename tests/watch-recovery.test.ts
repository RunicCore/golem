import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { runPipeline, watchPipeline } from '#codegen/cli';
import { contains } from '#codegen/config';
import { GeneratorSessionResources } from '#codegen/pipeline';
import { OwnedOutputIndex } from '#codegen/watch';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';

function fixture(t: TestContext): { root: string; config: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runic-watch-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of ['codegen', 'model-codegen', 'openapi-to-ts']) {
    fs.symlinkSync(path.join(workspace, 'packages', name), path.join(root, 'node_modules/@exprtlabs', name), 'dir');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"watch-recovery-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const config = path.join(root, 'runic-codegen.yaml');
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

async function until(check: () => boolean, message: string, timeout = 25000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

test('watch recovers when config references a missing root OpenAPI document that is created later', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const binary = path.join(workspace, 'packages/codegen/dist/bin/runic-codegen.js');
  const child = spawn(process.execPath, [binary, 'watch', '--config', config], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

  try {
    await until(() => stdout.includes('Generated configured outputs.'), `initial generation: ${stderr}`);

    // Update config to reference a nonexistent input 'next-api.json'
    const originalConfig = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(config, originalConfig.replace('input: api.json', 'input: next-api.json'));

    await until(() => stderr.includes('does not exist') || stderr.includes('ENOENT'), 'watcher reports missing input error');

    // Create the missing 'next-api.json'
    const nextApi = path.join(root, 'next-api.json');
    fs.writeFileSync(nextApi, JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Next API', version: '2' },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            responses: { 200: { description: 'Items' } },
          },
        },
      },
    }));

    // Watcher must detect creation of the missing input and regenerate
    await until(
      () => fs.existsSync(path.join(root, 'sdk/client.ts')) && fs.readFileSync(path.join(root, 'sdk/client.ts'), 'utf8').includes('listItems'),
      `watcher recovers after missing root input is created (stdout=${stdout}, stderr=${stderr})`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
  }
});

test('watch recovers when a referenced local schema file is introduced later (both save orders)', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const binary = path.join(workspace, 'packages/codegen/dist/bin/runic-codegen.js');
  const child = spawn(process.execPath, [binary, 'watch', '--config', config], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

  try {
    await until(() => stdout.includes('Generated configured outputs.'), `initial generation: ${stderr}`);

    // Save order 1: Update api.json with a ref to schemas/user.json BEFORE creating schemas/user.json
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

    await until(() => stderr.length > 0, 'missing reference error reported');

    // Create the missing schemas/user.json
    fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'schemas/user.json'), JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
    }));

    // Watcher must detect the created file and recover
    await until(
      () => fs.existsSync(path.join(root, 'sdk/client.ts')) && fs.readFileSync(path.join(root, 'sdk/client.ts'), 'utf8').includes('getUser'),
      `watcher recovers after missing schema is created (stderr=${stderr})`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
  }
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
    "import type { IModel } from '@exprtlabs/codegen/model';",
    "import type { Note } from '../../shared/note.js';",
    '',
    'export type TCart = IModel<{ note: Note }>;',
    '',
  ].join('\n'));
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('root: .', 'root: app'));
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
  const binary = path.join(workspace, 'packages/codegen/dist/bin/runic-codegen.js');
  const child = spawn(process.execPath, [binary, 'watch', '--config', config], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

  try {
    const companion = path.join(app, 'src/cart.model.generated.ts');
    await until(() => stdout.includes('Generated configured outputs.') && fs.existsSync(companion), `initial generation: ${stderr}`);
    assert.doesNotMatch(fs.readFileSync(companion, 'utf8'), /\btag\b/);

    // An OpenAPI-only edit regenerates the SDK and reuses the cached models job.
    const companionMtime = fs.statSync(companion).mtimeMs;
    const client = path.join(root, 'sdk/client.ts');
    const api = path.join(root, 'api.json');
    fs.writeFileSync(api, fs.readFileSync(api, 'utf8').replace('getMoney', 'listItems'));
    await until(() => fs.readFileSync(client, 'utf8').includes('listItems'), `SDK regenerates (stderr=${stderr})`);
    await until(() => stdout.split('Generated configured outputs.').length >= 3, `incremental run completes (stderr=${stderr})`);
    assert.equal(fs.statSync(companion).mtimeMs, companionMtime, 'the models job is reused');

    fs.writeFileSync(shared, 'export type Note = { text: string; tag?: string };\n');
    await until(
      () => fs.readFileSync(companion, 'utf8').includes('tag'),
      `an edit outside the models root regenerates the companion (stdout=${stdout}, stderr=${stderr})`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
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

  const binary = path.join(workspace, 'packages/codegen/dist/bin/runic-codegen.js');
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
    await until(() => pattern.test(stderr.slice(reported)), `${message} ${context()}`);
  };

  try {
    await until(() => runs() >= 1, `initial generation ${context()}`);
    const [compiler] = compilerChildren(child.pid!);
    assert.ok(compiler, 'the watch keeps its compiler process between runs');

    // Every edit must reach the warm compiler, not only the first one.
    for (const field of ['firstEdit', 'secondEdit', 'thirdEdit']) {
      writeModel([], `${field}?: boolean`);
      await until(() => generated().includes(field), `edit ${field} regenerates ${context()}`);
    }

    writeModel(["import type { Extra } from '@extra/types';"], 'extra: Extra');
    await until(() => generated().includes('firstShape'), `the tsconfig path mapping resolves ${context()}`);

    // tsconfig edits change path mapping and the project file list.
    writeTsconfig('./shared/v2.ts', tsconfig.include);
    await until(() => generated().includes('secondShape'), `a path mapping edit is applied ${context()}`);
    await failsAfter(
      () => writeModel(["import type { Extra } from '@extra/types';"], 'extra: Extra; ambient: AmbientNote'),
      /AmbientNote/,
      'an ambient type outside the project is reported',
    );
    writeTsconfig('./shared/v2.ts', [...tsconfig.include, 'types/**/*.d.ts']);
    await until(() => generated().includes('ambientShape'), `an include edit is applied ${context()}`);
    assert.deepEqual(compilerChildren(child.pid!), [compiler], 'edits reuse the running compiler');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
  }
});

test('stopping an in-process watch closes its compiler', { skip: process.platform === 'win32' }, async (t: TestContext) => {
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

test('a pipeline session closes the compiler of a removed job', { skip: process.platform === 'win32' }, async (t: TestContext) => {
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
