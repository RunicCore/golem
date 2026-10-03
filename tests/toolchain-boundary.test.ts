import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function portable(filename: string): string {
  return filename.split(path.sep).join('/');
}

function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build') continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(filename));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(filename);
  }
  return found;
}

test('typescript/unstable stays inside the generator shim', () => {
  const hits = typescriptFiles(path.join(root, 'packages'))
    .filter((filename) => fs.readFileSync(filename, 'utf8').includes('typescript/unstable'))
    .map((filename) => portable(path.relative(root, filename)))
    .sort();
  assert.deepEqual(hits, ['packages/golem/src/tooling/typescript-ts7.ts']);
});

test('the classic typescript package stays inside the TypeScript 6 backend', () => {
  // The backend loads the project's TypeScript by the directory `resolveTypeScript` found, so a bare import would load golem's own.
  const hits = typescriptFiles(path.join(root, 'packages'))
    .filter((filename) => /from\s+['"]typescript['"]|import\(\s*['"]typescript['"]\s*\)|\brequire\(\s*[\w.]*packageDir\s*\)/.test(fs.readFileSync(filename, 'utf8')))
    .map((filename) => portable(path.relative(root, filename)))
    .sort();
  assert.deepEqual(hits, ['packages/golem/src/tooling/typescript-ts6.ts']);
});

test('analysis reads renamed AST members only through the seam', () => {
  const offenders = typescriptFiles(path.join(root, 'packages'))
    .filter((filename) => !/typescript-ns\.ts$|typescript-ts[67]\.ts$/.test(filename))
    .filter((filename) => /\.defaultType\b|\b(?:type|reference)\.target\b|\.target\?\.getSymbol/.test(fs.readFileSync(filename, 'utf8')))
    .map((filename) => portable(path.relative(root, filename)))
    .sort();
  assert.deepEqual(offenders, []);
});

// golem owns its compile-time rewrite (`golem build`, the Vite and esbuild plugins, the Node loader). The root keeps ttsc
// only as a devDependency for scripts/benchmark/project.ts, which compiles the typia benchmark adapter with typia's transform.
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.build', '.golem', '.git']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies'] as const;

function filesUnder(directory: string, accept: (name: string) => boolean): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesUnder(filename, accept);
    return accept(entry.name) ? [filename] : [];
  });
}

const relativeName = (filename: string): string => portable(path.relative(root, filename));
const packageDirectories = fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'packages', entry.name));
const isTtscPackage = (name: string): boolean => name === 'ttsc' || name.startsWith('@ttsc/');
const readManifest = (filename: string): Record<string, Record<string, unknown> | undefined> => JSON.parse(fs.readFileSync(filename, 'utf8'));

test('no golem package declares ttsc as a dependency, a peer or an optional dependency', () => {
  for (const directory of packageDirectories) {
    const manifest = readManifest(path.join(directory, 'package.json'));
    for (const field of DEPENDENCY_FIELDS) {
      assert.deepEqual(Object.keys(manifest[field] ?? {}).filter(isTtscPackage), [], `${relativeName(directory)}/package.json ${field} names ttsc`);
    }
  }
});

test('no package.json outside the workspace root mentions ttsc, and the root keeps it only as a devDependency', () => {
  const manifests = ['packages', 'examples', 'tests/fixtures'].flatMap((directory) => filesUnder(path.join(root, directory), (name) => name === 'package.json'));
  for (const filename of manifests) assert.ok(!/ttsc/.test(fs.readFileSync(filename, 'utf8')), `${relativeName(filename)} mentions ttsc`);
  const rootManifest = readManifest(path.join(root, 'package.json'));
  for (const field of DEPENDENCY_FIELDS.filter((field) => field !== 'devDependencies')) {
    assert.deepEqual(Object.keys(rootManifest[field] ?? {}).filter(isTtscPackage), [], `the root package.json ${field} names ttsc`);
  }
});

test('no package.json script runs ttsc', () => {
  const manifests = [path.join(root, 'package.json'), ...filesUnder(path.join(root, 'packages'), (name) => name === 'package.json'), ...filesUnder(path.join(root, 'examples'), (name) => name === 'package.json')];
  for (const filename of manifests) {
    const scripts = (JSON.parse(fs.readFileSync(filename, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, script] of Object.entries(scripts)) assert.ok(!/\bttsc\b/.test(script), `${relativeName(filename)} script ${name} runs ttsc`);
  }
});

test('no tsconfig in packages, examples or the test fixtures lists a ttsc plugin', () => {
  const tsconfigs = ['packages', 'examples', 'tests/fixtures'].flatMap((directory) => filesUnder(path.join(root, directory), (name) => /^tsconfig(\..+)?\.json$/.test(name)));
  assert.ok(tsconfigs.length > 0, 'the scan found no tsconfig');
  for (const filename of tsconfigs) assert.ok(!/ttsc/i.test(fs.readFileSync(filename, 'utf8')), `${relativeName(filename)} mentions ttsc`);
});

test('the golem packages ship no ttsc plugin or Go source, and their source never mentions ttsc', () => {
  for (const directory of packageDirectories) {
    assert.ok(!fs.existsSync(path.join(directory, 'ttsc-plugin.cjs')), `${relativeName(directory)}/ttsc-plugin.cjs exists`);
    assert.ok(!fs.existsSync(path.join(directory, 'plugin')), `${relativeName(directory)}/plugin exists`);
    for (const filename of filesUnder(path.join(directory, 'src'), (name) => /\.[cm]?[jt]sx?$/.test(name))) {
      assert.ok(!/ttsc/i.test(fs.readFileSync(filename, 'utf8')), `${relativeName(filename)} mentions ttsc`);
    }
  }
});
