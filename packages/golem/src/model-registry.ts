/**
 * The metadata of generated models: the schema descriptors that tags carry, and the registry that maps a model class to
 * its conversion hooks. The registry is internal; generated code reaches it through `@exprtlabs/golem/internal/model-runtime`.
 */

import { MODEL_FIELDS_KEY } from './schema-keywords.js';
import type { GeneratedModel, GeneratedModelConstructor, ModelField } from './model.js';
import type { ModelValidator } from './validation.js';

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

/**
 * A function that generated code imports: the export `exportName` of `module` (a file of the project), or of the package at `specifier`.
 * A TSerde tag names two such functions, and a built-in class binds two of the golem runtime in the same shape.
 */
export interface ImportedFunction {
  /** The identity of the function: a path from the project root or a package import, and the export name. */
  readonly id: string;
  readonly module: string;
  readonly exportName: string;
  /** Package import specifier, set only when the function lives in another package. */
  readonly specifier?: string;
}

/** The serde of a descriptor: its identity and the two functions it names. */
export interface SerdeFunctions {
  readonly id: string;
  readonly serialize: ImportedFunction;
  readonly deserialize: ImportedFunction;
}

export interface ModelTypeMetadata {
  readonly validations?: readonly string[];
  readonly constraints?: readonly ModelConstraint[];
  /** The `serialize` and `deserialize` functions are in every descriptor that a generator makes; a hand-written descriptor in a test may leave them out. */
  readonly serde?: Pick<SerdeFunctions, 'id'> & Partial<SerdeFunctions> & {
    /** The wire form: `wire` in a generated descriptor, `wireDescriptor` in one a generator reads from source (a reader takes either). */
    readonly wire?: ModelTypeDescriptor;
    readonly wireDescriptor?: ModelTypeDescriptor;
    /** A function that tells whether an instance of the class holds a value, which the class check calls after `instanceof` (`new Date(NaN)` is a `Date` and holds none). */
    readonly valid?: ImportedFunction;
  };
  /**
   * The codec id of a golem-mode SDK schema that this descriptor holds inline. Conversion reads the descriptor; its schema is a reference
   * to the SDK's validators, so a model that holds the SDK type writes no second validator for it.
   */
  readonly sdkNode?: string;
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
  /**
   * A class instance or bigint converted only by its field's TSerde codec. `typeImport`
   * exists during generation only; generated descriptor data omits it.
   */
  | {
      readonly kind: 'class-value';
      readonly typeName: string;
      readonly typeImport?: { readonly exportName: string; readonly module: string; readonly specifier?: string };
      /**
       * Where the class has a runtime value that a check can test with `instanceof`; a type with no runtime class (an interface)
       * has none. `path` names the class below the value that `id` imports, or below `globalThis` when there is no `id`.
       * `id` is the stable identity of the imported class (the project path or package import with the export name).
       */
      readonly classRef?: { readonly id?: string; readonly path: readonly string[] };
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

export interface GeneratedModelConversion<Model extends object = object, Wire = unknown> {
  /** Decode a wire value, constructing the requested subclass when supplied. */
  readonly decode: (value: unknown, constructor?: GeneratedModelConstructor) => Model;
}

/**
 * Optional runtime enhancement supplied by an extension of a generator package.
 * The validation type is imported type-only, so no validation or extension runtime
 * is loaded by the dependency-free model entrypoint.
 */
export type GeneratedModelValidatorEnhancer = <Fields extends object, Owner extends object = Fields>(
  validator: ModelValidator<Fields, Owner>,
) => ModelValidator<Fields, Owner>;

/**
 * The validation level a generated model registers as the default of its calls: `true` checks everything, `'sanity'` the
 * shape only, `false` is off. A call may choose any level up to the project's.
 */
type GeneratedModelValidation = boolean | 'sanity';

export interface GeneratedModelDefinition<Model extends object, Wire = unknown> {
  readonly fields: readonly ModelField<Model>[];
  /** Raw synchronous conversion hooks are internal metadata, not class APIs. */
  readonly conversion?: GeneratedModelConversion<Model, Wire>;
  /** Validation availability and default level are independent from the conversion hooks. */
  readonly profile?: { readonly validation: GeneratedModelValidation };
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
  readonly profile?: { readonly validation: GeneratedModelValidation };
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
