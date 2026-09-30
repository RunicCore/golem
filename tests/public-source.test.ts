import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  exportPublicSource,
  listPublicSourceFiles,
  publicContentOptions,
  scanPublicContent,
} from '../scripts/public-source.js';

function joinParts(...parts: string[]): string {
  return parts.join('');
}

function fixtureRoot(t: TestContext, prefix = 'golem-public-source-'): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixture(root: string, relative: string, content = ''): string {
  const filename = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, content);
  return filename;
}

function publicFixture(t: TestContext): string {
  const root = fixtureRoot(t);
  writeFixture(root, 'package.json', '{"name":"fixture"}\n');
  writeFixture(root, 'README.md', '# Fixture\n');
  writeFixture(root, 'LICENSE', 'upstream license\n');
  writeFixture(root, 'CHANGELOG.md', '# Changes\n');
  writeFixture(root, '.gitignore', 'node_modules\n');
  writeFixture(root, 'tsconfig.json', '{}\n');
  writeFixture(root, 'packages/golem/package.json', '{"name":"codegen"}\n');
  writeFixture(root, 'packages/golem/README.md', '# Golem\n');
  writeFixture(root, 'packages/golem/LICENSE', 'upstream package license\n');
  writeFixture(root, 'packages/golem/MATRIX.md', '# Matrix\n');
  writeFixture(root, 'packages/golem/compliance/capabilities.json', '{}\n');
  writeFixture(root, 'packages/golem/THIRD_PARTY_NOTICES.md', 'notice\n');
  writeFixture(root, 'packages/golem/LICENSES/Apache-2.0.txt', 'bundled license text\n');
  writeFixture(root, 'packages/golem/tsconfig.json', '{}\n');
  writeFixture(root, 'packages/golem/src/index.ts', 'export const value = 1;\n');
  writeFixture(root, 'packages/golem-ts-openapi/package.json', '{"name":"golem-ts-openapi"}\n');
  writeFixture(root, 'packages/golem-ts-openapi/README.md', '# Controller generator\n');
  writeFixture(root, 'packages/golem-ts-openapi/LICENSE', 'upstream package license\n');
  writeFixture(root, 'packages/golem-ts-openapi/src/index.ts', 'export const value = 1;\n');
  writeFixture(root, 'scripts/check.ts', 'export {};\n');
  writeFixture(root, 'tests/example.test.ts', 'export {};\n');
  writeFixture(root, 'docs/index.md', '# Docs\n');
  writeFixture(root, 'examples/model/package.json', '{"name":"model-example"}\n');
  writeFixture(root, 'examples/model/src/main.ts', 'export {};\n');
  writeFixture(root, 'examples/model/sdk/model-manifest.json', '{"manifestVersion":2}\n');
  writeFixture(root, 'examples/model/.golem/outputs.json', '{}\n');
  writeFixture(root, '.github/workflows/check.yml', 'name: checks\n');
  return root;
}

function allFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filename);
      } else {
        files.push(path.relative(root, filename).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  return files.sort();
}

function treeSnapshot(root: string): string {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).split(path.sep).join('/');
      if (entry.isDirectory()) {
        entries.push(`directory:${relative}`);
        visit(filename);
      } else if (entry.isSymbolicLink()) {
        entries.push(`symlink:${relative}:${readFileSync(filename, 'utf8')}`);
      } else if (entry.isFile()) {
        entries.push(`file:${relative}:${readFileSync(filename, 'base64')}`);
      }
    }
  };
  visit(root);
  return entries.join('\n');
}

test('public source inventory keeps licenses, generated example metadata, and source surfaces, and excludes local, generated, dependency, and workflow-local trees', (t) => {
  const root = publicFixture(t);
  const files = listPublicSourceFiles(root);
  const expected = [
    'LICENSE',
    'packages/golem/LICENSE',
    'packages/golem/MATRIX.md',
    'packages/golem/compliance/capabilities.json',
    'packages/golem/THIRD_PARTY_NOTICES.md',
    'packages/golem/LICENSES/Apache-2.0.txt',
    'packages/golem/src/index.ts',
    'packages/golem-ts-openapi/LICENSE',
    'packages/golem-ts-openapi/src/index.ts',
    'examples/model/sdk/model-manifest.json',
    'examples/model/.golem/outputs.json',
    '.github/workflows/check.yml',
  ];
  for (const relative of expected) assert.ok(files.includes(relative), relative);
  assert.deepEqual(files, [...files].sort());
  for (const relative of files) {
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.split('/').includes('..'), false);
  }
  const dotPrivate = joinParts('.', 'pri', 'vate');
  const dotCache = joinParts('.', 'ca', 'che');
  const modules = joinParts('node', '_modules');
  const compiled = joinParts('di', 'st');
  const envFile = joinParts('.', 'en', 'v');
  const localWorkflow = joinParts('.', 'assi', 'stant');
  const excluded = [
    `${dotPrivate}/notes.md`,
    `${dotCache}/generated.json`,
    `${modules}/foreign/index.js`,
    `${compiled}/bundle.js`,
    envFile,
    `${localWorkflow}/config.json`,
  ];
  for (const relative of excluded) writeFixture(root, relative, 'placeholder\n');
  const filesWithExcluded = listPublicSourceFiles(root);
  for (const relative of excluded) assert.equal(filesWithExcluded.includes(relative), false, relative);
});

test('interrupted documentation build output stays outside a public source export', (t) => {
  const root = publicFixture(t);
  const temporaryModule = 'docs/.vitepress/.temp/index.md.js';
  writeFixture(root, temporaryModule, 'export const compiled = true;\n');
  writeFixture(root, 'docs/.vitepress/config.ts', 'export default {};\n');
  const destination = path.join(root, '.cache', 'export');
  const result = exportPublicSource(root, destination);
  assert.equal(result.files.includes(temporaryModule), false);
  assert.equal(existsSync(path.join(destination, temporaryModule)), false);
  assert.equal(existsSync(path.join(destination, 'docs/.vitepress/config.ts')), true);
  assert.deepEqual(scanPublicContent(root, [temporaryModule]), [
    { path: temporaryModule, category: 'private-artifact' },
  ]);
});

test('content scanner reports forbidden paths and payload classes without returning payload text, and accepts an explicit safe candidate set', (t) => {
  const root = publicFixture(t);
  const dotPrivate = joinParts('.', 'pri', 'vate');
  const absolutePath = joinParts('/', 'Users', '/', 'sample', '/', 'workspace', '/', 'source.ts');
  const keyPayload = joinParts(
    '-----BEGIN ', 'PRIV', 'ATE ', 'KEY-----\n',
    'synthetic-body\n',
    '-----END ', 'PRIV', 'ATE ', 'KEY-----\n',
  );
  const marker = joinParts('synthetic-', 'workflow-', 'record-', 'marker');
  const executionRecord = joinParts(
    'operation', ' id: "', '123e4567', '-e89b-', '12d3-', 'a456-', '426614174000', '"',
  );
  writeFixture(root, `${dotPrivate}/notes.md`, marker);
  writeFixture(root, 'docs/reference.md', `${absolutePath}\n${marker}\n${executionRecord}\n`);
  writeFixture(root, 'docs/credential.txt', keyPayload);

  const issues = scanPublicContent(root);
  assert.deepEqual(issues, [
    { path: `${dotPrivate}/notes.md`, category: 'private-artifact' },
    { path: 'docs/credential.txt', category: 'private-key' },
    { path: 'docs/reference.md', category: 'machine-path' },
    { path: 'docs/reference.md', category: 'execution-record' },
  ]);
  const serialized = JSON.stringify(issues);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes(keyPayload), false);
  assert.equal(serialized.includes(absolutePath), false);
  // An explicit safe candidate set is scanned without touching the unrelated forbidden files.
  assert.deepEqual(scanPublicContent(root, ['README.md', 'packages/golem/src/index.ts']), []);
});

test('scanner rejects traversal candidates before reading outside the source root', (t) => {
  const root = publicFixture(t);
  assert.deepEqual(scanPublicContent(root, ['../outside.txt']), [
    { path: '[outside root]', category: 'path-traversal' },
  ]);
  const outside = joinParts('/', 'Users', '/', 'sample', '/', 'outside.txt');
  assert.deepEqual(scanPublicContent(root, [outside]), [
    { path: '[outside root]', category: 'path-traversal' },
  ]);
});

test('export is deterministic, preserves portable public files, and leaves its source unchanged', (t) => {
  const root = publicFixture(t);
  const dotCache = joinParts('.', 'ca', 'che');
  writeFixture(root, `${dotCache}/ignored.txt`, 'ignored\n');
  const sourceBefore = treeSnapshot(root);
  const firstDestination = path.join(path.dirname(root), 'public-export-one');
  const secondDestination = path.join(path.dirname(root), 'public-export-two');
  t.after(() => {
    rmSync(firstDestination, { recursive: true, force: true });
    rmSync(secondDestination, { recursive: true, force: true });
  });

  const first = exportPublicSource(root, firstDestination);
  const second = exportPublicSource(root, secondDestination);
  assert.ok(first.digest.length > 0);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(first.files, listPublicSourceFiles(root));
  assert.deepEqual(allFiles(firstDestination), [...first.files].sort());
  assert.deepEqual(allFiles(secondDestination), [...second.files].sort());
  for (const relative of first.files) {
    assert.equal(
      readFileSync(path.join(firstDestination, relative), 'base64'),
      readFileSync(path.join(secondDestination, relative), 'base64'),
    );
  }
  assert.equal(treeSnapshot(root), sourceBefore);
});

test('export permits an empty destination and rejects an ambiguous non-empty destination without mutation', (t) => {
  const root = publicFixture(t);
  const emptyDestination = path.join(path.dirname(root), 'public-export-empty');
  const occupiedDestination = path.join(path.dirname(root), 'public-export-occupied');
  mkdirSync(emptyDestination, { recursive: true });
  mkdirSync(occupiedDestination, { recursive: true });
  const sentinel = writeFixture(occupiedDestination, 'sentinel.txt', 'unchanged\n');
  const before = treeSnapshot(occupiedDestination);
  t.after(() => {
    rmSync(emptyDestination, { recursive: true, force: true });
    rmSync(occupiedDestination, { recursive: true, force: true });
  });

  assert.doesNotThrow(() => exportPublicSource(root, emptyDestination));
  assert.throws(
    () => exportPublicSource(root, occupiedDestination),
    /empty|destination|occupied/i,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged\n');
  assert.equal(treeSnapshot(occupiedDestination), before);
});

test('rejected source validation does not create or mutate an export destination', (t) => {
  const root = publicFixture(t);
  const dotPrivate = joinParts('.', 'pri', 'vate');
  const marker = joinParts('synthetic-', 'workflow-', 'record-', 'marker');
  writeFixture(root, `${dotPrivate}/public-content.json`, JSON.stringify({ deniedText: [marker] }));
  writeFixture(root, 'docs/reference.md', marker);
  const destination = path.join(path.dirname(root), 'public-export-rejected');
  assert.throws(() => exportPublicSource(root, destination), /forbidden|private|local|content|path/i);
  assert.equal(existsSync(destination), false);

  mkdirSync(destination, { recursive: true });
  const sentinel = writeFixture(destination, 'sentinel.txt', 'unchanged\n');
  const before = treeSnapshot(destination);
  assert.throws(() => exportPublicSource(root, destination), /forbidden|private|local|content|path/i);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged\n');
  assert.equal(treeSnapshot(destination), before);
  rmSync(destination, { recursive: true, force: true });
});

test('escaped symlinks are rejected before export and do not mutate the destination', (t) => {
  const root = publicFixture(t);
  const outside = fixtureRoot(t, 'golem-public-source-outside-');
  const outsideFile = writeFixture(outside, 'outside.md', 'outside\n');
  const link = path.join(root, 'docs', 'linked.md');
  symlinkSync(outsideFile, link);
  const destination = path.join(path.dirname(root), 'public-export-symlink');

  assert.throws(() => listPublicSourceFiles(root), /symlink|outside|escape|link/i);
  assert.throws(() => exportPublicSource(root, destination), /symlink|outside|escape|link/i);
  assert.equal(existsSync(destination), false);
});

test('denied text from the environment rejects content without reporting the value', (t) => {
  const root = publicFixture(t);
  const marker = joinParts('synthetic-', 'environment-', 'marker');
  writeFixture(root, 'packages/golem/plugin/main.go', `package main // ${marker}\n`);
  const env = { PUBLIC_CONTENT_DENIED_TEXT: `\n${marker}\r\n` };
  const issues = scanPublicContent(root, listPublicSourceFiles(root), publicContentOptions(root, env));
  assert.deepEqual(issues, [{ path: 'packages/golem/plugin/main.go', category: 'private-reference' }]);
  assert.equal(JSON.stringify(issues).includes(marker), false);

  assert.deepEqual(publicContentOptions(root, {}), {});
  assert.throws(() => publicContentOptions(root, { PUBLIC_CONTENT_REQUIRE_DENIED_TEXT: '1' }), /No denied text is configured/);
});
