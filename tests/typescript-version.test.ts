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
  assert.equal(resolveTypeScript(fakeProject('6.9.0')).major, 6);
  assert.equal(resolveTypeScript(fakeProject('7.1.0')).major, 7);
  assert.equal(resolveTypeScript(fakeProject('7.1.0-beta')).major, 7);
});
test('(a2) the seam loads the backend of the major of the TypeScript it selects', async () => {
  // protects: F-1141 typescript-ns picks the TypeScript 6 backend for a 6.x project and the TypeScript 7 backend for 7.1+
  const typescript6Root = process.env.GOLEM_TYPESCRIPT6_ROOT;
  assert.ok(typescript6Root, 'GOLEM_TYPESCRIPT6_ROOT is not set: run this in the test container (npm run test -- tests/typescript-version.test.ts)');
  for (const [major, root] of [[6, typescript6Root], [7, workspace]] as const) {
    const script = `const ns = await import('#golem/typescript-ns'); const backend = await import('#golem/typescript-ts${major}');
console.log(JSON.stringify({ version: ns.typescriptVersion, sameBackend: ns.ProgramSession === backend.ProgramSession }));`;
    const result = await command(workspace, process.execPath, ['--input-type=module', '-e', script], { env: { GOLEM_TYPESCRIPT_ROOT: root } });
    const { version, sameBackend } = JSON.parse(result.stdout) as { version: string; sameBackend: boolean };
    assert.equal(version.split('.')[0], String(major), `the root of TypeScript ${major} loads ${version}`);
    assert.equal(sameBackend, true, `the seam serves the TypeScript ${major} backend`);
  }
});
for (const version of ['5.9.3', '7.0.2', '7.0.1-rc', '8.0.0', '8.2.1-beta']) {
  test(`(b) TypeScript ${version} fails with the version and path`, () => {
    // protects: F-1142 a TypeScript outside 6.x and 7.1+ stops golem, below and above, naming the found version and the package path
    const root = fakeProject(version);
    const packageDir = path.join(realpathSync(root), 'node_modules', 'typescript');
    assert.throws(() => resolveTypeScript(root), (error: unknown) => error instanceof UnsupportedTypeScriptError
      && error.message === `golem supports TypeScript 6.0+ and 7.1+; found ${version} at ${path.relative(process.cwd(), packageDir)}.`);
  });
}
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
