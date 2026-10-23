/**
 * The runtime exports that generated code may name, typed from the runtime packages' own subpath modules. `rt.model.parseJson`
 * is a Code that holds a runtime part. A name that a module does not export is a type error, so a misspelled or removed
 * export fails golem's build. The table copies no list of names: the types are the list.
 */
import type * as client from '../client.js';
import type * as conversion from '../conversion.js';
import type * as errors from '../errors.js';
import type * as mobx from '../mobx.js';
import type * as mobxValidation from '../mobx-validation.js';
import type * as model from '../model.js';
import type * as serde from '../serde.js';
import type * as temporal from '../temporal.js';
import type * as validation from '../validation.js';
import type * as validationRuntime from '../validation-runtime.js';
import type { Code } from './code.js';

/** The runtime subpaths (`@exprtlabs/golem/<key>`) and the values each one exports. */
export interface RuntimeExports {
  readonly client: typeof client;
  readonly conversion: typeof conversion;
  readonly errors: typeof errors;
  readonly mobx: typeof mobx;
  readonly 'mobx-validation': typeof mobxValidation;
  readonly model: typeof model;
  readonly serde: typeof serde;
  readonly temporal: typeof temporal;
  readonly validation: typeof validation;
  readonly 'validation-runtime': typeof validationRuntime;
}

export type RuntimeModule = keyof RuntimeExports;

export type RuntimeTable = {
  readonly [M in RuntimeModule]: { readonly [N in keyof RuntimeExports[M] & string]: Code };
};

/** The fixed order of the import lines of the runtime parts. A module added to `RuntimeExports` must be ranked here. */
export const RUNTIME_MODULE_RANK = {
  client: 0,
  conversion: 1,
  errors: 2,
  mobx: 3,
  'mobx-validation': 4,
  model: 5,
  serde: 6,
  temporal: 7,
  validation: 8,
  'validation-runtime': 9,
} as const satisfies Record<RuntimeModule, number>;

function moduleTable(module: RuntimeModule): object {
  const codes = new Map<string, Code>();
  return new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      let named = codes.get(name);
      if (!named) codes.set(name, named = { parts: [{ kind: 'runtime', module, name }] });
      return named;
    },
  });
}

// The names of a module exist only as types, and loading the runtime modules here would load mobx on every run of the
// tooling. The cast is the one place where the table takes its type from them.
export const rt = Object.fromEntries(
  (Object.keys(RUNTIME_MODULE_RANK) as RuntimeModule[]).map((module) => [module, moduleTable(module)]),
) as unknown as RuntimeTable;
