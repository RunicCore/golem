import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-api.js';
import { emit, exportNames } from './emit.js';
import { lower } from './lower.js';

export interface CompileInput {
  /** Schemas to validate against, keyed by root name; the name is any string, including `#`. */
  readonly roots: ReadonlyMap<string, unknown>;
  /** Schemas reachable only through `$ref`, keyed by name (or by absolute URI); a schema's `$id` is also an address. */
  readonly resources?: ReadonlyMap<string, unknown>;
  /** User validation functions the generated module imports, keyed by binding name. */
  readonly validations?: ReadonlyMap<string, { readonly importPath: string; readonly exportName: string }>;
}

/** Where a schema diagnostic belongs in the user's own document, instead of in a schema the compiler built. */
export interface SchemaPlace {
  /** Names the place in the diagnostic message. */
  readonly where: string;
  /** The real file of the place, when there is one. */
  readonly file?: string;
  /** The place as a JSON Pointer into the document, when there is one. */
  readonly path?: string;
}

export interface CompileOptions {
  /** What a format that golem does not implement does: warn and skip the check, or fail the compile. */
  readonly unknownFormats: 'warn' | 'error';
  /** Where the generated module imports its helpers from; the package's validation runtime by default. */
  readonly runtimeModule?: string;
  /** Named in each diagnostic message that `locate` does not place. */
  readonly documentName?: string;
  /** Maps a schema resource and a JSON Pointer inside it to the place the user knows; without one, a diagnostic names the resource. */
  readonly locate?: (resource: string, pointer: string) => SchemaPlace | undefined;
  /** Emit TypeScript: each exported validator carries its type. */
  readonly typed?: boolean;
  /**
   * Also export `is_X(value)` beside `validate_X` for each root that has a fast check: true exactly when `validate_X`
   * reports no issue, with no issue or path built. Off by default; with it off the module is as without the option.
   */
  readonly fastPath?: boolean;
}

export interface CompileResult {
  /** An ES module with one named export, a function, for each root (see `exports`); empty when any diagnostic is an error. */
  readonly source: string;
  /** The name each root's validator is exported under, by root name. The names depend on the roots' own names only, and exist when the source is empty. */
  readonly exports: ReadonlyMap<string, string>;
  /**
   * The name each root's fast check is exported under, by root name, with `fastPath`. A root has none when its schema
   * reaches a validation function, keeps an evaluation record, or has no check with a fast form; empty when the source is.
   */
  readonly fastExports: ReadonlyMap<string, string>;
  readonly diagnostics: readonly GolemDiagnostic[];
}

const DEFAULT_RUNTIME_MODULE = '@exprtlabs/golem/validation-runtime';

/** Compiles JSON Schema 2020-12 roots to a module that exports one validator function per root. */
export function compile(input: CompileInput, options: CompileOptions): CompileResult {
  const { module, diagnostics } = lower(input, options);
  const exports = exportNames(input.roots.keys());
  if (diagnostics.some(entry => entry.severity === GolemDiagnosticSeverity.Error)) return { source: '', exports, fastExports: new Map(), diagnostics };
  const { source, fastExports } = emit(module, {
    runtimeModule: options.runtimeModule ?? DEFAULT_RUNTIME_MODULE,
    ...(options.typed ? { typed: true } : {}),
    ...(options.fastPath ? { fastPath: true } : {}),
  });
  return { source, exports, fastExports, diagnostics };
}
