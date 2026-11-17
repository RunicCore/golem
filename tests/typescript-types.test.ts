import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from '@exprtlabs/golem/internal/ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tooling = path.join(root, 'packages/golem/dist/tooling');

/**
 * What a declaration file names: each string literal token (so `from`, `import()`, `import x = require()` and `export ... from` alike), and the
 * value of each `/// <reference types|path|lib="...">` directive. The lexer skips what a comment or a word only mentions.
 */
function namedModules(text: string): string[] {
  const scanner = ts.createScanner(false, text);
  const named: string[] = [];
  for (let kind = scanner.scan(); scanner.getTokenStart() < text.length; kind = scanner.scan()) {
    const token = text.slice(scanner.getTokenStart(), scanner.getTokenEnd());
    if (kind === ts.SyntaxKind.StringLiteral) named.push(token.slice(1, -1));
    const directive = kind === ts.SyntaxKind.SingleLineCommentTrivia ? /^\/\/\/\s*<reference\s+(?:types|path|lib)\s*=\s*["']([^"']+)["']/.exec(token) : null;
    if (directive?.[1] !== undefined) named.push(directive[1]);
  }
  return named;
}

/** The declaration files a consumer of `@exprtlabs/golem/internal/ts` type-checks: the seam's own files and everything they name by relative path. */
function publishedDeclarations(entries: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [...entries];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (files.has(name)) continue;
    const text = fs.readFileSync(path.join(tooling, name), 'utf8');
    files.set(name, text);
    for (const specifier of namedModules(text)) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) pending.push(path.posix.join(path.posix.dirname(name), specifier).replace(/\.js$/, '.d.ts'));
    }
  }
  return files;
}

test('published seam declarations reference no TypeScript package', () => {
  // protects: F-1147 no import, import-equals, import type, re-export or reference directive of a published seam declaration names typescript, typescript/* or @typescript/*
  const files = publishedDeclarations(['typescript-ns.d.ts', 'typescript-types.d.ts', 'typescript-version.d.ts']);
  const offenders = [...files].flatMap(([name, text]) => namedModules(text).filter((specifier) => /^(?:@typescript\/|typescript(?:\/|$))/.test(specifier)).map((specifier) => `${name} names ${specifier}`));
  assert.deepEqual(offenders, []);
});
