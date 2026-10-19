import type { DiscriminatorValue, ModelTypeDescriptor } from '@exprtlabs/golem/model';
export {
  emitCodecRegistration,
  emitCodecRuntime,
  emitGraphStringify,
  emitParseFunction,
  emitStringifyFunction,
  fillFunctionName,
  fromWireFunctionName,
  parseFunctionName,
  stringifyFunctionName,
  wireStringifyExportName,
  toWireFunctionName,
  validateFunctionName,
  type CodecRuntimeOptions,
  type NestedImportedSerde,
  type StringifySerdeResolver,
} from './stringify-emitter.js';
export { presentKeysSource, presentValueSource } from '../presence.js';
export { pruneGeneratedImports } from './generated-imports.js';
export { FIELD_CONVERSION_INPUT, singleCallConverter, type TupleConversionDescriptor } from './sequence-conversion.js';
/** The allOf object merge, for generators that read schemas (golem-openapi). */
export {
  composeObjects,
  CompositionConflictError,
  conversionKey,
  descriptorSlotRule,
  isRejected,
  type ModelBases,
  type ObjectExtra,
  type ObjectPart,
  type ObjectResult,
  type Rejected,
  type SlotRule,
} from './composition.js';
import { presentKeysSource, presentValueSource } from '../presence.js';
import { CompositionConflictError, requireComposedObject, type ModelBases } from './composition.js';
import { FIELD_CONVERSION_INPUT, emitArrayConversion, emitTupleConversion, singleCallConverter, type SequenceItems } from './sequence-conversion.js';
import {
  AMBIGUOUS_UNION_CONVERSION_ERROR,
  OBJECT_UNION_DISCRIMINATOR_ERROR,
  discriminatorMatch,
  emitScalarOrArrayConversion,
  emitSequenceBranch,
  literalDiscriminator,
  objectDiscriminator,
  objectValueExpression,
  objectVariant,
  presentUnionVariants,
  scalarBranchVariant,
  scalarOrArray,
  emitDispatch,
  presentUnionIndices,
  unionDispatch,
  type ObjectTypeDescriptor,
  type VariantDispatch,
} from './union-conversion.js';

/** Generators read tag values through the same rule as the shared union conversion. */
export { descriptorNeedsConversion, literalValues } from './union-conversion.js';

export type ModelConversionDescriptor = ModelTypeDescriptor;

/** The local that a projection decoder reads the field at `index` into. */
const projectionLocal = (index: number): string => `__golemProjected${index}`;

/** A model's required tag properties and their literal value or values. */
export type ModelDiscriminators = Readonly<Record<string, DiscriminatorValue | readonly DiscriminatorValue[]>>;

export interface FromJsonModelResolver {
  readonly className: string;
  readonly discriminators?: ModelDiscriminators;
  /** The model that this model extends, so a derived model narrows its base where both judge one property. */
  readonly base?: string;
  /** Internal generated-model wire decoder expression. */
  readonly decode: (value: string) => string;
  /** Construct a domain model from a nested model initializer. */
  readonly fromInit?: (value: string) => string;
}

export interface ToJsonModelResolver {
  readonly className: string;
  readonly discriminators?: ModelDiscriminators;
  /** The model that this model extends, so a derived model narrows its base where both judge one property. */
  readonly base?: string;
  /** Internal generated-model wire encoder expression. */
  readonly encode?: (value: string) => string;
}

/**
 * Resolve a compiler-emitted serde pair to a call expression.  The model
 * compiler owns the import and lazy wrapper; this emitter only decides where
 * the wrapper is applied in a nested conversion tree.
 */
export interface SerdeResolver {
  readonly deserialize: (id: string, value: string) => string;
  readonly serialize: (id: string, value: string) => string;
}

type DescriptorMetadata = {
  readonly serde?: { readonly id: string };
  readonly date?: true;
};

function metadata(descriptor: ModelConversionDescriptor): DescriptorMetadata {
  return descriptor as ModelConversionDescriptor & DescriptorMetadata;
}

type GeneratedModelDescriptor = Extract<
  ModelConversionDescriptor,
  { readonly kind: 'generated-model' }
>;
type ObjectDescriptor = ObjectTypeDescriptor;

function generatedModel(
  descriptor: ModelConversionDescriptor,
): GeneratedModelDescriptor | undefined {
  if (descriptor.kind === 'generated-model') return descriptor;
  if (descriptor.kind !== 'union') return undefined;

  const generated = descriptor.variants.filter(
    (variant): variant is GeneratedModelDescriptor => variant.kind === 'generated-model',
  );
  if (generated.length !== 1) return undefined;

  const alternatives = descriptor.variants.filter(
    (variant) => variant.kind !== 'generated-model',
  );
  // `unknown`, `any`, arrays, intersections, and a second object branch can
  // all accept the same runtime value as a generated model.  The model
  // compiler rejects these ambiguous unions before emission.  A tagged
  // object alternative is safe because the generated branch is selected only
  // when its tag does not match.
  const objectAlternatives = alternatives.filter(
    (variant): variant is ObjectDescriptor => variant.kind === 'object',
  );
  if (alternatives.some((variant) =>
    variant.kind === 'any'
      || variant.kind === 'unknown'
      || variant.kind === 'array'
      || variant.kind === 'intersection'
  )) return undefined;
  if (objectAlternatives.length > 0 && !objectDiscriminator(objectAlternatives)) {
    return undefined;
  }
  return generated[0];
}

/** A tag property present on every branch with disjoint values, from per-branch tag records. */
function inferredBranchDispatch(branches: readonly ModelDiscriminators[]): VariantDispatch | undefined {
  const valueSets = (tags: ModelDiscriminators, property: string): readonly DiscriminatorValue[] => {
    const value = tags[property];
    return value === undefined ? [] : typeof value === 'object' ? value : [value];
  };
  for (const property of Object.keys(branches[0] ?? {})) {
    const values = branches.map(tags => Object.hasOwn(tags, property) ? valueSets(tags, property) : []);
    const flat = values.flat();
    if (values.every(set => set.length > 0) && new Set(flat).size === flat.length) return { property, values };
  }
  return undefined;
}

function recordExpression(expression: string): string {
  return expression === 'data' || expression === 'source' ? expression : `(${expression} as Record<string, unknown>)`;
}

function recordIndex(expression: string, property: string): string {
  return `${recordExpression(expression)}[${property}]`;
}

/** A decoder's tag read by the JSON view, so an inherited or non-enumerable tag selects no branch. */
function presentTag(expression: string, property: string): string {
  const key = JSON.stringify(property);
  return `(${presentValueSource(expression, key, recordIndex(expression, key))})`;
}

function taggedObjectExpression(
  expression: string,
  alternatives: readonly ObjectDescriptor[],
): string {
  const discriminator = objectDiscriminator(alternatives);
  if (!discriminator) return objectValueExpression(expression);
  const access = presentTag(expression, discriminator.property);
  return `${objectValueExpression(expression)} && ${discriminatorMatch(access, discriminator.values.flat())}`;
}

function unionGeneratedFromJson(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
): string | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  const objects = descriptor.variants.filter(
    (variant): variant is ObjectDescriptor => variant.kind === 'object',
  );
  const model = resolveModel(generated.id);
  const converted = `${expression} instanceof ${model.className} ? ${expression} : ${model.decode(expression)}`;
  if (objects.length === 0) {
    return `${objectValueExpression(expression)} ? ${converted} : ${expression}`;
  }
  const tagged = taggedObjectExpression(expression, objects);
  return `${objectValueExpression(expression)} && !(${tagged}) ? ${converted} : ${expression}`;
}

function unionGeneratedFromInit(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
): string | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  const objects = descriptor.variants.filter(
    (variant): variant is ObjectDescriptor => variant.kind === 'object',
  );
  const model = resolveModel(generated.id);
  const fromInit = model.fromInit ?? ((value: string) => `new ${model.className}(${value})`);
  const converted = `${expression} instanceof ${model.className} ? ${expression} : ${fromInit(expression)}`;
  if (objects.length === 0) return `${objectValueExpression(expression)} ? ${converted} : ${expression}`;
  const tagged = taggedObjectExpression(expression, objects);
  return `${objectValueExpression(expression)} && !(${tagged}) ? ${converted} : ${expression}`;
}

function unionGeneratedToJson(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  resolveModel: (id: string) => ToJsonModelResolver,
): string | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  const model = resolveModel(generated.id);
  const encode = model.encode ?? ((value: string) => `encodeGeneratedModel(${value})`);
  return `${expression} instanceof ${model.className} ? ${encode(expression)} : ${expression}`;
}

/**
 * A converted value at a nested field. `emit(FIELD_CONVERSION_INPUT)` shows the conversion's shape: a single call
 * passes its function and the value to `convertModelField`; any other conversion becomes a value-taking arrow,
 * so no conversion captures the enclosing loop.
 */
function atField(emit: (value: string) => string, input: string, field: string, direction: 'fromJSON' | 'toJSON' | 'fromInit'): string {
  if (direction === 'fromInit') return emit(input);
  const converted = emit(FIELD_CONVERSION_INPUT);
  if (converted === FIELD_CONVERSION_INPUT) return input;
  const convert = singleCallConverter(converted) ?? `(${FIELD_CONVERSION_INPUT}: unknown) => (${converted})`;
  return `convertModelField(${JSON.stringify(direction === 'toJSON' ? 'serialize' : 'deserialize')}, ${field}, ${convert}, ${input})`;
}

/** The item conversion of a tuple or an array in the model family: `fromInit` has no error paths, the other directions have. */
function sequenceItems(
  direction: 'fromJSON' | 'toJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver | ToJsonModelResolver,
  resolveSerde?: SerdeResolver,
): SequenceItems {
  return {
    output: 'value',
    ...(direction === 'fromInit' ? {} : { paths: direction === 'toJSON' ? 'serialize' as const : 'deserialize' as const }),
    item: (item, value) => {
      const code = emitNested(item, value, direction, resolveModel, resolveSerde);
      return { code, throws: code !== value };
    },
  };
}

function emitNested(
  descriptor: ModelConversionDescriptor,
  expression: string,
  direction: 'fromJSON' | 'toJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver | ToJsonModelResolver,
  resolveSerde?: SerdeResolver,
): string {
  const tags = metadata(descriptor);
  if (tags.serde && resolveSerde) {
    return direction === 'fromJSON'
      ? resolveSerde.deserialize(tags.serde.id, expression)
      : direction === 'toJSON'
        ? resolveSerde.serialize(tags.serde.id, expression)
        : expression;
  }
  if (descriptor.kind === 'date' || tags.date) {
    return direction === 'fromJSON'
      ? `deserializeDate(${expression})`
      : direction === 'toJSON'
        ? `serializeDate(${expression})`
        : expression;
  }
  if (descriptor.kind === 'intersection') {
    const bases: ModelBases = { baseOf: (id) => resolveModel(id).base };
    const merged = descriptor.variants.every(variant => !metadata(variant).serde) ? requireComposedObject(descriptor.variants, bases) : undefined;
    if (merged) return emitNested(merged, expression, direction, resolveModel, resolveSerde);
    // A scalar intersection converts by its one converting part.
    const conversions = [...new Set(descriptor.variants
      .map(variant => emitNested(variant, expression, direction, resolveModel, resolveSerde))
      .filter(converted => converted !== expression))];
    if (conversions.length > 1) throw new CompositionConflictError('two parts convert it differently');
    return conversions[0] ?? expression;
  }
  if (descriptor.kind === 'union') {
    const present = presentUnionVariants(descriptor);
    if (present.length === 1 && present.length !== descriptor.variants.length) {
      const converted = emitNested(present[0], expression, direction, resolveModel, resolveSerde);
      return converted === expression ? expression : `${expression} == null ? ${expression} : (${converted})`;
    }
    const scalarOrArrayUnion = scalarOrArray(present);
    if (scalarOrArrayUnion) {
      const { sequence, scalars } = scalarOrArrayUnion;
      const scalarVariant = scalarBranchVariant(scalars);
      const scalar = scalarVariant ? emitNested(scalarVariant, expression, direction, resolveModel, resolveSerde) : expression;
      const mapped = emitSequenceBranch(sequence, expression, sequenceItems(direction, resolveModel, resolveSerde));
      return emitScalarOrArrayConversion(expression, mapped, scalar);
    }
    const indices = presentUnionIndices(descriptor);
    const dispatchDirection = direction === 'toJSON' ? 'encode-value' : 'decode';
    const modelBranches = present.filter(variant => variant.kind === 'reference' || variant.kind === 'generated-model');
    if (modelBranches.length > 0 && present.every(variant =>
      variant.kind === 'reference' || variant.kind === 'generated-model' || variant.kind === 'object')) {
      const dispatch = descriptor.discriminator
        ? unionDispatch(descriptor, indices, objectVariant)
        : inferredBranchDispatch(present.map(variant => variant.kind === 'reference'
          ? resolveModel(variant.name).discriminators ?? {}
          : variant.kind === 'generated-model'
            ? resolveModel(variant.id).discriminators ?? {}
            : variant.kind === 'object' ? Object.fromEntries(literalDiscriminator(variant)) : {}));
      if (dispatch) {
        return emitDispatch({
          expression,
          property: dispatch.property,
          direction: dispatchDirection,
          canonicalTag: descriptor.discriminator !== undefined,
          branches: present.map((variant, position) => ({
            values: dispatch.values[position],
            className: variant.kind === 'generated-model' ? resolveModel(variant.id).className
              : variant.kind === 'reference' && !variant.projection ? resolveModel(variant.name).className
                : undefined,
            convert: emitNested(variant, expression, direction, resolveModel, resolveSerde),
          })),
        });
      }
    }
    const fromJsonResolver = (id: string): FromJsonModelResolver => {
      const model = resolveModel(id);
      if (!('decode' in model)) throw new Error(`Missing decode resolver for generated model ${id}.`);
      return model;
    };
    const toJsonResolver = (id: string): ToJsonModelResolver => {
      return resolveModel(id);
    };
    const result = direction === 'fromJSON'
      ? unionGeneratedFromJson(
        descriptor,
        expression,
        fromJsonResolver,
      )
      : direction === 'fromInit'
        ? unionGeneratedFromInit(
          descriptor,
          expression,
          fromJsonResolver,
        )
        : unionGeneratedToJson(
        descriptor,
        expression,
        toJsonResolver,
      );
    const objectIndices = indices.filter(index => descriptor.variants[index].kind === 'object');
    const objects = objectIndices.map(index => descriptor.variants[index]).filter(
      (variant): variant is ObjectDescriptor => variant.kind === 'object');
    const convertedObjects = objects.map(object => ({ object, converted: emitNested(object, expression, direction, resolveModel, resolveSerde) }));
    if (convertedObjects.some(({ converted }) => converted !== expression)) {
      const discriminator = unionDispatch(descriptor, objectIndices, objectVariant);
      if (!discriminator && (objects.length > 1 || descriptor.variants.some(variant => ['reference', 'generated-model', 'any', 'unknown', 'intersection'].includes(variant.kind)))) {
        throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
      }
      if (discriminator && result === undefined && objects.length === present.length) {
        return emitDispatch({
          expression,
          property: discriminator.property,
          direction: dispatchDirection,
          canonicalTag: descriptor.discriminator !== undefined,
          branches: convertedObjects.map(({ converted }, position) => ({ values: discriminator.values[position], convert: converted })),
        });
      }
      let converted = result ?? expression;
      for (let index = convertedObjects.length - 1; index >= 0; index--) {
        const guard = discriminator
          ? `${objectValueExpression(expression)} && ${discriminatorMatch(presentTag(expression, discriminator.property), discriminator.values[index])}`
          : objectValueExpression(expression);
        converted = `${guard} ? (${convertedObjects[index].converted}) : (${converted})`;
      }
      return converted;
    }
    if (result !== undefined) return result;
    // Conversion must not probe alternatives by executing application codecs.
    // Structurally ambiguous branches need an explicit discriminator or codec.
    const conversions = descriptor.variants.map(variant => emitNested(variant, expression, direction, resolveModel, resolveSerde));
    if (conversions.some(converted => converted !== expression)) {
      const objectsOrReferences = descriptor.variants.filter(variant => variant.kind === 'object' || variant.kind === 'reference' || variant.kind === 'generated-model');
      if (objectsOrReferences.length === 1 && descriptor.variants.every(variant => objectsOrReferences.some(candidate => candidate === variant) || ['null', 'undefined', 'string', 'number', 'boolean', 'bigint', 'literal'].includes(variant.kind))) {
        const converted = emitNested(objectsOrReferences[0], expression, direction, resolveModel, resolveSerde);
        return `${objectValueExpression(expression)} ? (${converted}) : ${expression}`;
      }
      throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
    }
  }
  if (descriptor.kind === 'generated-model') {
    const model = resolveModel(descriptor.id);
    if (direction === 'fromJSON' || direction === 'fromInit') {
      const fromJson = model;
      if (!('decode' in fromJson)) throw new Error(`Missing decode resolver for generated model ${descriptor.id}.`);
      const convert = direction === 'fromInit'
        ? fromJson.fromInit ?? ((value: string) => `new ${fromJson.className}(${value})`)
        : fromJson.decode;
      return `${expression} == null || ${expression} instanceof ${fromJson.className} ? ${expression} : ${convert(expression)}`;
    }
    const toJson = model;
    const encode = ('encode' in toJson && toJson.encode)
      ? toJson.encode
      : (value: string) => `encodeGeneratedModel(${value})`;
    return `${expression} instanceof ${toJson.className} ? ${encode(expression)} : ${expression}`;
  }
  if (descriptor.kind === 'reference') {
    const model = resolveModel(descriptor.name);
    if (descriptor.projection) {
      if (direction === 'toJSON') return 'encode' in model ? model.encode?.(expression) ?? expression : expression;
      if (!('decode' in model)) throw new Error(`Missing projected conversion for ${descriptor.name}.`);
      return direction === 'fromInit' ? (model.fromInit ?? model.decode)(expression) : model.decode(expression);
    }
    if (direction === 'fromJSON' || direction === 'fromInit') {
      const fromJson = model;
      if (!('decode' in fromJson)) throw new Error(`Missing decode resolver for generated model ${descriptor.name}.`);
      const convert = direction === 'fromInit'
        ? fromJson.fromInit ?? ((value: string) => `new ${fromJson.className}(${value})`)
        : fromJson.decode;
      return `${expression} == null || ${expression} instanceof ${fromJson.className} ? ${expression} : ${convert(expression)}`;
    }
    const encode = ('encode' in model && model.encode)
      ? model.encode
      : (value: string) => `encodeGeneratedModel(${value})`;
    return `${expression} instanceof ${model.className} ? ${encode(expression)} : ${expression}`;
  }
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, expression, sequenceItems(direction, resolveModel, resolveSerde));
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, expression, sequenceItems(direction, resolveModel, resolveSerde));
  }
  if (descriptor.kind === 'object') {
    // A projection copies its fields inside a function whose `source` parameter is the record.
    const fieldSource = descriptor.projection ? 'source' : expression;
    const assignments = Object.entries(descriptor.properties).map(([name, item], index) => {
      const property = JSON.stringify(name);
      // `data` and `source` are already record bindings. Other expressions are cast once here.
      const sourceValue = recordIndex(fieldSource, property);
      const convert = (input: string): string => atField(value => emitNested(item, value, direction, resolveModel, resolveSerde), input, property, direction);
      return { name, property, sourceValue, value: convert(sourceValue), presentValue: convert(projectionLocal(index)) };
    });
    const additionalItem = descriptor.additionalProperties;
    const additional = typeof additionalItem === 'object'
      ? atField(value => emitNested(additionalItem, value, direction, resolveModel, resolveSerde), 'value', 'key', direction)
      : 'value';
    // Wire output omits an optional field whose value is undefined, as stringify and JSON.stringify do.
    const omitsUndefined = (name: string): boolean => direction === 'toJSON' && !descriptor.required.includes(name);
    if (descriptor.projection) {
      const knownKeys = Object.keys(descriptor.properties).map(name => JSON.stringify(name)).join(', ');
      const extras = typeof descriptor.additionalProperties === 'object'
        ? `for (const [key, value] of Object.entries(source)) if (value !== undefined && !([${knownKeys}] as readonly string[]).includes(key)) defineModelProperty(out, key, ${additional});`
        : '';
      // A decoder reads its input by the JSON view: one Object.keys pass reads each field once into a local.
      const capture = direction === 'toJSON' || assignments.length === 0 ? [] : [presentKeysSource('source', assignments.map(({ name }, index) => [name, projectionLocal(index)] as const), local => `${local}: unknown`)];
      const fields = assignments.map(({ name, property, sourceValue, value, presentValue }, index) => direction !== 'toJSON'
        ? `if (${projectionLocal(index)} !== undefined) defineModelProperty(out, ${property}, ${presentValue});`
        : omitsUndefined(name)
          ? `if (${sourceValue} !== undefined) defineModelProperty(out, ${property}, ${value});`
          : `if (Object.hasOwn(source, ${property})) defineModelProperty(out, ${property}, ${sourceValue} === undefined ? undefined : (${value}));`);
      return `${objectValueExpression(expression)} ? ((source: Record<string, unknown>) => { const out: Record<string, unknown> = {}; ${[...capture, ...fields, extras].filter(Boolean).join(' ')} return out; })(${recordExpression(expression)}) : ${expression}`;
    }
    const additionalChanged = additional !== 'value';
    const knownChanged = assignments.some(({ sourceValue, value }) => value !== sourceValue);
    if (!knownChanged && !additionalChanged) return expression;
    const knownKeys = Object.keys(descriptor.properties).map((name) => JSON.stringify(name)).join(', ');
    const base = additionalChanged
      ? `Object.fromEntries(Object.entries(${recordExpression(expression)}).filter(([key, value]) => value !== undefined && !([${knownKeys}] as readonly string[]).includes(key)).map(([key, value]) => [key, ${additional}]))`
      : recordExpression(expression);
    const fields = assignments.map(({ name, property, sourceValue, value }) => {
      if (omitsUndefined(name)) return `...(${sourceValue} !== undefined ? { [${property}]: ${value} } : undefined)`;
      const guarded = value === sourceValue
        ? sourceValue
        : `${sourceValue} === undefined ? ${sourceValue} : (${value})`;
      return `[${property}]: ${guarded}`;
    });
    return `${objectValueExpression(expression)} ? { ...${base}, ${fields.join(', ')} } : ${expression}`;
  }
  return expression;
}

export function emitModelFromJSON(
  descriptor: ModelConversionDescriptor,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde?: SerdeResolver,
): string {
  return emitNested(descriptor, expression, 'fromJSON', resolveModel, resolveSerde);
}

export function emitModelToJSON(
  descriptor: ModelConversionDescriptor,
  expression: string,
  resolveModel: (id: string) => ToJsonModelResolver,
  resolveSerde?: SerdeResolver,
): string {
  return emitNested(descriptor, expression, 'toJSON', resolveModel, resolveSerde);
}

/** Emit nested construction of domain models from partial model initializers. */
export function emitModelFromInit(
  descriptor: ModelConversionDescriptor,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
): string {
  return emitNested(descriptor, expression, 'fromInit', resolveModel);
}
