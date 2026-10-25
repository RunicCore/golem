import assert from 'node:assert/strict';

import { transformSync } from 'esbuild';

/** What a rewritten module did when it ran with every import stubbed: the codec ids it asked the runtime for, in call order, and the modules it imported. */
export interface RewrittenRun {
  readonly codecIds: readonly string[];
  readonly imports: readonly string[];
  /** The model classes registered with `registerIModelClass`, as [codec key, class name], in call order. */
  readonly registered: ReadonlyArray<readonly [string, string]>;
}

/** Runs the text of a rewritten module (TypeScript or JavaScript) with stubs for its imports, so a test reads what the rewrite did, not the text it wrote. */
export function runRewritten(code: string | undefined): RewrittenRun {
  assert.ok(code, 'the module was rewritten');
  const codecIds: string[] = [];
  const imports: string[] = [];
  const registered: Array<readonly [string, string]> = [];
  const open: unknown = new Proxy(function stub() {}, { get: () => open, apply: () => open, construct: () => open as object });
  const imported = new Proxy({}, {
    get: (_target, name) => {
      if (name === 'requireObjectCodec') return (id: string) => { codecIds.push(id); return open; };
      if (name === 'registerIModelClass') return (id: string, constructor: { readonly name: string }) => { registered.push([id, constructor.name]); };
      return open;
    },
  });
  const { code: commonJs } = transformSync(code, { loader: 'ts', format: 'cjs', target: 'es2022' });
  // A name the module uses but a test fixture leaves undeclared (a `declare const`) reads as a stub: run again with it declared.
  const stubbed: string[] = [];
  for (;;) {
    codecIds.length = imports.length = registered.length = 0;
    try {
      new Function(...stubbed, 'require', 'exports', 'module', 'console', commonJs)(
        ...stubbed.map(() => open), (specifier: string) => { imports.push(specifier); return imported; }, {}, { exports: {} }, { log: () => undefined },
      );
      break;
    } catch (error) {
      const name = error instanceof ReferenceError ? /^(\w+) is not defined$/.exec(error.message)?.[1] : undefined;
      if (name === undefined || stubbed.includes(name)) throw error;
      stubbed.push(name);
    }
  }
  return { codecIds, imports, registered };
}
