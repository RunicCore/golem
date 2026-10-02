// The Node loader applies the rewrite index to TypeScript in memory; Node then strips the types and runs the result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { load } from '#golem/loader';
import { runPipeline } from '#golem/cli';
import { sha256Hex, type RewriteEdit, type RewriteIndex } from '#golem/rewrite';
import { GOLEM_VERSION } from '#golem/version';
import { copyFixtureFile, createFixtureProject, linkProjectPackages, snapshotFilesystem, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { command, workspace, type CommandResult } from './support/process.js';

const NODE_FLAGS = ['--import', '@exprtlabs/golem/register', '--experimental-strip-types', '--enable-source-maps'] as const;
const SERDE = '@exprtlabs/golem/serde';

/** Under Node's type stripping every relative import names its `.ts` file. */
const MAIN = `import { parse, stringify } from '${SERDE}';
import type { TMoney } from './money.model.ts';
import './money.model.ts';
import { twice } from './util.ts';

const text = stringify<TMoney>({ currency: 'USD', value: '1' });
const money = parse<TMoney>(text);
console.log(JSON.stringify({ money, twice: twice(21) }));
const trace = new Error('where am I').stack;
console.log(trace);
`;
const UTIL = 'export const twice = (value: number): number => value * 2;\n';

function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

/** A project that runs under Node's type stripping, and runs `golem generate` unless told not to. */
async function project(t: TestContext, name: string, options: { readonly generate?: boolean } = {}): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-loader-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { noEmit: true, allowImportingTsExtensions: true },
  });
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('.generated.js', '.generated.ts'));
  write(root, 'src/main.ts', MAIN);
  write(root, 'src/util.ts', UTIL);
  if (options.generate !== false) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/** Runs the loader in a child Node, then asserts that the loader changed no file of the project: bytes and mtimes. */
async function run(root: string, file: string): Promise<CommandResult> {
  const before = snapshotFilesystem(root);
  const result = await command(root, process.execPath, [...NODE_FLAGS, file], { allowFailure: true });
  assert.deepEqual(snapshotFilesystem(root), before, 'the loader changed a file of the project');
  return result;
}

test('node runs a TypeScript file whose parse and stringify calls the index rewrites', async (t) => {
  const root = await project(t, 'loader-run');
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  const [json] = result.stdout.split('\n');
  assert.deepEqual(JSON.parse(json!), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

test('a stack trace through a rewritten file names its original line', async (t) => {
  const root = await project(t, 'loader-source-map');
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  // The rewrite prepends an import line, so the generated line is one past the original. Node reports a mapped
  // frame at the column where the map's segment starts, so the line and the file name carry the check.
  const line = MAIN.split('\n').findIndex((text) => text.startsWith('const trace')) + 1;
  const frame = new RegExp(`${path.join(root, 'src/main.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+\\)?$`, 'm');
  assert.equal(Number(result.stdout.match(frame)?.[1]), line, result.stdout);
});

test('a source changed after generate fails the run and names the file', async (t) => {
  const root = await project(t, 'loader-stale-source');
  write(root, 'src/main.ts', `${MAIN}// edited after generate\n`);
  const result = await run(root, 'src/main.ts');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GolemRewriteStaleError/);
  assert.match(result.stderr, /src\/main\.ts changed after golem generate/);
});

test('an index written by another golem version fails the run and names the file', async (t) => {
  const root = await project(t, 'loader-stale-version');
  const indexFile = path.join(root, '.golem/rewrites.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as RewriteIndex;
  fs.writeFileSync(indexFile, JSON.stringify({ ...index, golem: '0.0.1-old' }));
  const result = await run(root, 'src/main.ts');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GolemRewriteStaleError/);
  assert.match(result.stderr, /src\/main\.ts/);
  assert.match(result.stderr, /written by golem 0\.0\.1-old; run golem generate/);
});

test('a project without an index fails the run instead of loading its sources unrewritten', async (t) => {
  const root = await project(t, 'loader-no-index', { generate: false });
  const result = await run(root, 'src/util.ts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(`no golem rewrite index at ${path.join(root, '.golem/rewrites.json')}; run golem generate`), result.stderr);
});

test('a file the index does not list loads untouched and a file it lists loads rewritten, for every extension Node strips', async (t) => {
  const root = createFixtureProject(t, 'golem-loader-hook-');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const call = 'parse<T>(text)';
  const rewritten = '__golem_parse(text)';
  const files: Record<string, { sha256: string; edits: RewriteEdit[]; imports: { from: string; names: string[] }[] }> = {};
  const extensions = ['.ts', '.mts', '.cts'];
  for (const extension of extensions) {
    const text = `export const value = ${call};\n`;
    write(root, `src/listed${extension}`, text);
    write(root, `src/unlisted${extension}`, text);
    const start = text.indexOf(call);
    files[`src/listed${extension}`] = { sha256: sha256Hex(text), edits: [{ start, end: start + call.length, expect: call, text: rewritten }], imports: [{ from: SERDE, names: ['parse'] }] };
  }
  const index: RewriteIndex = { version: 1, golem: GOLEM_VERSION, files };
  write(root, '.golem/rewrites.json', JSON.stringify(index));
  const before = snapshotFilesystem(root);
  // Node's own default load, standing in for the next hook: format and the raw bytes.
  const nextLoad = (url: string) => ({ format: 'module-typescript', source: fs.readFileSync(new URL(url)) });
  for (const extension of extensions) {
    const listed = await load(pathToFileURL(path.join(root, `src/listed${extension}`)).href, {}, nextLoad);
    assert.equal(listed.format, 'module-typescript');
    assert.match(String(listed.source), /^import \{ parse as __golem_parse \} from '@exprtlabs\/golem\/serde';\nexport const value = __golem_parse\(text\);\n\n\/\/# sourceMappingURL=data:application\/json;base64,/, extension);
    const unlisted = await load(pathToFileURL(path.join(root, `src/unlisted${extension}`)).href, {}, nextLoad);
    assert.equal(Buffer.from(unlisted.source as Uint8Array).toString('utf8'), `export const value = ${call};\n`, extension);
  }
  assert.deepEqual(snapshotFilesystem(root), before);
});

test('files under node_modules, .tsx files, other schemes and non-TypeScript files pass through with no index', async (t) => {
  const root = createFixtureProject(t, 'golem-loader-passthrough-');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const before = snapshotFilesystem(root);
  const next = { format: 'module', source: 'marker' };
  const nextLoad = () => next;
  for (const url of [
    pathToFileURL(path.join(root, 'node_modules/dep/index.ts')).href,
    pathToFileURL(path.join(root, 'src/view.tsx')).href,
    pathToFileURL(path.join(root, 'src/plain.js')).href,
    pathToFileURL(path.join(root, 'src/data.json')).href,
    'node:fs',
    'data:text/javascript,export default 1',
  ]) assert.equal(await load(url, {}, nextLoad), next, url);
  assert.deepEqual(snapshotFilesystem(root), before);
});

/** A project with no golem.yaml: `src/<file>` is listed in a hand-written index, so Node's own format choice decides how it loads. */
function indexedProject(t: TestContext, packageJson: string, sources: Readonly<Record<string, string>>, listed: readonly string[]): string {
  const root = createFixtureProject(t, 'golem-loader-format-');
  linkProjectPackages(root, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  write(root, 'package.json', packageJson);
  write(root, 'tsconfig.json', '{}');
  const call = 'parse<string>(text)';
  const files: Record<string, RewriteIndex['files'][string]> = {};
  for (const [file, text] of Object.entries(sources)) {
    write(root, file, text);
    const start = text.indexOf(call);
    if (listed.includes(file)) files[file] = { sha256: sha256Hex(text), edits: [{ start, end: start + call.length, expect: call, text: '__golem_parse(text)' }], imports: [{ from: SERDE, names: ['parse'] }] };
  }
  write(root, '.golem/rewrites.json', JSON.stringify({ version: 1, golem: GOLEM_VERSION, files } satisfies RewriteIndex));
  return root;
}

const CJS_CALL = "const text: string = 'x';\nconst value = parse<string>(text);\nconsole.log(typeof require, value);\n";
const CJS_PLAIN = "const count: number = 7;\nconsole.log('cjs ran', count, typeof require);\n";

test('a listed .cts file fails the run: a rewrite cannot give CommonJS an import', async (t) => {
  const root = indexedProject(t, '{"type":"module"}', { 'src/listed.cts': CJS_CALL }, ['src/listed.cts']);
  const result = await run(root, 'src/listed.cts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem rewrites need ES modules; src/listed.cts loads as CommonJS'), result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot use import statement/);
});

test('a listed .ts file in a package without "type" loads as CommonJS and fails the run', async (t) => {
  const root = indexedProject(t, '{}', { 'src/listed.ts': CJS_CALL }, ['src/listed.ts']);
  const result = await run(root, 'src/listed.ts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem rewrites need ES modules; src/listed.ts loads as CommonJS'), result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot use import statement/);
});

test('CommonJS TypeScript the index does not list still runs', async (t) => {
  const root = indexedProject(t, '{}', { 'src/plain.cts': CJS_PLAIN, 'src/plain.ts': CJS_PLAIN, 'src/other.ts': CJS_CALL }, ['src/other.ts']);
  for (const file of ['src/plain.cts', 'src/plain.ts']) {
    const result = await run(root, file);
    assert.equal(result.code, 0, `${file}: ${result.stderr}`);
    assert.equal(result.stdout, 'cjs ran 7 function\n', file);
  }
});

test('a file in a nested directory is checked against the index of its nearest ancestor', async (t) => {
  const root = createFixtureProject(t, 'golem-loader-nearest-');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  write(root, '.golem/rewrites.json', JSON.stringify({ version: 1, golem: GOLEM_VERSION, files: {} } satisfies RewriteIndex));
  write(root, 'packages/inner/src/file.ts', 'export {};\n');
  const before = snapshotFilesystem(root);
  const nextLoad = (url: string) => ({ format: 'module-typescript', source: fs.readFileSync(new URL(url)) });
  const loaded = await load(pathToFileURL(path.join(root, 'packages/inner/src/file.ts')).href, {}, nextLoad);
  assert.equal(Buffer.from(loaded.source as Uint8Array).toString('utf8'), 'export {};\n');
  assert.deepEqual(snapshotFilesystem(root), before);
});

test('the loader module graph imports only Node built-ins and relative files, so no TypeScript and no checker', () => {
  const dist = path.join(workspace, 'packages/golem/dist/tooling');
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const [, specifier] of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('./'), `${path.basename(file)} imports ${specifier}`);
      visit(path.join(path.dirname(file), specifier));
    }
  };
  visit(path.join(dist, 'loader.js'));
  visit(path.join(dist, 'register.js'));
  assert.ok(seen.has(path.join(dist, 'rewrite.js')));
  for (const file of seen) assert.doesNotMatch(path.basename(file), /typescript|type-analysis/, file);
});
