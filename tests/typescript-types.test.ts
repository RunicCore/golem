import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tooling = path.join(root, 'packages/golem/dist/tooling');

/** The declaration files a consumer of `@exprtlabs/golem/internal/ts` type-checks: the seam's own files and everything they import by relative path. */
function publishedDeclarations(entries: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [...entries];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (files.has(name)) continue;
    const text = fs.readFileSync(path.join(tooling, name), 'utf8');
    files.set(name, text);
    for (const match of text.matchAll(/(?:from|import\()\s*['"]\.\/([\w-]+)\.js['"]/g)) pending.push(`${match[1]}.d.ts`);
  }
  return files;
}

test('published seam declarations reference no TypeScript package', () => {
  const files = publishedDeclarations(['typescript-ns.d.ts', 'typescript-types.d.ts', 'typescript-version.d.ts']);
  const offenders = [...files]
    .filter(([, text]) => /(?:from|import\()\s*['"]typescript(?:\/|['"])/.test(text))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});
