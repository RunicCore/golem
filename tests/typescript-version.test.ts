import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveTypeScript, UnsupportedTypeScriptError } from '#golem/typescript-version';

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
