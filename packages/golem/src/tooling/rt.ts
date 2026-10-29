/**
 * The runtime exports that generated code may name, typed from the internal runtime entries that generated files import
 * from. `rt.serde.parseJson` is a Code that holds a runtime part. A name that an entry does not export is a type error, so
 * a misspelled or removed export fails golem's build. The table copies no list of names: the types are the list.
 */
import type * as clientRuntime from '../runtime-client.js';
import type * as mobxRuntime from '../runtime-mobx.js';
import type * as modelRuntime from '../runtime-model.js';
import type * as validationRuntime from '../runtime-validation.js';
import { runtimeCode, type Code } from './code.js';

/** The runtime keys of the emitters and the internal entry each one is imported from. Several keys share one entry. */
interface RuntimeExports {
  readonly client: typeof clientRuntime;
  readonly conversion: typeof modelRuntime;
  readonly mobx: typeof mobxRuntime;
  readonly 'mobx-validation': typeof mobxRuntime;
  readonly model: typeof modelRuntime;
  readonly serde: typeof modelRuntime;
  readonly temporal: typeof modelRuntime;
  readonly validation: typeof clientRuntime;
  readonly 'validation-runtime': typeof validationRuntime;
}

export type RuntimeModule = keyof RuntimeExports;

/**
 * The type names that generated code may import, by runtime module. A type cannot be listed from a module's types, so
 * each name is written once here, and a name the module does not export is a type error.
 */
interface RuntimeTypeExports {
  readonly model: {
    readonly GeneratedModel: modelRuntime.GeneratedModel;
    readonly GeneratedModelConstructor: modelRuntime.GeneratedModelConstructor;
    readonly GeneratedModelWire: modelRuntime.GeneratedModelWire<unknown>;
    readonly generatedModelFieldsBrand: typeof modelRuntime.generatedModelFieldsBrand;
    readonly generatedModelResultBrand: typeof modelRuntime.generatedModelResultBrand;
    readonly ModelInit: modelRuntime.ModelInit<unknown>;
    readonly generatedModelWireBrand: typeof modelRuntime.generatedModelWireBrand;
  };
  readonly client: {
    readonly ApiOperation: clientRuntime.ApiOperation<never, never, never>;
    readonly OperationValidationSources: clientRuntime.OperationValidationSources;
    readonly RuntimeResponseContract: clientRuntime.RuntimeResponseContract;
    readonly RuntimeSecuritySchemes: clientRuntime.RuntimeSecuritySchemes;
  };
  readonly validation: { readonly OperationRuntimeValidators: clientRuntime.OperationRuntimeValidators };
  readonly mobx: { readonly ObservableApiOperation: mobxRuntime.ObservableApiOperation<never, never, never> };
  readonly serde: { readonly SerdeOptions: modelRuntime.SerdeOptions; readonly ValidateOptions: modelRuntime.ValidateOptions };
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
  temporal: '@exprtlabs/golem/internal/model-runtime',
  validation: '@exprtlabs/golem/internal/client-runtime',
  'validation-runtime': '@exprtlabs/golem/internal/validation-runtime',
} as const satisfies Record<keyof RuntimeExports, string>;

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
