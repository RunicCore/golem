// The Vite and esbuild plugins apply the rewrite index to TypeScript in memory; the bundler then strips the types.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { build as esbuild, context as esbuildContext, type BuildFailure } from 'esbuild';
import { build as vite, createServer, type ViteDevServer } from 'vite';

import { runPipeline } from '#golem/cli';
import { golem as esbuildPlugin } from '#golem/esbuild';
import type { GolemBundlerOptions } from '#golem/rewrite-host';
import { sha256Hex, type RewriteEdit, type RewriteIndex } from '#golem/rewrite';
import { golem as vitePlugin } from '#golem/vite';
import { GOLEM_VERSION } from '#golem/version';
import { copyFixtureFile, createFixtureProject, snapshotFilesystem, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { command, workspace } from './support/process.js';

const SERDE = '@exprtlabs/golem/serde';

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

const ORIGINAL = "'original'";

/** A source with one edit site: the index rewrites `'original'` to `'rewritten'`. */
function listedSource(variant = ''): string {
  return `export const value: string = ${ORIGINAL};${variant}\n`;
}

/** An index written by hand: each key is a path from the index's root, each value the text the index describes. */
function handIndex(sources: Readonly<Record<string, string>>): RewriteIndex {
  const files: Record<string, RewriteIndex['files'][string]> = {};
  for (const [key, text] of Object.entries(sources)) {
    const start = text.indexOf(ORIGINAL);
    files[key] = { sha256: sha256Hex(text), edits: [{ start, end: start + ORIGINAL.length, expect: ORIGINAL, text: "'rewritten'" } satisfies RewriteEdit], imports: [] };
  }
  return { version: 1, golem: GOLEM_VERSION, files };
}

/** Bundles `<root>/<entry>` to `<outDir>/main.mjs` with a linked source map. */
interface Bundler {
  readonly name: string;
  /** Vite's own esbuild step strips these, and leaves `.cts` alone. */
  readonly extensions: readonly string[];
  bundle(root: string, entry: string, outDir: string, options?: GolemBundlerOptions): Promise<void>;
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

/** A generated project: the model source, its generated files and `.golem/rewrites.json`. */
async function generatedProject(t: TestContext, name: string): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-bundler-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { noEmit: true },
  });
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/main.ts', MAIN);
  write(root, 'src/util.ts', UTIL);
  await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/** The project's files and their mtimes, taken before a build and compared after it: a build edits no source. */
async function build(bundler: Bundler, t: TestContext, root: string, entry: string, options?: GolemBundlerOptions): Promise<string> {
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

for (const bundler of BUNDLERS) {
  test(`${bundler.name}: the bundle runs the parse and stringify calls the index rewrites`, async (t) => {
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
    const lineOf = (prefix: string): number => MAIN.split('\n').findIndex((text) => text.startsWith(prefix)) + 1;
    const file = path.join(root, 'src/main.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [traceStack, failureStack] = result.stdout.split('failure ');
    const frames = (stack: string | undefined): number[] => [...(stack ?? '').matchAll(new RegExp(`${file}:(\\d+):\\d+`, 'g'))].map((match) => Number(match[1]));
    assert.ok(frames(traceStack).includes(lineOf('const trace')), result.stdout);
    // The failing call is an edited span: its frame resolves to the line the call stands on in the original file.
    assert.ok(frames(failureStack).includes(lineOf('  parse<TMoney>')), result.stdout);
  });

  test(`${bundler.name}: a source changed after generate fails the build and names the file`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-stale`);
    write(root, 'src/main.ts', `${MAIN}// edited after generate\n`);
    const message = await failure(build(bundler, t, root, 'src/main.ts'));
    assert.match(message, /src\/main\.ts changed after golem generate/);
  });

  test(`${bundler.name}: a project without an index fails the build instead of bundling its sources unrewritten`, async (t) => {
    const root = await generatedProject(t, `${bundler.name}-no-index`);
    fs.rmSync(path.join(root, '.golem'), { recursive: true });
    const message = await failure(build(bundler, t, root, 'src/util.ts'));
    assert.ok(message.includes(`no golem rewrite index at ${path.join(root, '.golem/rewrites.json')}; run golem generate`), message);
  });

  test(`${bundler.name}: a file the index lists is rewritten and one it does not list is not, for every TypeScript extension`, async (t) => {
    const root = createFixtureProject(t, 'golem-bundler-extensions-');
    write(root, 'package.json', '{"type":"module"}');
    write(root, 'tsconfig.json', '{}');
    const original = "'original'";
    const text = `export const value: string = ${original};\n`;
    const start = text.indexOf(original);
    const files: Record<string, RewriteIndex['files'][string]> = {};
    const { extensions } = bundler;
    for (const extension of extensions) {
      write(root, `src/listed${extension}`, text);
      files[`src/listed${extension}`] = { sha256: sha256Hex(text), edits: [{ start, end: start + original.length, expect: original, text: "'rewritten'" } satisfies RewriteEdit], imports: [] };
    }
    write(root, 'src/unlisted.ts', text);
    write(root, '.golem/rewrites.json', JSON.stringify({ version: 1, golem: GOLEM_VERSION, files } satisfies RewriteIndex));
    const names = [...extensions.map((extension) => `listed${extension}`), 'unlisted.ts'];
    write(root, 'src/main.ts', `${names.map((name, index) => `import { value as v${index} } from './${name}';`).join('\n')}\nconsole.log(JSON.stringify([${names.map((_, index) => `v${index}`).join(', ')}]));\n`);
    const bundle = await build(bundler, t, root, 'src/main.ts');
    const result = await command(root, process.execPath, [bundle]);
    assert.deepEqual(JSON.parse(result.stdout), [...extensions.map(() => 'rewritten'), 'original']);
  });

  test(`${bundler.name}: a relative root option resolves against the bundler's own working directory`, async (t) => {
    const root = createFixtureProject(t, 'golem-bundler-root-option-');
    write(root, 'package.json', '{"type":"module"}');
    const text = listedSource();
    write(root, 'src/a.ts', text);
    // The index sits beside the sources, not above them, so only the option can find it.
    write(root, 'other/.golem/rewrites.json', JSON.stringify(handIndex({ '../src/a.ts': text })));
    write(root, 'src/main.ts', "import { value } from './a.ts';\nconsole.log(value);\n");
    const bundle = await build(bundler, t, root, 'src/main.ts', { root: 'other' });
    assert.equal((await command(root, process.execPath, [bundle])).stdout, 'rewritten\n');
    const message = await failure(build(bundler, t, root, 'src/main.ts'));
    assert.ok(message.includes('no golem rewrite index at'), message);
  });
}

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
  assert.match(result?.code ?? '', /__golem_requireObjectCodec\(/);
  // The browser resolves a served map's `sources` against the module's URL.
  const map = result?.map;
  assert.ok(map && 'sources' in map);
  assert.deepEqual(map.sources, ['main.ts']);
  assert.deepEqual(snapshotFilesystem(root), before, 'serving changed a file of the project');
});

test('vite serve: the index above Vite\'s root is watched, and a change invalidates only the modules whose entry changed', async (t) => {
  const project = createFixtureProject(t, 'golem-bundler-serve-index-');
  write(project, 'package.json', '{"type":"module"}');
  write(project, 'tsconfig.json', '{}');
  const indexFile = path.join(project, '.golem/rewrites.json');
  const a = listedSource();
  const b = listedSource();
  write(project, 'app/a.ts', a);
  write(project, 'app/b.ts', b);
  write(project, '.golem/rewrites.json', JSON.stringify(handIndex({ 'app/a.ts': a, 'app/b.ts': b })));
  const server = await serve(t, path.join(project, 'app'));
  const watched: string[] = [];
  const add = server.watcher.add.bind(server.watcher);
  server.watcher.add = (paths) => { watched.push(...[paths].flat()); return add(paths); };
  const send = t.mock.method(server.ws, 'send', () => undefined);
  const reloads = (): number => send.mock.calls.filter((call) => (call.arguments[0] as { type?: string } | undefined)?.type === 'full-reload').length;
  const moduleOf = (file: string) => server.moduleGraph.getModuleById(path.join(project, file));
  const transformBoth = async (): Promise<void> => {
    for (const url of ['/a.ts', '/b.ts']) assert.match((await server.transformRequest(url))?.code ?? '', /"rewritten"/);
  };
  const change = (): void => { server.watcher.emit('change', indexFile); };

  await transformBoth();
  assert.ok(watched.includes(indexFile), `the index at ${indexFile} is not watched: ${watched.join(', ')}`);
  assert.ok(moduleOf('app/a.ts')?.transformResult && moduleOf('app/b.ts')?.transformResult);

  // An entry whose sha changed: only that module is invalidated, and the page reloads.
  const changedA = listedSource(' // changed');
  write(project, 'app/a.ts', changedA);
  write(project, '.golem/rewrites.json', JSON.stringify(handIndex({ 'app/a.ts': changedA, 'app/b.ts': b })));
  change();
  assert.equal(moduleOf('app/a.ts')?.transformResult, null);
  assert.ok(moduleOf('app/b.ts')?.transformResult);
  assert.equal(reloads(), 1);

  // The same entries written again: nothing is invalidated and no reload is sent.
  // Vite caches a transform only when it starts after the module's invalidation, to the millisecond.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await transformBoth();
  write(project, '.golem/rewrites.json', JSON.stringify(handIndex({ 'app/a.ts': changedA, 'app/b.ts': b })));
  change();
  assert.ok(moduleOf('app/a.ts')?.transformResult && moduleOf('app/b.ts')?.transformResult);
  assert.equal(reloads(), 1);

  // An entry removed from the index: that module is invalidated.
  write(project, '.golem/rewrites.json', JSON.stringify(handIndex({ 'app/a.ts': changedA })));
  change();
  assert.ok(moduleOf('app/a.ts')?.transformResult);
  assert.equal(moduleOf('app/b.ts')?.transformResult, null);
  assert.equal(reloads(), 2);
});

test('esbuild: a stale source is an error located at the source file', async (t) => {
  const root = createFixtureProject(t, 'golem-bundler-esbuild-error-');
  write(root, 'package.json', '{"type":"module"}');
  write(root, 'tsconfig.json', '{}');
  write(root, 'src/a.ts', listedSource());
  write(root, '.golem/rewrites.json', JSON.stringify(handIndex({ 'src/a.ts': listedSource(' // another text') })));
  write(root, 'src/main.ts', "import { value } from './a.ts';\nconsole.log(value);\n");
  const failed = await esbuild({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, write: false, logLevel: 'silent', plugins: [esbuildPlugin()] }).then(() => undefined, (error: BuildFailure) => error);
  assert.ok(failed, 'the build succeeded');
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0]!.text, /src\/a\.ts changed after golem generate/);
  assert.equal(failed.errors[0]!.location?.file, 'src/a.ts');
});

test('esbuild: watch mode builds again when the index changes', async (t) => {
  const root = createFixtureProject(t, 'golem-bundler-esbuild-watch-');
  write(root, 'package.json', '{"type":"module"}');
  write(root, 'tsconfig.json', '{}');
  const text = listedSource();
  write(root, 'src/a.ts', text);
  write(root, 'src/unlisted.ts', listedSource(' // not listed'));
  write(root, '.golem/rewrites.json', JSON.stringify(handIndex({ 'src/a.ts': text })));
  write(root, 'src/main.ts', "import { value } from './a.ts';\nimport { value as other } from './unlisted.ts';\nconsole.log(value, other);\n");
  const outputs: string[] = [];
  const context = await esbuildContext({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [esbuildPlugin(), { name: 'record', setup(build) { build.onEnd((result) => { outputs.push(result.outputFiles?.[0]?.text ?? ''); }); } }],
  });
  t.after(() => context.dispose());
  await context.watch();
  const built = async (count: number): Promise<void> => {
    for (const deadline = Date.now() + 10_000; outputs.length < count && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(outputs.length >= count, `no build ${count} after the index changed`);
  };
  await built(1);
  assert.match(outputs[0]!, /"rewritten"|'rewritten'/);
  // The index lists the second file too: esbuild watches the index, so it builds again though no source changed.
  const unlisted = listedSource(' // not listed');
  write(root, '.golem/rewrites.json', JSON.stringify(handIndex({ 'src/a.ts': text, 'src/unlisted.ts': unlisted })));
  await built(2);
  assert.equal(outputs[1]!.match(/rewritten/g)?.length, 2);
});
