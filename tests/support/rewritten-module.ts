import assert from 'node:assert/strict';
import fs from 'node:fs';

import { openScope, runModule } from './run-module.js';

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
  const open = openScope();
  const imported = openScope({
    requireObjectCodec: (id: string) => { codecIds.push(id); return open; },
    registerIModelClass: (id: string, constructor: { readonly name: string }) => { registered.push([id, constructor.name]); },
  });
  // A name the module uses but a test fixture leaves undeclared (a `declare const`) reads as a stub: run again with it declared.
  const stubbed: string[] = [];
  for (;;) {
    codecIds.length = imports.length = registered.length = 0;
    try {
      runModule(code, {
        ...Object.fromEntries(stubbed.map((name) => [name, open])),
        require: (specifier: string) => { imports.push(specifier); return imported; },
        exports: {},
        module: { exports: {} },
        console: { log: () => undefined },
      }, { format: 'cjs' });
      break;
    } catch (error) {
      const name = error instanceof ReferenceError ? /^(\w+) is not defined$/.exec(error.message)?.[1] : undefined;
      if (name === undefined || stubbed.includes(name)) throw error;
      stubbed.push(name);
    }
  }
  return { codecIds, imports, registered };
}

/** The module at `file`, run with its imports stubbed, asks the runtime for the TMoney codec: golem rewrote its parse and stringify calls. */
export function assertMoneyCodec(file: string, message: string = file): void {
  const ids = runRewritten(fs.readFileSync(file, 'utf8')).codecIds;
  assert.ok(ids.length > 0 && ids.every((id) => /^TMoney_[0-9a-f]{8}$/.test(id)), `${message}: ${ids.join(', ')}`);
}
