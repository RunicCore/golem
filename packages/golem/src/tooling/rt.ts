/**
 * The runtime exports that generated code may name. A value comes from an internal runtime entry that generated files import
 * from, and a type from the public subpath of its module, because applications see the types in their declaration files.
 * `rt.serde.parseJson` is a Code that holds a runtime part. A name that an entry or a module does not export is a type
 * error, so a misspelled or removed export fails golem's build. The value table copies no list of names: the types are the list.
 */
import type * as client from '../client.js';
import type * as mobx from '../mobx.js';
import type * as model from '../model.js';
import type * as serde from '../serde.js';
import type * as validation from '../validation.js';
import type * as validationRuntime from '../validation-runtime.js';
import type * as clientEntry from '../runtime-client.js';
import type * as clientValidationEntry from '../runtime-client-validation.js';
import type * as mobxEntry from '../runtime-mobx.js';
import type * as modelEntry from '../runtime-model.js';
import type * as temporalEntry from '../runtime-temporal.js';
import type * as validationEntry from '../runtime-validation.js';
import { runtimeCode, type Code } from './code.js';

/** The runtime keys of the emitters and the internal entry each one is imported from. Several keys share one entry. */
interface RuntimeExports {
  readonly client: typeof clientEntry;
  readonly conversion: typeof modelEntry;
  readonly mobx: typeof mobxEntry;
  readonly 'mobx-validation': typeof mobxEntry;
  readonly model: typeof modelEntry;
  readonly serde: typeof modelEntry;
  readonly temporal: typeof temporalEntry;
  readonly validation: typeof clientValidationEntry;
  readonly 'validation-runtime': typeof validationEntry;
}

export type RuntimeModule = keyof RuntimeExports;

/**
 * The type names that generated code may import, by runtime module. A type cannot be listed from a module's types, so
 * each name is written once here, and a name the module does not export is a type error.
 */
interface RuntimeTypeExports {
  readonly model: {
    readonly GeneratedModel: model.GeneratedModel;
    readonly GeneratedModelConstructor: model.GeneratedModelConstructor;
    readonly GeneratedModelWire: model.GeneratedModelWire<unknown>;
    readonly generatedModelFieldsBrand: typeof model.generatedModelFieldsBrand;
    readonly generatedModelResultBrand: typeof model.generatedModelResultBrand;
    readonly ModelInit: model.ModelInit<unknown>;
    readonly generatedModelWireBrand: typeof model.generatedModelWireBrand;
  };
  readonly client: {
    readonly ApiOperation: client.ApiOperation<never, never, never>;
    readonly OperationValidationSources: client.OperationValidationSources;
    readonly RuntimeResponseContract: client.RuntimeResponseContract;
    readonly RuntimeSecuritySchemes: client.RuntimeSecuritySchemes;
  };
  readonly validation: { readonly OperationRuntimeValidators: validation.OperationRuntimeValidators };
  readonly mobx: { readonly ObservableApiOperation: mobx.ObservableApiOperation<never, never, never> };
  readonly serde: { readonly SerdeOptions: serde.SerdeOptions; readonly ValidateOptions: serde.ValidateOptions };
  readonly 'validation-runtime': { readonly SchemaIssue: validationRuntime.SchemaIssue };
}

/** The specifier that a runtime key is imported from in a generated file. */
export const RUNTIME_SPECIFIER = {
  client: '@exprtlabs/golem/internal/client-runtime',
  conversion: '@exprtlabs/golem/internal/model-runtime',
  mobx: '@exprtlabs/golem/internal/mobx-runtime',
  'mobx-validation': '@exprtlabs/golem/internal/mobx-runtime',
  model: '@exprtlabs/golem/internal/model-runtime',
  serde: '@exprtlabs/golem/internal/model-runtime',
  temporal: '@exprtlabs/golem/internal/temporal-runtime',
  validation: '@exprtlabs/golem/internal/client-validation-runtime',
  'validation-runtime': '@exprtlabs/golem/internal/validation-runtime',
} as const satisfies Record<keyof RuntimeExports, string>;

/** The public subpath that a type name of a runtime key is imported from. */
export function runtimeTypeSpecifier(module: RuntimeModule): string {
  return `@exprtlabs/golem/${module}`;
}

export type RuntimeTypeTable = {
  readonly [M in keyof RuntimeTypeExports]: { readonly [N in keyof RuntimeTypeExports[M]]: Code };
};

export type RuntimeTable = {
  readonly [M in RuntimeModule]: { readonly [N in keyof RuntimeExports[M] & string]: Code };
};

/** The fixed order of the import lines of the runtime parts. A module added to `RuntimeExports` must be ranked here. */
export const RUNTIME_MODULE_RANK = {
  client: 0,
  conversion: 1,
  mobx: 2,
  'mobx-validation': 3,
  model: 4,
  serde: 5,
  temporal: 6,
  validation: 7,
  'validation-runtime': 8,
} as const satisfies Record<RuntimeModule, number>;

function moduleTable(module: RuntimeModule, typeOnly: boolean): object {
  const codes = new Map<string, Code>();
  return new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      let named = codes.get(name);
      if (!named) codes.set(name, named = runtimeCode(module, name, typeOnly));
      return named;
    },
  });
}

// The names of a module exist only as types, and loading the runtime modules here would load mobx on every run of the
// tooling. The cast is the one place where the table takes its type from them.
export const rt = Object.fromEntries(
  (Object.keys(RUNTIME_MODULE_RANK) as RuntimeModule[]).map((module) => [module, moduleTable(module, false)]),
) as unknown as RuntimeTable;

/** The type names, as Code with a type-only runtime part: `rtType['validation-runtime'].SchemaIssue`. */
export const rtType = Object.fromEntries(
  (Object.keys(RUNTIME_MODULE_RANK) as RuntimeModule[]).map((module) => [module, moduleTable(module, true)]),
) as unknown as RuntimeTypeTable;
