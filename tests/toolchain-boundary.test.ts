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
