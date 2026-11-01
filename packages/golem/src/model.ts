/**
 * Dependency-free model contracts.
 *
 * This module is intentionally safe to import from browser bundles that do
 * not load an extension runtime.
 */

import type { TSerdeWire } from './tags.js';
import type { Validator } from './validation-runtime.js';

export interface IModelOptions {
  /** Reject additional properties. Defaults to true. */
  readonly exact?: boolean;
  readonly allowAny?: boolean;
  /**
   * Override the generation profile `validation` level (`true`, `'sanity'` or
   * `false`) for this named interned declaration. `undefined` inherits the
   * profile. A model may lower the level of its project, never raise it. A nested
   * model is checked at the level of the call that reaches it; only `false` (no
   * validators) belongs to the nested model. Inline objects are not declarations.
   */
  readonly validation?: boolean | 'sanity';
}

/** A field declaration analyzed by the model generator. */
export type IObject<
  Fields extends object,
  Options extends IModelOptions = {},
> = Fields;

/** IObject plus a generated class. Nested IObject/IModel nodes share one emit. */
export type IModel<
  Fields extends object,
  Options extends IModelOptions = {},
> = IObject<Fields, Options>;


/** Constructor values may contain existing nested models or nested initializers. */
export type ModelInit<Value> = Value extends Date ? Date
  : Value extends readonly (infer Item)[]
    // An array type is an interface, so a type that holds itself through an array ends. A tuple keeps its shape.
    ? PlainArray<Value, Item> extends true
      ? (Value extends unknown[] ? InitArray<Item> : InitReadonlyArray<Item>)
      : { [Index in keyof Value]: ModelInit<Value[Index]> }
  : Value extends object ? Value | { [Key in ModelField<Value>]?: ModelInit<Value[Key]> }
  : Value;

/** Whether an array type is `Item[]` itself and not a tuple. */
type PlainArray<Value, Item> = Value extends unknown[] ? ([Item[]] extends [Value] ? true : false) : ([readonly Item[]] extends [Value] ? true : false);

interface InitArray<Item> extends Array<ModelInit<Item>> {}
interface InitReadonlyArray<Item> extends ReadonlyArray<ModelInit<Item>> {}


/**
 * A type-only brand ties a generated model to the wire type emitted by its
 * conversion metadata.  The property is declared rather than assigned so it
 * never appears in a runtime model instance or serialized value.
 */
export declare const generatedModelWireBrand: unique symbol;

/**
 * A type-only brand for the authored fields of a generated model.  This is
 * deliberately declared rather than assigned: generated instances must keep
 * their field surface free of runtime metadata and serializer state.
 */
export declare const generatedModelFieldsBrand: unique symbol;

/**
 * A type-only constructor brand lets abstract discriminator models describe
 * the concrete union returned by `deserialize`.
 */
export declare const generatedModelResultBrand: unique symbol;

export interface GeneratedModel<
  Wire = unknown,
  Fields extends object = object,
> {
  readonly [generatedModelWireBrand]: Wire;
  readonly [generatedModelFieldsBrand]: Fields;
}

export type GeneratedModelWire<Model> = Model extends GeneratedModel<infer Wire> ? Wire : unknown;

/**
 * The plain wire value `toWireFormat<Value>` returns. A generated model or SDK
 * model yields its emitted JSON type. Other values map structurally, as the
 * model generator emits JSON types: `Date` becomes `string`, a `TSerde` field
 * becomes its deserializer's input, constraint tags are dropped, and arrays,
 * tuples, objects and unions map element-wise.
 */
export type WireFormat<Value> = 0 extends 1 & Value ? any
  : Value extends GeneratedModel<infer Wire> ? Wire
  : TSerdeWire<Value> extends [infer Wire] ? WireFormat<Wire>
  : Value extends Date ? string
  : Value extends string ? HasBrand<Value, string> extends true ? Value : WireString<Value>
  : Value extends number ? HasBrand<Value, number> extends true ? Value : number extends Value ? number : Value
  : Value extends bigint ? HasBrand<Value, bigint> extends true ? Value : bigint extends Value ? bigint : Value
  : Value extends boolean ? Value extends true ? true : false
  : Value extends null | undefined ? Value
  : Value extends (...arguments_: never[]) => unknown ? Value
  : Value extends readonly unknown[] ? WireArray<Value>
  : Value extends object ? { [Key in keyof Value as Key extends symbol ? never : Key]: WireFormat<Value[Key]> }
  : Value;

/** A string-keyed phantom member (`string & { __brand?: never }`) is kept on the wire, as the generator does. */
type HasBrand<Value, Primitive> = [Exclude<keyof Value, keyof Primitive | symbol>] extends [never] ? false : true;

/**
 * Tagged `string`, template literal and string-mapping types are `string` on
 * the wire; plain literals stay literal. A tagged literal (`'a' & Tag`) keeps
 * its tag: TypeScript cannot remove an object member from a literal
 * intersection, and the tagged literal remains mutually assignable with it.
 */
type WireString<Value extends string> = string extends Value ? string
  : [Exclude<keyof Value, keyof string>] extends [never]
    ? {} extends Record<Value, 1> ? string : Value
    : Value;

/** Arrays (including tagged arrays) map their item; tuples, including variadic ones, map each position. */
type WireArray<Value extends readonly unknown[]> = Value extends readonly (infer Item)[]
  ? Item[] extends Value
    ? Value extends unknown[] ? WireFormat<Item>[] : readonly WireFormat<Item>[]
    : { [Index in keyof Value]: WireFormat<Value[Index]> }
  : never;

export type GeneratedModelConstructor =
  abstract new (...arguments_: never[]) => object;

export type GeneratedModelResult<Constructor extends GeneratedModelConstructor> =
  Constructor extends new (...arguments_: never[]) => infer Model
    ? Model
    : Constructor extends { readonly [generatedModelResultBrand]: infer Result }
      ? Result
      : InstanceType<Constructor>;

export type ModelField<Model extends object> = {
  [Field in keyof Model]-?: Field extends string
    ? Field extends `$${string}`
      ? never
      : Model[Field] extends (...arguments_: infer _Arguments) => unknown
        ? never
        : Field
    : never;
}[keyof Model];

/** Supplies the validators a call uses instead of the generated ones. */
export interface ModelValidationContext {
  /**
   * The validator for `reference`: `Id`, `Id#wire`, `Id#model-only` or `Id#wire-only`, the reference names the plane.
   * A missing reference fails within this context and never falls back to the generated validator.
   */
  readonly resolve: (reference: string, mode: 'first' | 'all') => Validator | undefined;
}

