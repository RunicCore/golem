import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertGolemLoadsTypeScript, resolveTypeScript, TypeScriptNotInstalledError, UnsupportedTypeScriptError } from '#golem/typescript-version';
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
  assert.equal(resolveTypeScript(fakeProject('7.1.0')).major, 7);
  assert.equal(resolveTypeScript(fakeProject('7.1.0-beta')).major, 7);
});
test('(b) other majors fail with the version and path', () => {
  const root = fakeProject('5.9.3');
  assert.throws(() => resolveTypeScript(root), (error: unknown) => error instanceof UnsupportedTypeScriptError
    && /TypeScript 6\.0\+ and 7\.1\+; found 5\.9\.3 at .*node_modules\/typescript\.$/.test((error as Error).message));
});
test('(b2) TypeScript 7.0 fails and names golem 1.0', () => {
  for (const version of ['7.0.2', '7.0.1-rc']) {
    assert.throws(() => resolveTypeScript(fakeProject(version)), (error: unknown) => error instanceof UnsupportedTypeScriptError
      && new RegExp(`TypeScript 6\\.0\\+ and 7\\.1\\+; found ${version.replaceAll('.', '\\.')} at .*node_modules\\/typescript\\. golem 1\\.0 supports TypeScript 7\\.0\\.$`).test((error as Error).message), version);
  }
});
test('(c) the project\'s own TypeScript wins over golem\'s', () => {
  const root = fakeProject('6.0.3');
  // Node resolves a package to its real path, and the temp folder of macOS is a link (/var to /private/var).
  assert.equal(resolveTypeScript(root).packageDir, path.join(realpathSync(root), 'node_modules', 'typescript'));
});
test('(d) TypeScript 7 that is another install than the one golem loads fails naming both', () => {
  const root = fakeProject('7.1.0');
  const project = resolveTypeScript(root);
  assert.throws(() => assertGolemLoadsTypeScript(project), (error: unknown) => error instanceof UnsupportedTypeScriptError
    && /golem loads TypeScript 7 \(7\.\d+\.\d+(?:-[\w.]+)?\) from .*node_modules\/typescript but the project uses 7\.1\.0 at .*golem-ts-version-.*node_modules\/typescript; install one TypeScript 7 for both/.test((error as Error).message));
});
test('(e) TypeScript 7 that is the install golem loads is accepted', () => {
  assertGolemLoadsTypeScript(resolveTypeScript(workspace));
});
test('(f) a root where neither the project nor golem has TypeScript fails naming the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'golem-ts-version-none-'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  assert.throws(() => resolveTypeScript(root, pathToFileURL(path.join(root, 'golem.js')).href), (error: unknown) => error instanceof UnsupportedTypeScriptError
    && error.message === `golem needs TypeScript 6.0+ or 7.1+ installed in ${path.relative(process.cwd(), root)}.`);
});
test('(f2) a TypeScript that cannot be resolved for another reason than a missing package keeps the reason as the cause', () => {
  // protects: E-34 the resolve error is chained, not swallowed
  const root = fakeProject('6.0.3');
  writeFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), '{ not json');
  assert.throws(() => resolveTypeScript(root, pathToFileURL(path.join(root, 'golem.js')).href), (error: unknown) => error instanceof TypeScriptNotInstalledError
    && (error.cause as { code?: string }).code === 'ERR_INVALID_PACKAGE_CONFIG');
});
test('(g) the facade refuses a TypeScript 7 project that is not the install golem loads', async () => {
  const root = fakeProject('7.1.0');
  const result = await command(workspace, process.execPath, ['--input-type=module', '-e', "await import('#golem/typescript-ns');"], {
    env: { GOLEM_TYPESCRIPT_ROOT: root },
    allowFailure: true,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /golem loads TypeScript 7 .* but the project uses 7\.1\.0 at .*; install one TypeScript 7 for both/);
});
