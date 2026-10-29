/**
 * Dependency-free model contracts and generated-model metadata registry.
 *
 * This module is intentionally safe to import from browser bundles that do
 * not install MobX. Optional runtime integrations register
 * themselves through the interfaces below.
 */

import { MODEL_FIELDS_KEY } from './schema-keywords.js';
import type { TSerdeWire } from './tags.js';
import type { ModelValidator } from './validation.js';
import type { Validator } from './validation-runtime.js';

export interface IModelOptions {
  /** Reject additional properties. Defaults to true. */
  readonly exact?: boolean;
  readonly allowAny?: boolean;
  /**
   * Override the generation profile `validation` flag for this named interned
   * declaration. `undefined` inherits the profile. Nested interned IObject/IModel
   * nodes use their own option; inline objects are not declarations.
   */
  readonly validation?: boolean;
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

/** A nested schema carried by a type tag.  Model descriptors are objects. */
export type ConstraintSchemaValue = boolean | object;

/**
 * Structural constraints understood by the model tag analyser.
 *
 * `schema` values are model descriptors (or JSON Schema boolean schemas),
 * while the map forms retain their JSON Schema keyword shape.  Keeping the
 * keyword payload structural means generated metadata remains JSON data and
 * never embeds executable predicate functions.
 */
export type ModelConstraint =
  | { readonly kind: 'integer' | 'uniqueItems' }
  | {
    readonly kind:
      | 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum' | 'multipleOf'
      | 'minLength' | 'maxLength' | 'minItems' | 'maxItems'
      | 'minProperties' | 'maxProperties' | 'minContains' | 'maxContains';
    readonly value: number;
  }
  | { readonly kind: 'pattern' | 'format'; readonly value: string }
  /** The JSON values a value may equal, compared deeply. The values are data, not descriptors. */
  | { readonly kind: 'enum'; readonly values: readonly unknown[] }
  | {
    readonly kind:
      | 'contains' | 'propertyNames' | 'additionalProperties' | 'unevaluatedProperties'
      | 'items' | 'unevaluatedItems' | 'not';
    readonly schema: ConstraintSchemaValue;
  }
  | { readonly kind: 'patternProperties'; readonly pattern: string; readonly schema: ConstraintSchemaValue }
  | { readonly kind: 'dependentRequired'; readonly value: Readonly<Record<string, readonly string[]>> }
  | { readonly kind: 'dependentSchemas'; readonly value: Readonly<Record<string, ConstraintSchemaValue>> }
  | { readonly kind: 'oneOf' | 'allOf'; readonly schemas: readonly ConstraintSchemaValue[] }
  | {
    readonly kind: 'ifThenElse';
    readonly if: ConstraintSchemaValue;
    readonly then?: ConstraintSchemaValue;
    readonly else?: ConstraintSchemaValue;
  };

export interface ModelTypeMetadata {
  readonly validations?: readonly string[];
  readonly constraints?: readonly ModelConstraint[];
  readonly serde?: { readonly id: string; readonly wire: ModelTypeDescriptor };
}

export type DiscriminatorValue = string | number | boolean;

/**
 * Selects a union variant by the value of one property. `variants[i]` holds
 * the tag values of the union's `variants[i]`; value sets are disjoint. A
 * variant's own descriptor keeps its declared tag type.
 */
export interface UnionDiscriminator {
  readonly propertyName: string;
  readonly variants: readonly { readonly values: readonly DiscriminatorValue[] }[];
  /**
   * The index in `variants` of the declared default: the variant a value takes when its tag selects no other variant
   * (OpenAPI `discriminator.defaultMapping`). It has no tag values and may lack the tag property.
   */
  readonly defaultVariant?: number;
}

export type ModelTypeDescriptor = ModelTypeMetadata & (
  | { readonly kind: 'any' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'never' }
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'bigint' }
  | { readonly kind: 'null' }
  | { readonly kind: 'undefined' }
  | { readonly kind: 'date' }
  /**
   * A class instance or bigint converted only by its field's TSerde codec. `typeImport`
   * exists during generation only; generated descriptor data omits it.
   */
  | {
      readonly kind: 'class-value';
      readonly typeName: string;
      readonly typeImport?: { readonly exportName: string; readonly module: string; readonly specifier?: string };
    }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'array'; readonly isReadonly?: true; readonly item: ModelTypeDescriptor }
  | {
      readonly kind: 'tuple';
      readonly isReadonly?: true;
      readonly items: readonly ModelTypeDescriptor[];
      readonly optionalFrom?: number;
      readonly rest?: {
        readonly index: number;
        readonly item: ModelTypeDescriptor;
      };
    }
  | {
      readonly kind: 'object';
      /** A mapped field is a fresh plain object containing only selected keys. */
      readonly projection?: true;
      readonly readonlyProperties?: readonly string[];
      readonly properties: Readonly<Record<string, ModelTypeDescriptor>>;
      readonly required: readonly string[];
      readonly additionalProperties: boolean | ModelTypeDescriptor;
      /**
       * The schema or an `AdditionalProperties` tag states the extra keys: the object declares them as data, so JSON
       * writers keep them. With an object `additionalProperties`, the generated type has no index signature. An object
       * that is open only by default declares none, and writers keep its declared fields only.
       */
      readonly additionalPropertiesDeclared?: true;
    }
  | {
      readonly kind: 'union';
      readonly variants: readonly ModelTypeDescriptor[];
      /** Explicit tag table; without it, conversion infers required literal tags. */
      readonly discriminator?: UnionDiscriminator;
    }
  | { readonly kind: 'intersection'; readonly variants: readonly ModelTypeDescriptor[] }
  | { readonly kind: 'reference'; readonly name: string; readonly projection?: true; readonly construct?: true; readonly className?: string }
  | { readonly kind: 'generated-model'; readonly id: string });

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

export interface GeneratedModelConversion<Model extends object = object, Wire = unknown> {
  /** Decode a wire value, constructing the requested subclass when supplied. */
  readonly decode: (value: unknown, constructor?: GeneratedModelConstructor) => Model;
}

export interface GeneratedModelProfile {
  readonly validation: boolean;
}

/**
 * Optional runtime enhancement supplied by an integration such as MobX.
 * The validation type is imported type-only, so no validation or MobX runtime
 * is loaded by the dependency-free model entrypoint.
 */
export type GeneratedModelValidatorEnhancer = <Fields extends object, Owner extends object = Fields>(
  validator: ModelValidator<Fields, Owner>,
) => ModelValidator<Fields, Owner>;

export interface GeneratedModelDefinition<Model extends object, Wire = unknown> {
  readonly fields: readonly ModelField<Model>[];
  /** Raw synchronous conversion hooks are internal metadata, not class APIs. */
  readonly conversion?: GeneratedModelConversion<Model, Wire>;
  /** Validation availability is independent from the conversion hooks. */
  readonly profile?: GeneratedModelProfile;
  /** ObjectCodec id used by `validate(instance)` when the companion registered one. */
  readonly codecId?: string;
  /** Whether unlisted own keys are part of this model's dynamic map. */
  readonly additionalProperties?: boolean;
  /** Optional integration hook applied when a stateful validator is created. */
  readonly enhanceValidator?: GeneratedModelValidatorEnhancer;
}

/** Internal metadata shape shared by the optional runtime integrations. */
export interface RegisteredGeneratedModelDefinition {
  readonly constructor: Function;
  readonly fields: readonly string[];
  readonly conversion?: GeneratedModelConversion<object, unknown>;
  readonly profile?: GeneratedModelProfile;
  readonly codecId?: string;
  readonly additionalProperties?: boolean;
  readonly enhanceValidator?: GeneratedModelValidatorEnhancer;
}

const generatedModelMarker = Symbol('exprtlabs.generatedModel');
const generatedModelDefinition = Symbol('exprtlabs.generatedModelDefinition');

export function registerGeneratedModel<Model extends object, Wire = unknown>(
  constructor: abstract new (...arguments_: never[]) => Model,
  definition: GeneratedModelDefinition<Model, Wire>,
): void {
  const conversion = definition.conversion;
  const registered: RegisteredGeneratedModelDefinition = {
    constructor,
    fields: definition.fields,
    conversion: conversion
      ? {
        decode: (value, requestedConstructor) => conversion.decode(value, requestedConstructor),
      }
      : undefined,
    profile: definition.profile,
    codecId: definition.codecId,
    additionalProperties: definition.additionalProperties,
    enhanceValidator: definition.enhanceValidator,
  };
  // The same descriptor is attached to the constructor and its prototype.
  // Normal property inheritance then makes handwritten subclasses resolve the
  // nearest generated contract without a constructor-chain registry walk.
  const prototype = constructor.prototype;
  const fieldsKey = Symbol.for(MODEL_FIELDS_KEY);
  const targets = [
    [constructor, generatedModelDefinition],
    [prototype, generatedModelDefinition],
    [prototype, generatedModelMarker],
    [prototype, fieldsKey],
  ] as const;
  for (const [target, key] of targets) {
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (current ? current.configurable !== true : !Object.isExtensible(target)) {
      throw new TypeError('Generated model metadata cannot replace a non-configurable or frozen property.');
    }
  }
  const previous = targets.map(([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)] as const);
  try {
    Object.defineProperty(constructor, generatedModelDefinition, {
      value: registered,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(prototype, generatedModelDefinition, {
      value: registered,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(prototype, generatedModelMarker, {
      value: conversion !== undefined,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    // The declared names, so a key outside them is program state of an instance (`isInstanceState`); a model that
    // allows additional keys has none.
    Object.defineProperty(prototype, fieldsKey, {
      value: definition.additionalProperties ? null : Object.freeze([...registered.fields]),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch (error) {
    for (const [target, key, descriptor] of previous.reverse()) {
      try {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      } catch {
        // The preflight above protects ordinary targets.  A proxy can still
        // reject a rollback; preserve the original failure in that case.
      }
    }
    throw error;
  }
}

export function findGeneratedModelDefinitionForConstructor(
  constructor: Function,
): RegisteredGeneratedModelDefinition | undefined {
  return readGeneratedModelDefinition(constructor);
}

export function findGeneratedModelDefinition(
  model: object,
): RegisteredGeneratedModelDefinition | undefined {
  // Resolve from the actual prototype chain, which the property read walks.  A
  // handwritten own `constructor` field must never be able to redirect an
  // instance to another contract.  A caller may pass the generated prototype itself.
  return readGeneratedModelDefinition(model);
}

function readGeneratedModelDefinition(value: unknown): RegisteredGeneratedModelDefinition | undefined {
  if ((typeof value !== 'function' && (value === null || typeof value !== 'object'))) return undefined;
  const definition: unknown = Reflect.get(value, generatedModelDefinition);
  return definition !== null && typeof definition === 'object'
    ? definition as RegisteredGeneratedModelDefinition
    : undefined;
}

/** Recognizes a registered model class, including its concrete subclasses. */
export function isGeneratedModelConstructor(value: unknown): value is GeneratedModelConstructor {
  return typeof value === 'function' && hasModelMarker(value.prototype);
}

function hasModelMarker(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && generatedModelMarker in value && value[generatedModelMarker] === true;
}

/** Recognizes a generated model instance without exposing its conversion metadata. */
export function isGeneratedModel(value: unknown): value is GeneratedModel<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return hasModelMarker(prototype);
}
