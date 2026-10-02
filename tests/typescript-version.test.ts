import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertGolemLoadsTypeScript, resolveTypeScript, UnsupportedTypeScriptError } from '#golem/typescript-version';
import { command, workspace } from './support/process.js';

function fakeProject(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'golem-ts-version-'));
  const dir = path.join(root, 'node_modules', 'typescript');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version }));
  writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}
test('(a) TypeScript 6 and 7 are selected by major', () => {
  assert.equal(resolveTypeScript(fakeProject('6.0.3')).major, 6);
  assert.equal(resolveTypeScript(fakeProject('7.0.2')).major, 7);
});
test('(b) other majors fail with the version and path', () => {
  const root = fakeProject('5.9.3');
  assert.throws(() => resolveTypeScript(root), (error: unknown) => error instanceof UnsupportedTypeScriptError
    && /TypeScript 6\.0\+ and 7\.x; found 5\.9\.3 at .*node_modules\/typescript/.test((error as Error).message));
});
test('(c) the project\'s own TypeScript wins over golem\'s', () => {
  const root = fakeProject('6.0.3');
  assert.equal(resolveTypeScript(root).packageDir, path.join(root, 'node_modules', 'typescript'));
});
test('(d) TypeScript 7 that is another install than the one golem loads fails naming both', () => {
  const root = fakeProject('7.0.2');
  const project = resolveTypeScript(root);
  assert.throws(() => assertGolemLoadsTypeScript(project), (error: unknown) => error instanceof UnsupportedTypeScriptError
    && /golem loads TypeScript 7 \(7\.\d+\.\d+\) from .*node_modules\/typescript but the project uses 7\.0\.2 at .*golem-ts-version-.*node_modules\/typescript; install one TypeScript 7 for both/.test((error as Error).message));
});
test('(e) TypeScript 7 that is the install golem loads is accepted', () => {
  assertGolemLoadsTypeScript(resolveTypeScript(workspace));
});
test('(f) a root where neither the project nor golem has TypeScript fails naming the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'golem-ts-version-none-'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  assert.throws(() => resolveTypeScript(root, pathToFileURL(path.join(root, 'golem.js')).href), (error: unknown) => error instanceof UnsupportedTypeScriptError
    && error.message === `golem needs TypeScript 6.0+ or 7.x installed in ${root}.`);
});
test('(g) the facade refuses a TypeScript 7 project that is not the install golem loads', async () => {
  const root = fakeProject('7.0.2');
  const result = await command(workspace, process.execPath, ['--input-type=module', '-e', "await import('#golem/typescript-ns');"], {
    env: { GOLEM_TYPESCRIPT_ROOT: root },
    allowFailure: true,
    timeout: 30_000,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /golem loads TypeScript 7 .* but the project uses 7\.0\.2 at .*; install one TypeScript 7 for both/);
});
