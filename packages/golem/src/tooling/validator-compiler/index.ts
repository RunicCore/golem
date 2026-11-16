import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-core.js';
import { emit, exportNames, type PassExports } from './emit.js';
import { lower } from './lower.js';
import type { CompileInput, CompileOptions } from './options.js';

export type { CompileOptions } from './options.js';

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
  const { module: lowered, diagnostics } = lower(input, options);
  const { emitRoots } = options;
  const module = emitRoots === undefined ? lowered : { ...lowered, exports: lowered.exports.filter(({ name }) => emitRoots.has(name)) };
  const exports = new Map([...exportNames(module.exports.map(({ name }) => name))].map(([root, names]) => [root, names.validate] as const));
  if (diagnostics.some(entry => entry.severity === GolemDiagnosticSeverity.Error)) return { source: '', exports, fastExports: new Map(), passExports: new Map(), diagnostics };
  const { source, fastExports, passExports } = emit(module, {
    ...(options.specifiers === undefined ? {} : { specifiers: options.specifiers }),
    language: options.language ?? 'js',
    ...(options.fastPath === undefined ? {} : { fastPath: options.fastPath }),
    ...(options.level === undefined ? {} : { level: options.level }),
  });
  return { source, exports, fastExports, passExports, diagnostics };
}
