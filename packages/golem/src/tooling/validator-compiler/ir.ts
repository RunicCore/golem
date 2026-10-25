/** Type names a JSON Schema `type` keyword can test; `Date` is golem's own node (`IrDate`) and has no `type` name. */
export type IrTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';

/** `type`: the value must be one of the named types. */
export interface IrType {
  readonly kind: 'type';
  readonly names: readonly IrTypeName[];
}

/** `const` and `enum`: the value must equal one of `values` (JSON Schema equality). */
interface IrLiteral {
  readonly kind: 'literal';
  readonly values: readonly unknown[];
}

/** `format` for a format the runtime checks. */
interface IrFormat {
  readonly kind: 'format';
  readonly format: string;
}

/** String keywords; they apply to strings only. Lengths count code points. */
export interface IrString {
  readonly kind: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A source already known to compile as `new RegExp(source, 'u')`. */
  readonly pattern?: string;
}

/** Number keywords; they apply to numbers only. */
export interface IrNumber {
  readonly kind: 'number';
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

/** `contains` with its counts: the number of items that pass `fn` must lie between the two limits. */
export interface IrContains {
  /** The function every item is tried against; its issues are not reported. */
  readonly fn: number;
  /** 1 when `minContains` is absent; 0 makes `contains` pass without a match. */
  readonly min: number;
  readonly max?: number;
}

/**
 * Array keywords; they apply to arrays only. When the compilation uses `unevaluatedItems`, the check is kept
 * even if no keyword in it can fail, because `prefixItems`, `items` and `contains` mark the items they evaluate.
 */
export interface IrArray {
  readonly kind: 'array';
  readonly prefixItems: readonly IrSchema[];
  /** Applies to the items after `prefixItems`. */
  readonly items?: IrSchema;
  /** No item may follow `prefixItems`: `items: false`. One `tooBig` issue says so, with `limit` the prefix length. */
  readonly closed: boolean;
  readonly contains?: IrContains;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems: boolean;
}

interface IrProperty {
  readonly key: string;
  readonly schema: IrSchema;
}

/** What `additionalProperties` does with a key that `properties` does not name. */
export type IrAdditional =
  | { readonly kind: 'forbid' }
  | { readonly kind: 'schema'; readonly schema: IrSchema };

/** A `patternProperties` entry; a key that matches `pattern` must pass `schema`. */
export interface IrPatternProperty {
  /** A source already known to compile as `new RegExp(source, 'u')`. */
  readonly pattern: string;
  readonly schema: IrSchema;
}

/** `dependentRequired`: when `trigger` is present, every key in `keys` must be too. */
interface IrDependentRequired {
  readonly trigger: string;
  readonly keys: readonly string[];
}

/**
 * Object keywords; they apply to plain objects only. When the compilation uses `unevaluatedProperties`, the check
 * is kept even if no keyword in it can fail, because `properties`, `patternProperties` and `additionalProperties`
 * mark the keys they evaluate.
 */
export interface IrObject {
  readonly kind: 'object';
  readonly required: readonly string[];
  readonly dependentRequired: readonly IrDependentRequired[];
  readonly properties: readonly IrProperty[];
  readonly patternProperties: readonly IrPatternProperty[];
  readonly additional?: IrAdditional;
  /** A function that every key, read as a string, must pass; a failing key is one `invalidKey` issue. */
  readonly propertyNames?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

/** A reference: the value must pass the shared function `fn`; its issues are reported as they are. */
interface IrCall {
  readonly kind: 'call';
  readonly fn: number;
}

/** `allOf`: every branch applies to the value; the issues of all failing branches are reported. */
interface IrAllOf {
  readonly kind: 'allOf';
  readonly branches: readonly IrSchema[];
}

/** A `oneOf` whose branches each state their tag values: the tag selects the one branch to run. */
export interface IrDiscriminator {
  /** The property that holds the tag. */
  readonly property: string;
  /** The tag values of each branch, in branch order; no value belongs to two branches. */
  readonly tags: readonly (readonly unknown[])[];
}

/**
 * `anyOf` and `oneOf`: one `union` issue says how many branches matched. With a discriminator only the selected
 * branch runs and reports its own issues, and an unknown tag is a `literal` issue on the tag property.
 */
export interface IrUnion {
  readonly kind: 'union';
  readonly exactlyOne: boolean;
  /** Function ids; without a discriminator a branch is run only to learn whether it matches. */
  readonly branches: readonly number[];
  readonly discriminator?: IrDiscriminator;
}

/** `if`, `then` and `else`: `then` or `else` applies, by whether `if` passes; the issues of `if` are not reported. */
interface IrConditional {
  readonly kind: 'conditional';
  readonly if: number;
  readonly then?: number;
  readonly else?: number;
}

/** `dependentSchemas`: when `trigger` is present, the whole object must pass `fn`. */
interface IrDependentSchemas {
  readonly kind: 'dependentSchemas';
  readonly entries: readonly { readonly trigger: string; readonly fn: number }[];
}

/** `unevaluatedProperties`: each key no applicator evaluated must pass `schema` (`never` for `false`). Runs after every other check. */
interface IrUnevaluatedProperties {
  readonly kind: 'unevaluatedProperties';
  readonly schema: IrSchema;
}

/** `unevaluatedItems`: each item no applicator evaluated must pass `schema`; `never` gives one `tooBig` issue. Runs after every other check. */
interface IrUnevaluatedItems {
  readonly kind: 'unevaluatedItems';
  readonly schema: IrSchema;
}

/** `not`: the function `fn` must not match. */
interface IrNot {
  readonly kind: 'not';
  readonly fn: number;
}

/** `golemModelDate`: the value must be a `Date` that holds a valid time. */
interface IrDate {
  readonly kind: 'date';
}

/**
 * `golemModelInstance`: of the model classes `among`, the one the value's encoder selects is the most derived one
 * the value is an instance of. It must be `of`: always when `required`, otherwise when there is one. Without `of`,
 * the value must be an instance of none of them. A failure is one `instance` issue naming `of`, or the first of `among`.
 * `of` and `among` are the names the issue shows; `ofId` and `amongIds` are the codec ids a registered class matches exactly.
 */
export interface IrInstance {
  readonly kind: 'instance';
  readonly of?: string;
  readonly ofId?: string;
  readonly among: readonly string[];
  readonly amongIds: readonly string[];
  readonly required: boolean;
}

/** A user validation function the generated module imports. */
export interface IrValidationImport {
  readonly importPath: string;
  readonly exportName: string;
}

/**
 * `exprtValidation`: when the structural schema `fn` passes (or when there is none), each function in `calls` runs in
 * order on the value. An index in `calls` points into `IrModule.validations`. A function returns `true`, `false`, or a
 * string that is the reason it failed; any other result throws a `TypeError`.
 */
export interface IrValidation {
  readonly kind: 'validation';
  readonly fn?: number;
  readonly calls: readonly number[];
}

export type IrCheck =
  | IrType | IrLiteral | IrFormat | IrString | IrNumber | IrArray | IrObject | IrCall | IrAllOf | IrUnion | IrNot
  | IrConditional | IrDependentSchemas | IrDate | IrInstance | IrValidation | IrUnevaluatedProperties | IrUnevaluatedItems;

/** A lowered schema: the `true` schema, the `false` schema, or the checks that apply in order. */
export type IrSchema =
  | { readonly kind: 'always' }
  | { readonly kind: 'never' }
  | { readonly kind: 'checks'; readonly checks: readonly IrCheck[] };

/**
 * A schema that something refers to: a root, a `$ref` target, a branch, or a schema that needs a record of its own.
 *
 * Evaluation record: `unevaluatedProperties` and `unevaluatedItems` need to know which keys and items the schema's
 * other keywords, and the schemas that apply to the same value in place, evaluated. A function that holds either
 * keyword `collects`: it keeps a record. A function that a collector reaches through in-place steps `receives`: it
 * is handed the record and fills it. A function can do both.
 */
export interface IrFunction {
  readonly id: number;
  /** What the schema is called, for stack traces and profiles: a root's name, or the last pointer segment of a `$ref` target. Absent for an inline schema and for a whole resource. */
  readonly name?: string;
  readonly body: IrSchema;
  readonly collects: boolean;
  readonly receives: boolean;
}

interface IrExport {
  /** The root name, verbatim. */
  readonly name: string;
  readonly fn: number;
}

export interface IrModule {
  readonly functions: readonly IrFunction[];
  /** The user validation functions the module imports, each once. */
  readonly validations: readonly IrValidationImport[];
  readonly exports: readonly IrExport[];
}
