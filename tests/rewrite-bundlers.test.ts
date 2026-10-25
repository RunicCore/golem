// lane: typescript6 ProgramSession resolution updates in the bundler rewrite plugins
// The Vite and esbuild plugins scan each TypeScript file with the project's own types and rewrite it in memory; the bundler then strips the types.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { build as esbuild, context as esbuildContext, type BuildFailure } from 'esbuild';
import { build as vite, createServer, type ViteDevServer } from 'vite';

import { runPipeline } from '#golem/cli';
import { golem as esbuildPlugin } from '#golem/esbuild';
import { openRewriteProject } from '#golem/rewrite-host';
import type { GolemHostOptions } from '#golem/rewrite-host';
import { golem as vitePlugin } from '#golem/vite';
import { copyFixtureFile, createFixtureProject, linkProjectPackages, snapshotFilesystem, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { command, workspace } from './support/process.js';
import { runRewritten } from './support/rewritten-module.js';
import { until } from './support/watch-wait.js';
import { ORDER_WIRE, runSite, sharedFolderProject } from './support/shared-folder-project.js';

const SERDE = '@exprtlabs/golem/serde';

/** Vite caches a transform only when it starts after the module's invalidation, to the millisecond: returns once the clock has left the millisecond of the call. */
function pastThisMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start);
}

/** Bundlers resolve `.js` specifiers to their `.ts` files, so the imports are the ones tsc accepts. */
const MAIN = `import { parse, stringify } from '${SERDE}';
import type { TMoney } from './money.model.js';
import './money.model.js';
import { twice } from './util.js';

const text = stringify<TMoney>({ currency: 'USD', value: '1' });
const money = parse<TMoney>(text);
console.log(JSON.stringify({ money, twice: twice(21) }));
const trace = new Error('where am I').stack;
console.log(trace);
try {
  parse<TMoney>('not json');
} catch (error) {
  console.log(\`failure \${(error as Error).stack}\`);
}
`;
const UTIL = 'export const twice = (value: number): number => value * 2;\n';

function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

/** Bundles `<root>/<entry>` to `<outDir>/main.mjs` with a linked source map. */
interface Bundler {
  readonly name: string;
  /** Vite's own esbuild step strips these, and leaves `.cts` alone. */
  readonly extensions: readonly string[];
  bundle(root: string, entry: string, outDir: string, options?: GolemHostOptions): Promise<void>;
}

const BUNDLERS: readonly Bundler[] = [
  {
    name: 'vite',
    extensions: ['.ts', '.mts', '.tsx'],
    async bundle(root, entry, outDir, options) {
      await vite({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [vitePlugin(options)],
        build: { lib: { entry, formats: ['es'], fileName: () => 'main.mjs' }, outDir, emptyOutDir: true, sourcemap: true, minify: false },
      });
    },
  },
  {
    name: 'esbuild',
    extensions: ['.ts', '.mts', '.cts', '.tsx'],
    async bundle(root, entry, outDir, options) {
      await esbuild({
        absWorkingDir: root,
        entryPoints: [entry],
        outfile: path.join(outDir, 'main.mjs'),
        bundle: true,
        format: 'esm',
        platform: 'node',
        sourcemap: true,
        logLevel: 'silent',
        plugins: [esbuildPlugin(options)],
      });
    },
  },
];

/** A tag model beside the money model: a second module that parses a model the money model's edits leave alone. */
const TAG_MODEL = "\nexport type TTag = IObject<{ label: string }>;\n";
const TAG_USE = `import { parse } from '${SERDE}';
import type { TTag } from './money.model.js';

export const tag = parse<TTag>('{"label":"a"}');
`;

/** A generated project: the model source and its generated files. */
async function generatedProject(t: TestContext, name: string, options: { readonly generate?: boolean; readonly validation?: boolean } = {}): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-bundler-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { noEmit: true },
  });
  write(root, 'golem.yaml', `version: 1\nmobx: false\nvalidation: ${options.validation === true}\nmodels:\n  root: .\n`);
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8') + TAG_MODEL);
  write(root, 'src/main.ts', MAIN);
  write(root, 'src/util.ts', UTIL);
  write(root, 'src/tag.ts', TAG_USE);
  if (options.generate !== false) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/** The codec ids a rewritten module asks the runtime for when it runs, in call order. */
function requestedCodecIds(code: string | undefined): readonly string[] {
  return runRewritten(code).codecIds;
}

function lineOf(source: string, prefix: string): number {
  return source.split(/\r?\n/).findIndex((text) => text.replace(/^\uFEFF/, '').startsWith(prefix)) + 1;
}

/** The codec id the project's codec key file gives `name`. */
function codecId(root: string, name: string): string {
  const table = keyTable(root);
  const id = new RegExp(`#${name}": "(${name}_[0-9a-f]+)"`).exec(fs.readFileSync(table, 'utf8'))?.[1];
  assert.ok(id, `${table} names ${name}`);
  return id;
}

function keyTable(root: string): string {
  return path.join(root, '.golem/codec-keys.json');
}

/** Adds a field to `TMoney`, so `golem generate` gives it another codec id. */
async function changeMoney(root: string): Promise<void> {
  const file = path.join(root, 'src/money.model.ts');
  write(root, 'src/money.model.ts', fs.readFileSync(file, 'utf8').replace('value: string }>', 'value: string; note?: string }>'));
  await runPipeline(path.join(root, 'golem.yaml'));
}

/** The project's files and their mtimes, taken before a build and compared after it: a build edits no source. */
async function build(bundler: Bundler, t: TestContext, root: string, entry: string, options?: GolemHostOptions): Promise<string> {
  const outDir = createFixtureProject(t, 'golem-bundle-out-');
  const before = snapshotFilesystem(root);
  try {
    await bundler.bundle(root, entry, outDir, options);
  } finally {
    assert.deepEqual(snapshotFilesystem(root), before, `${bundler.name} changed a file of the project`);
  }
  return path.join(outDir, 'main.mjs');
}

/** A rejected build's message, which both bundlers carry the plugin's own error text in. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    // A snapshot assertion of build() is a test failure, not the build error under test.
    if (error instanceof assert.AssertionError) throw error;
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('the build succeeded');
}

/** A source that starts with a byte order mark, has CRLF line ends and Vietnamese text. */
const BOM_CRLF = `﻿${[
  '// Thanh toán — đơn hàng',
  `import { parse } from '${SERDE}';`,
  "import type { TMoney } from './money.model.js';",
  "import './money.model.js';",
  "const label = 'đơn hàng';",
  'const money = parse<TMoney>(\'{"currency":"VND","value":"1"}\');',
  'console.log(JSON.stringify({ label, money }));',
  "console.log(new Error('where am I').stack);",
].join('\r\n')}\r\n`;

/** A file that calls `parse<TMoney>` and exports the result, for the extensions a bundler strips types from. */
const CALL = `import { parse } from '${SERDE}';
import type { TMoney } from './money.model.js';
import './money.model.js';

export const value: string = JSON.stringify(parse<TMoney>('{"currency":"EUR","value":"2"}'));
`;

/** The mapped line of the first stack frame in `output` that names `file`. */
function frameLines(output: string, file: string): number[] {
  return [...output.matchAll(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+`, 'g'))].map((match) => Number(match[1]));
}

for (const bundler of BUNDLERS) {
  test(`${bundler.name}: the bundle runs the parse and stringify calls the host rewrites.`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-run`);
    const bundle = await build(bundler, t, root, 'src/main.ts');
    const result = await command(root, process.execPath, [bundle]);
    assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { money: { currency: 'USD', value: '1' }, twice: 42 });
  });

  test(`${bundler.name}: the bundle's source map resolves a rewritten line to its original file and line`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-source-map`);
    const bundle = await build(bundler, t, root, 'src/main.ts');
    const result = await command(root, process.execPath, ['--enable-source-maps', bundle]);
    // The rewrite prepends an import line, so the line in the rewritten text is one past the original. Node reports
    // a mapped frame at the column where the map's segment starts, so the line and the file name carry the check.
    const file = path.join(root, 'src/main.ts');
    const [traceStack, failureStack] = result.stdout.split('failure ');
    assert.ok(frameLines(traceStack ?? '', file).includes(lineOf(MAIN, 'const trace')), result.stdout);
    // The failing call is an edited span: its frame resolves to the line the call stands on in the original file.
    assert.ok(frameLines(failureStack ?? '', file).includes(lineOf(MAIN, '  parse<TMoney>')), result.stdout);
  });

  test(`${bundler.name}: a file with a byte order mark, CRLF line ends and Vietnamese text bundles, runs and maps to its original line`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-bom-crlf`);
    write(root, 'src/bom-crlf.ts', BOM_CRLF);
    const bundle = await build(bundler, t, root, 'src/bom-crlf.ts');
    const result = await command(root, process.execPath, ['--enable-source-maps', bundle]);
    assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { label: 'đơn hàng', money: { currency: 'VND', value: '1' } });
    assert.ok(frameLines(result.stdout, path.join(root, 'src/bom-crlf.ts')).includes(lineOf(BOM_CRLF, 'console.log(new Error')), result.stdout);
  });

  test(`${bundler.name}: a call whose model has no generated code fails the build with the file, the line and what to run`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-no-generated`, { generate: false });
    const message = await failure(build(bundler, t, root, 'src/main.ts'));
    assert.match(message, new RegExp(`src/main\\.ts:${lineOf(MAIN, 'const text')}\\b`), message);
    assert.match(message, /run golem generate/);
  });

  test(`${bundler.name}: a project with no golem.yaml fails the build with the config error`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-no-config`);
    fs.rmSync(path.join(root, 'golem.yaml'));
    const message = await failure(build(bundler, t, root, 'src/util.ts'));
    assert.ok(message.includes('golem needs a golem.yaml to rewrite parse<T>() calls; set config or GOLEM_CONFIG'), message);
  });

  test(`${bundler.name}: the config option names a golem.yaml that is not in the working directory`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-config-option`);
    fs.mkdirSync(path.join(root, 'app'));
    write(root, 'app/entry.ts', `import '../src/main.js';\n`);
    fs.renameSync(path.join(root, 'golem.yaml'), path.join(root, 'config.yaml'));
    const bundle = await build(bundler, t, root, 'app/entry.ts', { config: 'config.yaml' });
    const result = await command(root, process.execPath, [bundle]);
    assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { money: { currency: 'USD', value: '1' }, twice: 42 });
  });

  test(`${bundler.name}: a file with a parse call is rewritten for every TypeScript extension the bundler strips`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-extensions`);
    const names = bundler.extensions.map((extension) => `call${extension}`);
    for (const name of names) write(root, `src/${name}`, CALL);
    write(root, 'src/entry.ts', `${names.map((name, index) => `import { value as v${index} } from './${name}';`).join('\n')}\nconsole.log(JSON.stringify([${names.map((_, index) => `v${index}`).join(', ')}]));\n`);
    const bundle = await build(bundler, t, root, 'src/entry.ts');
    const result = await command(root, process.execPath, [bundle]);
    assert.deepEqual(JSON.parse(result.stdout), names.map(() => '{"currency":"EUR","value":"2"}'));
  });
}

/** A workspace package symlinked into the project's node_modules: its real path is outside the project root and outside node_modules. */
function symlinkedPackage(t: TestContext, root: string): void {
  const workspacePackage = createFixtureProject(t, 'golem-bundler-workspace-package-');
  linkProjectPackages(workspacePackage, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  write(workspacePackage, 'package.json', JSON.stringify({ name: 'workspace-lib', type: 'module', exports: './lib.ts' }));
  write(workspacePackage, 'lib.ts', `import { parse } from '${SERDE}';\nimport type { TMoney } from '${path.join(root, 'src/money.model.ts')}';\nexport const value = parse<TMoney>('{"currency":"USD","value":"1"}');\n`);
  linkProjectPackages(root, { 'workspace-lib': workspacePackage });
  write(root, 'src/linked.ts', "import './money.model.js';\nimport { value } from 'workspace-lib';\nconsole.log(JSON.stringify(value));\n");
}

for (const bundler of BUNDLERS) {
  test(`${bundler.name}: a parse call in a file outside the project, which the project imports by its path, is rewritten and the bundle runs`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-outside-file`);
    const outside = createFixtureProject(t, 'golem-bundler-outside-');
    linkProjectPackages(outside, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
    write(outside, 'lib.ts', `import { parse } from '${SERDE}';\nimport type { TMoney } from '${path.join(root, 'src/money.model.ts')}';\nexport const value = parse<TMoney>('{"currency":"USD","value":"1"}');\n`);
    write(root, 'src/outside.ts', `import './money.model.js';\nimport { value } from '${path.join(outside, 'lib.js')}';\nconsole.log(JSON.stringify(value));\n`);
    const bundle = await build(bundler, t, root, 'src/outside.ts');
    const result = await command(root, process.execPath, [bundle]);
    assert.deepEqual(JSON.parse(result.stdout), { currency: 'USD', value: '1' });
  });

  test(`${bundler.name}: a parse call in a workspace package symlinked into node_modules is rewritten and the bundle runs`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-symlinked-package`);
    symlinkedPackage(t, root);
    const bundle = await build(bundler, t, root, 'src/linked.ts');
    const result = await command(root, process.execPath, [bundle]);
    assert.deepEqual(JSON.parse(result.stdout), { currency: 'USD', value: '1' });
  });

  test(`${bundler.name}: a bundle of app A runs over the plain types of the shared folder`, async (t) => {
    const project = sharedFolderProject(t, `${bundler.name}-shared-folder`);
    await runPipeline(path.join(project.appA, 'golem.yaml'));
    const bundle = await build(bundler, t, project.appA, 'src/site.ts');
    const outcome = await runSite(project.appA, bundle);
    assert.deepEqual(outcome.wire, ORDER_WIRE);
    assert.equal(outcome.validityObservable, true);
    assert.match(outcome.rejected ?? '', /Model validation failed/);
  });
}

test('the rewrite project of one golem.yaml is shared, and its session lives until the last host closes it', async (t) => {
  const root = await generatedProject(t, 'shared-project');
  const file = path.join(root, 'src/main.ts');
  const text = fs.readFileSync(file, 'utf8');
  const first = await openRewriteProject({ cwd: root });
  const second = await openRewriteProject({ cwd: root });
  first.close();
  // The second host still has a live session.
  assert.deepEqual(requestedCodecIds(second.rewrite(file, text)?.code), Array(3).fill(codecId(root, 'TMoney')));
  second.close();
  assert.throws(() => second.rewrite(file, text), /closed/, 'the last close disposes the session');
  // Closing again is not a second release; a later host opens a new session.
  first.close();
  const third = await openRewriteProject({ cwd: root });
  t.after(() => third.close());
  assert.deepEqual(requestedCodecIds(third.rewrite(file, text)?.code), Array(3).fill(codecId(root, 'TMoney')));
});

/** A Vite dev server with no file watching: closing a server before its watcher finished scanning leaves a handle open and the test process alive. */
async function serve(t: TestContext, root: string): Promise<ViteDevServer> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    plugins: [vitePlugin()],
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => server.close());
  return server;
}

test('vite serve: a transformed module is rewritten and its map names the module by its own file name', async (t) => {
  const root = await generatedProject(t, 'vite-serve');
  const server = await serve(t, root);
  const before = snapshotFilesystem(root);
  const result = await server.transformRequest('/src/main.ts');
  assert.deepEqual(requestedCodecIds(result?.code), Array(3).fill(codecId(root, 'TMoney')));
  // The browser resolves a served map's `sources` against the module's URL.
  const map = result?.map;
  assert.ok(map && 'sources' in map);
  assert.deepEqual(map.sources, ['main.ts']);
  assert.deepEqual(snapshotFilesystem(root), before, 'serving changed a file of the project');
});

test('vite serve: a new file with its first parse call, added after the server started, is rewritten', async (t) => {
  const root = await generatedProject(t, 'vite-new-file');
  const server = await serve(t, root);
  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/main.ts'))?.code), Array(3).fill(codecId(root, 'TMoney')));
  write(root, 'src/later.ts', CALL);
  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/later.ts'))?.code), [codecId(root, 'TMoney')]);
});

test('vite serve: regenerating a model transforms again the module that used it, and no other', async (t) => {
  const root = await generatedProject(t, 'vite-regenerate');
  const server = await serve(t, root);
  const send = t.mock.method(server.ws, 'send', () => undefined);
  const reloads = (): number => send.mock.calls.filter((call) => (call.arguments[0] as { type?: string } | undefined)?.type === 'full-reload').length;
  const moduleOf = (file: string) => server.moduleGraph.getModuleById(path.join(root, file));
  const oldId = codecId(root, 'TMoney');
  const watched: string[] = [];
  const add = server.watcher.add.bind(server.watcher);
  server.watcher.add = (paths) => { watched.push(...[paths].flat()); return add(paths); };

  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/main.ts'))?.code), Array(3).fill(oldId));
  assert.ok((await server.transformRequest('/src/tag.ts'))?.code);
  assert.ok(watched.includes(keyTable(root)), `the key table is not watched: ${watched.join(', ')}`);
  assert.ok(moduleOf('src/main.ts')?.transformResult && moduleOf('src/tag.ts')?.transformResult, 'both modules are cached after their first transform');

  await changeMoney(root);
  const newId = codecId(root, 'TMoney');
  assert.notEqual(newId, oldId);
  server.watcher.emit('change', keyTable(root));
  assert.equal(moduleOf('src/main.ts')?.transformResult, null);
  assert.ok(moduleOf('src/tag.ts')?.transformResult);
  await until(() => reloads() === 1, 'the reload of the regenerated model');

  // Vite caches a transform only when it starts after the module's invalidation, to the millisecond.
  pastThisMillisecond();
  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/main.ts'))?.code), Array(3).fill(newId));

  // The same files announced again change no rewrite: nothing is invalidated and no reload is sent.
  server.watcher.emit('change', keyTable(root));
  assert.ok(moduleOf('src/main.ts')?.transformResult, 'main.ts stays cached when the same files are announced again');
  assert.ok(moduleOf('src/tag.ts')?.transformResult, 'tag.ts stays cached when the same files are announced again');
});

test('vite serve: retargeting an alias that a module parses through transforms it again with the new codec id', async (t) => {
  // protects: T-10 a type-only edit in a file the module reaches only by type must not leave the old codec id
  const root = await generatedProject(t, 'vite-alias');
  write(root, 'src/alias.ts', "export type { TMoney as TAlias } from './money.model.js';\n");
  write(root, 'src/use-alias.ts', `import { parse } from '${SERDE}';\nimport type { TAlias } from './alias.js';\n\nexport const value = parse<TAlias>('{}');\n`);
  const server = await serve(t, root);
  const moneyId = codecId(root, 'TMoney');
  const tagId = codecId(root, 'TTag');

  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/use-alias.ts'))?.code), [moneyId]);
  write(root, 'src/alias.ts', "export type { TTag as TAlias } from './money.model.js';\n");
  server.watcher.emit('change', path.join(root, 'src/alias.ts'));
  assert.equal(server.moduleGraph.getModuleById(path.join(root, 'src/use-alias.ts'))?.transformResult, null);
  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/use-alias.ts'))?.code), [tagId]);
});

test('vite serve: retargeting an alias or an export * that a module reaches through a barrel transforms it again with the new codec id', async (t) => {
  // protects: T-10 an export * barrel between a module and its alias must not leave the old codec id
  const root = await generatedProject(t, 'vite-barrel');
  write(root, 'src/alias.ts', "export type { TMoney as TAlias } from './money.model.js';\n");
  write(root, 'src/other.ts', "export type { TTag as TAlias } from './money.model.js';\n");
  write(root, 'src/barrel.ts', "export * from './alias.js';\n");
  write(root, 'src/use-barrel.ts', `import { parse } from '${SERDE}';\nimport type { TAlias } from './barrel.js';\n\nexport const value = parse<TAlias>('{}');\n`);
  const server = await serve(t, root);
  const idsIn = async (): Promise<readonly string[]> => requestedCodecIds((await server.transformRequest('/src/use-barrel.ts'))?.code);
  const changed = (file: string): void => { server.watcher.emit('change', path.join(root, file)); };
  const moneyId = codecId(root, 'TMoney');
  const tagId = codecId(root, 'TTag');

  assert.deepEqual(await idsIn(), [moneyId]);
  write(root, 'src/alias.ts', "export type { TTag as TAlias } from './money.model.js';\n");
  changed('src/alias.ts');
  assert.deepEqual(await idsIn(), [tagId]);

  write(root, 'src/alias.ts', "export type { TMoney as TAlias } from './money.model.js';\n");
  changed('src/alias.ts');
  assert.deepEqual(await idsIn(), [moneyId]);
  write(root, 'src/barrel.ts', "export * from './other.js';\n");
  changed('src/barrel.ts');
  assert.deepEqual(await idsIn(), [tagId]);
});

test('vite serve: the file events of one run invalidate every module they change and send one full reload', async (t) => {
  // protects: T-314 one watch run writes several files; the page reloads once, not once per file
  const root = await generatedProject(t, 'vite-one-reload');
  for (const name of ['first', 'second']) {
    write(root, `src/${name}-alias.ts`, "export type { TMoney as TAlias } from './money.model.js';\n");
    write(root, `src/use-${name}.ts`, `import { parse } from '${SERDE}';\nimport type { TAlias } from './${name}-alias.js';\n\nexport const value = parse<TAlias>('{}');\n`);
  }
  const server = await serve(t, root);
  const send = t.mock.method(server.ws, 'send', () => undefined);
  const reloads = (): number => send.mock.calls.filter((call) => (call.arguments[0] as { type?: string } | undefined)?.type === 'full-reload').length;
  for (const name of ['first', 'second']) await server.transformRequest(`/src/use-${name}.ts`);

  for (const name of ['first', 'second']) {
    write(root, `src/${name}-alias.ts`, "export type { TTag as TAlias } from './money.model.js';\n");
    server.watcher.emit('change', path.join(root, `src/${name}-alias.ts`));
  }

  for (const name of ['first', 'second']) {
    assert.equal(server.moduleGraph.getModuleById(path.join(root, `src/use-${name}.ts`))?.transformResult, null, `${name} is invalidated by its own event`);
  }
  await until(() => reloads() > 0, 'the reload of the run');
  assert.equal(reloads(), 1, 'both events share one reload');
});

test('vite serve: a module whose model had no generated code transforms again once golem generate has written it', async (t) => {
  const root = await generatedProject(t, 'vite-recover', { generate: false });
  const server = await serve(t, root);
  const send = t.mock.method(server.ws, 'send', () => undefined);
  await assert.rejects(server.transformRequest('/src/main.ts'), /run golem generate/);
  await runPipeline(path.join(root, 'golem.yaml'));
  server.watcher.emit('add', keyTable(root));
  await until(() => send.mock.calls.filter((call) => (call.arguments[0] as { type?: string } | undefined)?.type === 'full-reload').length === 1, 'the reload once golem generate has written the model');
  pastThisMillisecond();
  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/main.ts'))?.code), Array(3).fill(codecId(root, 'TMoney')));
});

test('vite serve: a generated model file outside the project root transforms again a module that failed, as one inside does', async (t) => {
  const root = await generatedProject(t, 'vite-recover-outside', { generate: false });
  const server = await serve(t, root);
  const send = t.mock.method(server.ws, 'send', () => undefined);
  await assert.rejects(server.transformRequest('/src/main.ts'), /run golem generate/);
  await runPipeline(path.join(root, 'golem.yaml'));
  server.watcher.emit('add', path.join(createFixtureProject(t, 'golem-bundler-outside-'), 'shared.model.generated.ts'));
  await until(() => send.mock.calls.filter((call) => (call.arguments[0] as { type?: string } | undefined)?.type === 'full-reload').length === 1, 'the reload once the outside model file exists');
  pastThisMillisecond();
  assert.deepEqual(requestedCodecIds((await server.transformRequest('/src/main.ts'))?.code), Array(3).fill(codecId(root, 'TMoney')));
});

/** An esbuild context in watch mode that writes the bundle; `built(n)` waits for build n and gives its error texts. */
async function watching(t: TestContext, root: string, entry: string): Promise<{ readonly bundle: string; built(count: number): Promise<readonly string[]> }> {
  const bundle = path.join(createFixtureProject(t, 'golem-bundle-out-'), 'main.mjs');
  const results: string[][] = [];
  const context = await esbuildContext({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [esbuildPlugin(), { name: 'record', setup(build) { build.onEnd((result) => { results.push(result.errors.map((error) => error.text)); }); } }],
  });
  t.after(() => context.dispose());
  await context.watch();
  return {
    bundle,
    async built(count) {
      await until(() => results.length >= count, `build ${count}`);
      return results[count - 1]!;
    },
  };
}

test('esbuild: a build of a validating model bundles its generated validators from the TypeScript file', async (t) => {
  const root = await generatedProject(t, 'esbuild-validating', { validation: true });
  const outfile = path.join(root, 'out/bundle.mjs');
  await esbuild({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent', plugins: [esbuildPlugin()] });
  const result = await command(root, process.execPath, [outfile]);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

test('vite serve: a validating model file imports its validators, which resolve from the .js specifier to the TypeScript file', async (t) => {
  const root = await generatedProject(t, 'vite-validating', { validation: true });
  const server = await serve(t, root);
  const companion = await server.transformRequest('/src/money.model.generated.ts');
  const imported = server.moduleGraph.getModuleById(path.join(root, 'src/money.model.generated.ts'))?.importedModules ?? new Set();
  assert.ok(companion && [...imported].some((module) => module.file === path.join(root, 'src/generated/models/models.validators.generated.ts')), 'the .js specifier resolves to the .ts file');
  assert.ok(await server.transformRequest('/src/generated/models/models.validators.generated.ts'), 'the validators module is served from its .ts file');
});

test('esbuild: an error is located at the file and the line of the call', async (t) => {
  const root = await generatedProject(t, 'esbuild-error-location', { generate: false });
  const failed = await esbuild({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, write: false, logLevel: 'silent', plugins: [esbuildPlugin()] }).then(() => undefined, (error: BuildFailure) => error);
  assert.ok(failed, 'the build succeeded');
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0]!.text, /run golem generate/);
  assert.equal(path.resolve(root, failed.errors[0]!.location!.file), path.join(root, 'src/main.ts'));
  assert.equal(failed.errors[0]!.location?.line, lineOf(MAIN, 'const text'));
});

test('esbuild: a build that failed for want of generated code runs again once golem generate has written it', async (t) => {
  const root = await generatedProject(t, 'esbuild-recover', { generate: false });
  const watch = await watching(t, root, 'src/main.ts');
  assert.match((await watch.built(1)).join('\n'), /run golem generate/);
  await runPipeline(path.join(root, 'golem.yaml'));
  assert.deepEqual(await watch.built(2), []);
  const result = await command(root, process.execPath, [watch.bundle]);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

test('esbuild: a new file with its first parse call, added to a watched build, is rewritten', async (t) => {
  const root = await generatedProject(t, 'esbuild-new-file');
  const watch = await watching(t, root, 'src/main.ts');
  assert.deepEqual(await watch.built(1), []);
  write(root, 'src/later.ts', CALL);
  write(root, 'src/main.ts', `${MAIN}import { value } from './later.js';\nconsole.log(value);\n`);
  assert.deepEqual(await watch.built(2), []);
  const result = await command(root, process.execPath, [watch.bundle]);
  assert.ok(result.stdout.split('\n').includes('{"currency":"EUR","value":"2"}'), result.stdout);
});

test('esbuild: a watched build runs again when a model is regenerated, and rewrites with the new codec id', async (t) => {
  const root = await generatedProject(t, 'esbuild-regenerate');
  const watch = await watching(t, root, 'src/main.ts');
  assert.deepEqual(await watch.built(1), []);
  const oldId = codecId(root, 'TMoney');
  assert.ok(fs.readFileSync(watch.bundle, 'utf8').includes(oldId));
  await changeMoney(root);
  const newId = codecId(root, 'TMoney');
  assert.notEqual(newId, oldId);
  assert.deepEqual(await watch.built(2), []);
  const bundled = fs.readFileSync(watch.bundle, 'utf8');
  assert.ok(bundled.includes(newId), 'the rebuilt bundle has the new codec id');
  assert.ok(!bundled.includes(oldId), 'the rebuilt bundle has no old codec id');
});

test('esbuild: a file with no rewrite still reaches the onLoad plugins after golem', async (t) => {
  const root = await generatedProject(t, 'esbuild-later');
  const seen: string[] = [];
  const result = await esbuild({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [esbuildPlugin(), {
      name: 'later',
      setup(build) {
        build.onLoad({ filter: /\.ts$/, namespace: 'file' }, ({ path: file }) => {
          seen.push(path.basename(file));
          return file.endsWith('util.ts') ? { contents: "export const twice = (): string => 'from the later plugin';", loader: 'ts' } : undefined;
        });
      },
    }],
  });
  assert.ok(seen.includes('util.ts'), seen.join(', '));
  assert.match(result.outputFiles[0]!.text, /from the later plugin/);
});
