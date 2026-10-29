import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-core.js';
import { emit, exportNames, type PassExports } from './emit.js';
import { lower } from './lower.js';

export { TEMPORAL_FORMAT_CLASSES } from './converted-formats.js';

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
  /** Where the generated module imports its helpers from; the internal validation runtime of the package by default. */
  readonly runtimeModule?: string;
  /** Named in each diagnostic message that `locate` does not place. */
  readonly documentName?: string;
  /** Maps a schema resource and a JSON Pointer inside it to the place the user knows; without one, a diagnostic names the resource. */
  readonly locate?: (resource: string, pointer: string) => SchemaPlace | undefined;
  /** Emit TypeScript: each exported validator carries its type. */
  readonly typed?: boolean;
  /**
   * Also export `is_X(value)` beside `validate_X` for each root that has a fast check, or for each root of a set that
   * names it: true exactly when `validate_X` reports no issue, with no issue or path built. Off by default; with it off
   * the module is as without the option.
   */
  readonly fastPath?: boolean | ReadonlySet<string>;
  /**
   * `full` (the default) writes one module whose validators check everything, and skip the value limits (lengths, patterns,
   * ranges, formats that no converter reads, `multipleOf`, counts, `uniqueItems`) and the validation functions when the
   * caller passes `true` as the third argument. `sanity` writes a module that checks the shape only (types, required and
   * extra keys, union tags, enums, a tuple's arity) and holds no code for a skipped check; it takes no flag. A diagnostic
   * (an unknown format, an invalid pattern) is reported at both levels. A validation context (`ModelValidationContext`)
   * is no part of this module: it runs its own checks at every level, so a model with one stays stricter than the shape.
   */
  readonly level?: 'full' | 'sanity';
}

export interface CompileResult {
  /**
   * An ES module with one named export, a function, for each root (see `exports`), and with `fastPath` one more for each
   * root that has a fast check (see `fastExports`); empty when any diagnostic is an error.
   */
  readonly source: string;
  /** The name each root's validator is exported under, by root name. The names depend on the roots' own names only, and exist when the source is empty. */
  readonly exports: ReadonlyMap<string, string>;
  /**
   * The name each root's fast check is exported under, by root name, with `fastPath`. A root has none when its schema
   * reaches a validation function, keeps an evaluation record, or has no check with a fast form; empty when the source is.
   */
  readonly fastExports: ReadonlyMap<string, string>;
  /**
   * With `fastPath`, for each root whose every path to a validation function is conjunctive (a reference, an array item,
   * a declared property, `allOf`) and whose structure has a fast check: `structure`, a check `(value) => boolean` that
   * holds no validation function and is true when the structure is valid, and `predicates`, a function
   * `(value, all) => issues` that runs each validation function once and reports, for a value whose structure is valid,
   * the issues of `validate_X` in the same order. A root with a predicate under a union, `not`, `if`,
   * `dependentSchemas`, `contains`, `propertyNames`, a pattern, `additionalProperties` or `unevaluated*` has none.
   */
  readonly passExports: ReadonlyMap<string, PassExports>;
  readonly diagnostics: readonly GolemDiagnostic[];
}

/** Compiles JSON Schema 2020-12 roots to a module that exports one validator function per root. */
export function compile(input: CompileInput, options: CompileOptions): CompileResult {
  const { module, diagnostics } = lower(input, options);
  const exports = exportNames(input.roots.keys());
  if (diagnostics.some(entry => entry.severity === GolemDiagnosticSeverity.Error)) return { source: '', exports, fastExports: new Map(), passExports: new Map(), diagnostics };
  const { source, fastExports, passExports } = emit(module, {
    ...(options.runtimeModule === undefined ? {} : { runtimeModule: options.runtimeModule }),
    ...(options.typed ? { typed: true } : {}),
    ...(options.fastPath === undefined || options.fastPath === false ? {} : { fastPath: options.fastPath }),
    ...(options.level === undefined ? {} : { level: options.level }),
  });
  return { source, exports, fastExports, passExports, diagnostics };
}
