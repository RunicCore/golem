// The Vite and esbuild plugins apply the rewrite index to TypeScript in memory; the bundler then strips the types.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { build as esbuild } from 'esbuild';
import { build as vite, createServer } from 'vite';

import { runPipeline } from '#golem/cli';
import { golem as esbuildPlugin } from '#golem/esbuild';
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

/** Bundles `<root>/<entry>` to `<outDir>/main.mjs` with a linked source map. */
interface Bundler {
  readonly name: string;
  /** Vite's own esbuild step strips these, and leaves `.cts` alone. */
  readonly extensions: readonly string[];
  bundle(root: string, entry: string, outDir: string): Promise<void>;
}

const BUNDLERS: readonly Bundler[] = [
  {
    name: 'vite',
    extensions: ['.ts', '.mts', '.tsx'],
    async bundle(root, entry, outDir) {
      await vite({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [vitePlugin()],
        build: { lib: { entry, formats: ['es'], fileName: () => 'main.mjs' }, outDir, emptyOutDir: true, sourcemap: true, minify: false },
      });
    },
  },
  {
    name: 'esbuild',
    extensions: ['.ts', '.mts', '.cts', '.tsx'],
    async bundle(root, entry, outDir) {
      await esbuild({
        absWorkingDir: root,
        entryPoints: [entry],
        outfile: path.join(outDir, 'main.mjs'),
        bundle: true,
        format: 'esm',
        platform: 'node',
        sourcemap: true,
        logLevel: 'silent',
        plugins: [esbuildPlugin()],
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
async function build(bundler: Bundler, t: TestContext, root: string, entry: string): Promise<string> {
  const outDir = createFixtureProject(t, 'golem-bundle-out-');
  const before = snapshotFilesystem(root);
  try {
    await bundler.bundle(root, entry, outDir);
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
}

test('vite serve: a transformed module is rewritten, and a changed index invalidates it', async (t) => {
  const root = await generatedProject(t, 'vite-serve');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    plugins: [vitePlugin()],
    // No file watching: closing a server before its watcher finished scanning leaves a handle open and the test process alive.
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => server.close());
  const before = snapshotFilesystem(root);
  const result = await server.transformRequest('/src/main.ts');
  assert.match(result?.code ?? '', /__golem_requireObjectCodec\(/);
  // A served map names the module by its own file name: the browser resolves `sources` against the module's URL.
  const map = result?.map;
  assert.ok(map && 'sources' in map);
  assert.deepEqual(map.sources, ['main.ts']);
  assert.deepEqual(snapshotFilesystem(root), before, 'serving changed a file of the project');
  // A change event of the index file reaches the plugin through Vite's watcher; the module Vite already transformed is then transformed again.
  const main = server.moduleGraph.getModuleById(path.join(root, 'src/main.ts'));
  assert.ok(main?.transformResult);
  server.watcher.emit('change', path.join(root, '.golem/rewrites.json'));
  assert.equal(main.transformResult, null);
});
