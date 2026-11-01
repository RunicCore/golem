/**
 * The runtime exports that generated code may name. A value comes from an internal runtime entry that generated files import
 * from, and a type from the public subpath of its module, because applications see the types in their declaration files.
 * `rt.serde.parseJson` is a Code that holds a runtime part. A name that an entry or a module does not export is a type
 * error, so a misspelled or removed export fails golem's build. The value table copies no list of names: the types are the list.
 */
import type * as client from '../client.js';
import type * as model from '../model.js';
import type * as serde from '../serde.js';
import type * as validation from '../validation.js';
import type * as clientEntry from '../runtime-client.js';
import type * as clientValidationEntry from '../runtime-client-validation.js';
import type * as modelEntry from '../runtime-model.js';
import type * as temporalEntry from '../runtime-temporal.js';
import type * as validationEntry from '../runtime-validation.js';
import type { ImportedFunction } from '../model-registry.js';
import { runtimeCode, type Code } from './code.js';

/** The runtime keys of the emitters and the internal entry each one is imported from. Several keys share one entry. */
interface RuntimeExports {
  readonly client: typeof clientEntry;
  readonly conversion: typeof modelEntry;
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
    readonly OperationCodecs: client.OperationCodecs;
    readonly RequestOptions: client.RequestOptions;
    readonly RuntimeResponseContract: client.RuntimeResponseContract;
    readonly RuntimeSecuritySchemes: client.RuntimeSecuritySchemes;
  };
  readonly validation: { readonly OperationRuntimeValidators: validation.OperationRuntimeValidators; readonly SchemaIssue: validation.SchemaIssue };
  readonly serde: { readonly SerdeOptions: serde.SerdeOptions; readonly ValidateOptions: serde.ValidateOptions };
}

/** The specifier that a runtime key is imported from in a generated file. */
export const RUNTIME_SPECIFIER = {
  client: '@exprtlabs/golem/internal/client-runtime',
  conversion: '@exprtlabs/golem/internal/model-runtime',
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

/**
 * The specifiers of a file that takes every runtime value from one module and every runtime type from another, as a standalone
 * SDK does from its copy of the runtime (`ImportOptions.specifiers`).
 */
export function copiedRuntimeSpecifiers(values: string, types: string): { readonly values: Readonly<Record<RuntimeModule, string>>; readonly types: Readonly<Record<RuntimeModule, string>> } {
  const modules = Object.keys(RUNTIME_SPECIFIER) as RuntimeModule[];
  const all = (specifier: string): Record<RuntimeModule, string> => Object.fromEntries(modules.map((module) => [module, specifier])) as Record<RuntimeModule, string>;
  return { values: all(values), types: all(types) };
}

export type RuntimeTypeTable = {
  readonly [M in keyof RuntimeTypeExports]: { readonly [N in keyof RuntimeTypeExports[M]]: Code };
};

export type RuntimeTable = {
  readonly [M in RuntimeModule]: { readonly [N in keyof RuntimeExports[M] & string]: Code };
};

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
  (Object.keys(RUNTIME_SPECIFIER) as RuntimeModule[]).map((module) => [module, moduleTable(module, false)]),
) as unknown as RuntimeTable;

/** The type names, as Code with a type-only runtime part: `rtType.validation.SchemaIssue`. */
export const rtType = Object.fromEntries(
  (Object.keys(RUNTIME_SPECIFIER) as RuntimeModule[]).map((module) => [module, moduleTable(module, true)]),
) as unknown as RuntimeTypeTable;

/** A function of a runtime module in the shape of the function a TSerde tag names: a binding of the runtime and a binding of the project are the same kind of value. */
export function runtimeFunction<M extends RuntimeModule>(module: M, name: keyof RuntimeTable[M] & string): ImportedFunction {
  const specifier = RUNTIME_SPECIFIER[module];
  return { id: `${specifier}#${name}`, module: specifier, exportName: name, specifier };
}

const MODULE_OF_SPECIFIER: ReadonlyMap<string, RuntimeModule> = new Map(
  (Object.keys(RUNTIME_SPECIFIER) as RuntimeModule[]).reverse().map((module) => [RUNTIME_SPECIFIER[module], module]),
);

/** Whether `value`, read from schema data, is the binding of a function of the runtime (see `runtimeFunction`). */
export function isRuntimeFunction(value: unknown): value is ImportedFunction {
  if (typeof value !== 'object' || value === null) return false;
  const { id, module, exportName, specifier } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof module === 'string' && typeof exportName === 'string' && typeof specifier === 'string' && MODULE_OF_SPECIFIER.has(specifier);
}

/** The Code of a function that a binding takes from the runtime: the runtime part of the module whose entry the binding's specifier is, so a standalone SDK imports it from its copied runtime. */
export function runtimeFunctionCode(binding: ImportedFunction): Code {
  const module = binding.specifier === undefined ? undefined : MODULE_OF_SPECIFIER.get(binding.specifier);
  if (module === undefined) throw new Error(`The function ${JSON.stringify(binding.id)} is not a function of the golem runtime.`);
  return runtimeCode(module, binding.exportName);
}
