import assert from 'node:assert/strict';

import { transformSync } from 'esbuild';

/** What a rewritten module did when it ran with every import stubbed: the codec ids it asked the runtime for, in call order, and the modules it imported. */
export interface RewrittenRun {
  readonly codecIds: readonly string[];
  readonly imports: readonly string[];
}

/** Runs the text of a rewritten module (TypeScript or JavaScript) with stubs for its imports, so a test reads what the rewrite did, not the text it wrote. */
export function runRewritten(code: string | undefined): RewrittenRun {
  assert.ok(code, 'the module was rewritten');
  const codecIds: string[] = [];
  const imports: string[] = [];
  const open: unknown = new Proxy(function stub() {}, { get: () => open, apply: () => open, construct: () => open as object });
  const imported = new Proxy({}, {
    get: (_target, name) => (name === 'requireObjectCodec' ? (id: string) => { codecIds.push(id); return open; } : open),
  });
  const { code: commonJs } = transformSync(code, { loader: 'ts', format: 'cjs', target: 'es2022' });
  new Function('require', 'exports', 'module', 'console', commonJs)((specifier: string) => { imports.push(specifier); return imported; }, {}, { exports: {} }, { log: () => undefined });
  return { codecIds, imports };
}
