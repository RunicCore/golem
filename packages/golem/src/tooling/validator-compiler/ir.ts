/** Type names a JSON Schema `type` keyword can test; `Date` is golem's own node and has no keyword. */
export type IrTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';

/** `type`: the value must be one of the named types. */
export interface IrType {
  readonly kind: 'type';
  readonly names: readonly IrTypeName[];
}

/** `const` and `enum`: the value must equal one of `values` (JSON Schema equality). */
export interface IrLiteral {
  readonly kind: 'literal';
  readonly values: readonly unknown[];
}

/** `format` for a format the runtime checks. */
export interface IrFormat {
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

/** Array keywords; they apply to arrays only. */
export interface IrArray {
  readonly kind: 'array';
  readonly prefixItems: readonly IrSchema[];
  /** Applies to the items after `prefixItems`. */
  readonly items?: IrSchema;
  /** No item may follow `prefixItems`: `items: false`. One `tooBig` issue says so, with `limit` the prefix length. */
  readonly closed: boolean;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems: boolean;
}

export interface IrProperty {
  readonly key: string;
  readonly schema: IrSchema;
}

/** What `additionalProperties` does with a key that `properties` does not name. */
export type IrAdditional =
  | { readonly kind: 'forbid' }
  | { readonly kind: 'schema'; readonly schema: IrSchema };

/** Object keywords; they apply to plain objects only. */
export interface IrObject {
  readonly kind: 'object';
  readonly required: readonly string[];
  readonly properties: readonly IrProperty[];
  readonly additional?: IrAdditional;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

/** A reference: the value must pass the shared function `fn`; its issues are reported as they are. */
export interface IrCall {
  readonly kind: 'call';
  readonly fn: number;
}

/** `allOf`: every branch applies to the value; the issues of all failing branches are reported. */
export interface IrAllOf {
  readonly kind: 'allOf';
  readonly branches: readonly IrSchema[];
}

/** `anyOf` and `oneOf` without a discriminator: one `union` issue says how many branches matched. */
export interface IrUnion {
  readonly kind: 'union';
  readonly exactlyOne: boolean;
  /** Function ids; a branch is run only to learn whether it matches. */
  readonly branches: readonly number[];
}

/** `not`: the function `fn` must not match. */
export interface IrNot {
  readonly kind: 'not';
  readonly fn: number;
}

export type IrCheck = IrType | IrLiteral | IrFormat | IrString | IrNumber | IrArray | IrObject | IrCall | IrAllOf | IrUnion | IrNot;

/** A lowered schema: the `true` schema, the `false` schema, or the checks that apply in order. */
export type IrSchema =
  | { readonly kind: 'always' }
  | { readonly kind: 'never' }
  | { readonly kind: 'checks'; readonly checks: readonly IrCheck[] };

/** A schema that something refers to: a root, a `$ref` target, or a union or `not` branch. */
export interface IrFunction {
  readonly id: number;
  readonly body: IrSchema;
}

export interface IrExport {
  /** The root name, verbatim. */
  readonly name: string;
  readonly fn: number;
}

export interface IrModule {
  readonly functions: readonly IrFunction[];
  readonly exports: readonly IrExport[];
}
