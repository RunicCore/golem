/**
 * Type-only model annotations.
 *
 * Every tag is an object with an optional, unique-symbol property.  The
 * property is deliberately optional so an annotated value remains assignable
 * to its underlying model value (for example, `string & MinLength<3>` is still
 * a string to consumers).  The symbols are declared rather than initialized;
 * using these types never adds a runtime dependency or executes application
 * code.
 */

declare const validationTag: unique symbol;
declare const serdeTag: unique symbol;
declare const integerTag: unique symbol;
declare const minimumTag: unique symbol;
declare const maximumTag: unique symbol;
declare const exclusiveMinimumTag: unique symbol;
declare const exclusiveMaximumTag: unique symbol;
declare const multipleOfTag: unique symbol;
declare const minLengthTag: unique symbol;
declare const maxLengthTag: unique symbol;
declare const patternTag: unique symbol;
declare const formatTag: unique symbol;
declare const minItemsTag: unique symbol;
declare const maxItemsTag: unique symbol;
declare const uniqueItemsTag: unique symbol;
declare const minPropertiesTag: unique symbol;
declare const maxPropertiesTag: unique symbol;
declare const containsTag: unique symbol;
declare const minContainsTag: unique symbol;
declare const maxContainsTag: unique symbol;
declare const propertyNamesTag: unique symbol;
declare const patternPropertiesTag: unique symbol;
declare const additionalPropertiesTag: unique symbol;
declare const unevaluatedPropertiesTag: unique symbol;
declare const dependentRequiredTag: unique symbol;
declare const dependentSchemasTag: unique symbol;
declare const oneOfTag: unique symbol;
declare const notTag: unique symbol;
declare const ifThenElseTag: unique symbol;

type SyncValidationResult = boolean | string;

/** A model-value predicate.  Promises are intentionally not accepted. */
export type ModelValidationFunction = (value: unknown) => SyncValidationResult;

/**
 * Attach one application predicate to a field or model type.
 *
 * The marker is optional and carries no value at runtime.  Code generation
 * resolves `typeof predicate` from the TypeScript AST and emits a deferred
 * binding; it never invokes the predicate while compiling.
 */
export type TValidation<
  Predicate extends (...arguments_: never[]) => SyncValidationResult,
> = {
  readonly [validationTag]?: Predicate;
};

export type ModelSerializeFunction = (value: unknown) => unknown;
export type ModelDeserializeFunction = (value: unknown) => unknown;

/** Attach synchronous model-to-wire and wire-to-model converters. */
export type TSerde<
  Serialize extends (...arguments_: never[]) => unknown,
  Deserialize extends (...arguments_: never[]) => unknown,
> = {
  readonly [serdeTag]?: {
    readonly serialize: Serialize;
    readonly deserialize: Deserialize;
  };
};

/**
 * The wire type declared by a `TSerde` tag, wrapped as `[Wire]`, or `[]` when
 * `Value` carries no `TSerde`. Like the model generator, the wire type is the
 * deserializer's input; a deserializer without a parameter accepts `unknown`.
 */
export type TSerdeWire<Value> = [Value] extends [{ readonly [serdeTag]?: infer Binding }]
  ? NonNullable<Binding> extends { readonly deserialize: (wire: infer Wire, ...rest: never[]) => unknown }
    ? [Wire]
    : []
  : [];

/** A JSON number that must be an integer. */
export type Integer = { readonly [integerTag]?: never };

/** Inclusive lower and upper numeric bounds. */
export type Minimum<Value extends number> = { readonly [minimumTag]?: Value };
export type Maximum<Value extends number> = { readonly [maximumTag]?: Value };

/** Exclusive lower and upper numeric bounds. */
export type ExclusiveMinimum<Value extends number> = { readonly [exclusiveMinimumTag]?: Value };
export type ExclusiveMaximum<Value extends number> = { readonly [exclusiveMaximumTag]?: Value };

/** Require a number to be an exact multiple of the supplied value. */
export type MultipleOf<Value extends number> = { readonly [multipleOfTag]?: Value };

/** String length, regular-expression, and named-format constraints. */
export type MinLength<Value extends number> = { readonly [minLengthTag]?: Value };
export type MaxLength<Value extends number> = { readonly [maxLengthTag]?: Value };
export type Pattern<Value extends string> = { readonly [patternTag]?: Value };
export type Format<Value extends string> = { readonly [formatTag]?: Value };

/** Array length and uniqueness constraints. */
export type MinItems<Value extends number> = { readonly [minItemsTag]?: Value };
export type MaxItems<Value extends number> = { readonly [maxItemsTag]?: Value };
export type UniqueItems = { readonly [uniqueItemsTag]?: never };

/** Object property-count constraints. */
export type MinProperties<Value extends number> = { readonly [minPropertiesTag]?: Value };
export type MaxProperties<Value extends number> = { readonly [maxPropertiesTag]?: Value };

/** Array containment and item constraints. */
export type Contains<Value> = { readonly [containsTag]?: Value };
export type MinContains<Value extends number> = { readonly [minContainsTag]?: Value };
export type MaxContains<Value extends number> = { readonly [maxContainsTag]?: Value };

/** Object property evaluation constraints. */
export type PropertyNames<Value> = { readonly [propertyNamesTag]?: Value };
export type PatternProperties<Patterns extends object> = { readonly [patternPropertiesTag]?: Patterns };
export type AdditionalProperties<Value> = { readonly [additionalPropertiesTag]?: Value };
export type UnevaluatedProperties<Value> = { readonly [unevaluatedPropertiesTag]?: Value };
export type DependentRequired<Dependencies extends object> = { readonly [dependentRequiredTag]?: Dependencies };
export type DependentSchemas<Dependencies extends object> = { readonly [dependentSchemasTag]?: Dependencies };

/** Schema-composition constraints. */
export type OneOf<Values> = { readonly [oneOfTag]?: Values };
export type Not<Value> = { readonly [notTag]?: Value };
export type IfThenElse<Condition, Then, Else = undefined> = {
  readonly [ifThenElseTag]?: { readonly if: Condition; readonly then: Then; readonly else?: Else };
};

/* Short aliases are useful when a domain's vocabulary already says min/max. */
export type Min<Value extends number> = Minimum<Value>;
export type Max<Value extends number> = Maximum<Value>;
export type ExclusiveMin<Value extends number> = ExclusiveMinimum<Value>;
export type ExclusiveMax<Value extends number> = ExclusiveMaximum<Value>;

export type MinProps<Value extends number> = MinProperties<Value>;
export type MaxProps<Value extends number> = MaxProperties<Value>;

/** Built-in tags are compiler-recognized and have no runtime constructors. */
export type BuiltinModelTag =
  | Integer
  | Minimum<number>
  | Maximum<number>
  | ExclusiveMinimum<number>
  | ExclusiveMaximum<number>
  | MultipleOf<number>
  | MinLength<number>
  | MaxLength<number>
  | Pattern<string>
  | Format<string>
  | MinItems<number>
  | MaxItems<number>
  | UniqueItems
  | MinProperties<number>
  | MaxProperties<number>
  | Contains<unknown>
  | MinContains<number>
  | MaxContains<number>
  | PropertyNames<unknown>
  | PatternProperties<object>
  | AdditionalProperties<unknown>
  | UnevaluatedProperties<unknown>
  | DependentRequired<object>
  | DependentSchemas<object>
  | OneOf<unknown>
  | Not<unknown>
  | IfThenElse<unknown, unknown, unknown>;
