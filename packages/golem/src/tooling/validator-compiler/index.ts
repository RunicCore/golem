import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-api.js';
import { emit } from './emit.js';
import { lower } from './lower.js';

export interface CompileInput {
  /** Schemas to validate against, keyed by root name; the name is any string, including `#`. */
  readonly roots: ReadonlyMap<string, unknown>;
  /** Schemas reachable only through `$ref`, keyed by name (or by absolute URI); a schema's `$id` is also an address. */
  readonly resources?: ReadonlyMap<string, unknown>;
  /** User validation functions the generated module imports, keyed by binding name. */
  readonly validations?: ReadonlyMap<string, { readonly importPath: string; readonly exportName: string }>;
}

export interface CompileOptions {
  /** What a format that golem does not implement does: warn and skip the check, or fail the compile. */
  readonly unknownFormats: 'warn' | 'error';
  /** Where the generated module imports its helpers from; the package's validation runtime by default. */
  readonly runtimeModule?: string;
  /** Named in every diagnostic message. */
  readonly documentName?: string;
}

export interface CompileResult {
  /** An ES module with one named export, `validators`; empty when any diagnostic is an error. */
  readonly source: string;
  readonly diagnostics: readonly GolemDiagnostic[];
}

const DEFAULT_RUNTIME_MODULE = '@exprtlabs/golem/validation-runtime';

/** Compiles JSON Schema 2020-12 roots to a module of validators, one per root. */
export function compile(input: CompileInput, options: CompileOptions): CompileResult {
  const { module, diagnostics } = lower(input, options);
  if (diagnostics.some(entry => entry.severity === GolemDiagnosticSeverity.Error)) return { source: '', diagnostics };
  return { source: emit(module, { runtimeModule: options.runtimeModule ?? DEFAULT_RUNTIME_MODULE }), diagnostics };
}
