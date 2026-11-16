import type { ImportOptions } from '../code.js';

export interface CompileInput {
  /** Schemas to validate against, keyed by root name; the name is any string, including `#`. */
  readonly roots: ReadonlyMap<string, unknown>;
  /** Schemas reachable only through `$ref`, keyed by name (or by absolute URI); a schema's `$id` is also an address. */
  readonly resources?: ReadonlyMap<string, unknown>;
  /** User validation functions and classes the generated module imports, keyed by binding id or class id. */
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

/** The language of a generated module. */
export type Language = 'ts' | 'js';

export interface CompileOptions {
  /** What a format that golem does not implement does: warn and skip the check, or fail the compile. */
  readonly unknownFormats: 'warn' | 'error';
  /** Where the generated module imports its helpers and their types from; the internal validation runtime and the public subpath of the package by default. */
  readonly specifiers?: ImportOptions['specifiers'];
  /** Named in each diagnostic message that `locate` does not place. */
  readonly documentName?: string;
  /** Maps a schema resource and a JSON Pointer inside it to the place the user knows; without one, a diagnostic names the resource. */
  readonly locate?: (resource: string, pointer: string) => SchemaPlace | undefined;
  /** `ts` emits TypeScript, with a type on each header, each exported validator and each constant that needs one; `js` emits JavaScript. */
  readonly language: Language;
  /**
   * Also export `is_X(value)` beside `validate_X` for each root that has a fast check, or for each root of a set that
   * names it (`'all'` or a set of root names): true exactly when `validate_X` reports no issue, with no issue or path built.
   * Off when absent; the module is then as without the option.
   */
  readonly fastPath?: 'all' | ReadonlySet<string>;
  /**
   * `full` (the default) writes one module whose validators check everything, and skip the value limits (lengths, patterns,
   * ranges, formats other than `date-time`, `multipleOf`, counts, `uniqueItems`) and the validation functions when the
   * caller passes `true` as the third argument. `sanity` writes a module that checks the shape only (types, required and
   * extra keys, union tags, enums, a tuple's arity) and holds no code for a skipped check; it takes no flag. A diagnostic
   * (an unknown format, an invalid pattern) is reported at both levels. A validation context (`ModelValidationContext`)
   * is no part of this module: it runs its own checks at every level, so a model with one stays stricter than the shape.
   */
  readonly level?: 'full' | 'sanity';
  /**
   * The roots the module exports, by root name; every root by default. The other roots are still lowered, so their diagnostics are
   * reported, but the module holds no code that only they reach, and `exports` names the exported roots only.
   */
  readonly emitRoots?: ReadonlySet<string>;
}
