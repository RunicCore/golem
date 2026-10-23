import type { DiscriminatorValue, ModelTypeDescriptor } from '@exprtlabs/golem/model';
export {
  emitCodecRuntime,
  emitCodecRuntimeCode,
  emitGraphStringify,
  emitStringifyFunction,
  fillFunctionName,
  fromWireFunctionName,
  parseFunctionName,
  reachesItself,
  reachesRecursiveNode,
  stringifyFunctionName,
  wireStringifyExportName,
  toWireFunctionName,
  validateFunctionName,
  type CodecRuntimeOptions,
  type NestedImportedSerde,
  type StringifySerdeResolver,
} from './stringify-emitter.js';
export { presentKeysSource } from '../presence.js';
export { pruneGeneratedImports } from './generated-imports.js';
export { calleeOf, FIELD_CONVERSION_INPUT, singleCallConverter, type TupleConversionDescriptor } from './sequence-conversion.js';
/** The one function that turns the Code of an emitter into text, for generators that still build text. */
export {
  aliased, blockComment, code, fileImports, helper, helperName, helperSet, identifier, importedNames, importLines, importSet, ImportSource, join, legacyText, literal, render, sameCode, trimEnd,
  type Code, type Emitted, type Helper, type ImportOptions, type JsonValue,
} from './code.js';
export { rt, rtType, type RuntimeModule } from './rt.js';
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
import { code, emittedCode, join, legacyText, literal, sameCode, type Code, type Emitted } from './code.js';
import { rt } from './rt.js';
import { CompositionConflictError, requireComposedObject, type ModelBases } from './composition.js';
import { FIELD_CONVERSION_INPUT, calleeOf, emitArrayConversion, emitTupleConversion, type SequenceItems } from './sequence-conversion.js';
import {
  discriminatorMatch,
  literalDiscriminator,
  objectDiscriminator,
  ObjectUnionDiscriminatorError,
  objectValueExpression,
  objectVariant,
  presentUnionVariants,
  emitDispatch,
  emitUnionConversion,
  presentUnionIndices,
  unionDispatch,
  type ObjectTypeDescriptor,
  type VariantDispatch,
} from './union-conversion.js';

/** Generators read tag values through the same rule as the shared union conversion. */
export { AmbiguousUnionConversionError, descriptorNeedsConversion, literalValues, ObjectUnionDiscriminatorError } from './union-conversion.js';

export type ModelConversionDescriptor = ModelTypeDescriptor;

/** The local that a projection decoder reads the field at `index` into. */
const projectionLocal = (index: number): string => `__golemProjected${index}`;

/** A model's required tag properties and their literal value or values. */
export type ModelDiscriminators = Readonly<Record<string, DiscriminatorValue | readonly DiscriminatorValue[]>>;

/**
 * Each answer of a resolver is Code that holds the callee as a part, so the file imports it. golem-openapi still answers text.
 */
export interface FromJsonModelResolver {
  readonly className: Emitted;
  readonly discriminators?: ModelDiscriminators;
  /** The models that this model extends, so a derived model narrows its bases where they judge one property. */
  readonly bases?: readonly string[];
  /** Internal generated-model wire decoder expression. */
  readonly decode: (value: string) => Emitted;
  /** Construct a domain model from a nested model initializer. */
  readonly fromInit?: (value: string) => Emitted;
  /** A projection whose value converts to itself: a use writes no call. */
  readonly identity?: true;
}

export interface ToJsonModelResolver {
  readonly className: Emitted;
  readonly discriminators?: ModelDiscriminators;
  /** The models that this model extends, so a derived model narrows its bases where they judge one property. */
  readonly bases?: readonly string[];
  /** Internal generated-model wire encoder expression. */
  readonly encode?: (value: string) => Emitted;
  /** A projection whose value converts to itself: a use writes no call. */
  readonly identity?: true;
}

/**
 * Resolve a compiler-emitted serde pair to a call expression.  The model
 * compiler owns the import and lazy wrapper; this emitter only decides where
 * the wrapper is applied in a nested conversion tree.
 */
export interface SerdeResolver {
  readonly deserialize: (id: string, value: Code) => Code;
  readonly serialize: (id: string, value: Code) => Code;
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

/** The record view of an expression. It is text because the string builders of `presence.ts` take their input as text. */
function recordExpression(expression: string): string {
  return expression === 'data' || expression === 'source' ? expression : `(${expression} as Record<string, unknown>)`;
}

function recordIndex(expression: string, property: string): string {
  return `${recordExpression(expression)}[${property}]`;
}

/** A decoder's tag read by the JSON view, so an inherited or non-enumerable tag selects no branch. */
function presentTag(expression: string, property: string): Code {
  const key = JSON.stringify(property);
  return code`(${legacyText(presentValueSource(expression, key, recordIndex(expression, key)))})`;
}

function taggedObjectExpression(
  expression: string,
  alternatives: readonly ObjectDescriptor[],
): Code {
  const discriminator = objectDiscriminator(alternatives);
  if (!discriminator) return objectValueExpression(expression);
  const access = presentTag(expression, discriminator.property);
  return code`${objectValueExpression(expression)} && ${discriminatorMatch(access, discriminator.values.flat())}`;
}

/** The construction of a model from its initializer: the resolver's own, or `new <class>(<value>)`. */
function fromInitCall(model: FromJsonModelResolver, expression: string): Code {
  return model.fromInit
    ? emittedCode(model.fromInit(expression))
    : code`new ${emittedCode(model.className)}(${legacyText(expression)})`;
}

/** The wire encoding of a model: the resolver's own, or `encodeGeneratedModel(<value>)`. */
function encodeCall(model: { readonly encode?: (value: string) => Emitted }, expression: string): Code {
  return model.encode
    ? emittedCode(model.encode(expression))
    : code`${rt.conversion.encodeGeneratedModel}(${legacyText(expression)})`;
}

function unionGeneratedFromJson(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
): Code | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  const objects = descriptor.variants.filter(
    (variant): variant is ObjectDescriptor => variant.kind === 'object',
  );
  const model = resolveModel(generated.id);
  const value = legacyText(expression);
  const converted = code`${value} instanceof ${emittedCode(model.className)} ? ${value} : ${emittedCode(model.decode(expression))}`;
  if (objects.length === 0) {
    return code`${objectValueExpression(expression)} ? ${converted} : ${value}`;
  }
  const tagged = taggedObjectExpression(expression, objects);
  return code`${objectValueExpression(expression)} && !(${tagged}) ? ${converted} : ${value}`;
}

function unionGeneratedFromInit(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
): Code | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  const objects = descriptor.variants.filter(
    (variant): variant is ObjectDescriptor => variant.kind === 'object',
  );
  const model = resolveModel(generated.id);
  const value = legacyText(expression);
  const converted = code`${value} instanceof ${emittedCode(model.className)} ? ${value} : ${fromInitCall(model, expression)}`;
  if (objects.length === 0) return code`${objectValueExpression(expression)} ? ${converted} : ${value}`;
  const tagged = taggedObjectExpression(expression, objects);
  return code`${objectValueExpression(expression)} && !(${tagged}) ? ${converted} : ${value}`;
}

function unionGeneratedToJson(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  resolveModel: (id: string) => ToJsonModelResolver,
): Code | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  const model = resolveModel(generated.id);
  const value = legacyText(expression);
  return code`${value} instanceof ${emittedCode(model.className)} ? ${encodeCall(model, expression)} : ${value}`;
}

/**
 * A converted value at a nested field. `emit(FIELD_CONVERSION_INPUT)` shows the conversion's shape: a single call
 * passes its function and the value to `convertModelField`; any other conversion becomes a value-taking arrow,
 * so no conversion captures the enclosing loop.
 */
function atField(emit: (value: string) => Code, input: string, field: Code, direction: 'fromJSON' | 'toJSON' | 'fromInit'): Code {
  if (direction === 'fromInit') return emit(input);
  const converted = emit(FIELD_CONVERSION_INPUT);
  if (sameCode(converted, legacyText(FIELD_CONVERSION_INPUT))) return legacyText(input);
  const convert = calleeOf(converted) ?? code`(${legacyText(FIELD_CONVERSION_INPUT)}: unknown) => (${converted})`;
  return code`${rt.conversion.convertModelField}(${literal(direction === 'toJSON' ? 'serialize' : 'deserialize')}, ${field}, ${convert}, ${legacyText(input)})`;
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
      const converted = emitNested(item, value, direction, resolveModel, resolveSerde);
      return { code: converted, throws: !sameCode(converted, legacyText(value)) };
    },
  };
}

function emitNestedUnion(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: string,
  direction: 'fromJSON' | 'toJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver | ToJsonModelResolver,
  resolveSerde?: SerdeResolver,
): Code {
  const indices = presentUnionIndices(descriptor);
  const dispatchDirection = direction === 'toJSON' ? 'encode-value' : 'decode';
  const value = legacyText(expression);
  const convert = (variant: ModelConversionDescriptor): Code =>
    emitNested(variant, expression, direction, resolveModel, resolveSerde);
  return emitUnionConversion(descriptor, expression, 'nested', {
    convert,
    items: sequenceItems(direction, resolveModel, resolveSerde),
    tagged: () => {
      const present = presentUnionVariants(descriptor);
      const modelBranches = present.filter(variant => variant.kind === 'reference' || variant.kind === 'generated-model');
      if (modelBranches.length === 0 || !present.every(variant =>
        variant.kind === 'reference' || variant.kind === 'generated-model' || variant.kind === 'object')) return undefined;
      const dispatch = descriptor.discriminator
        ? unionDispatch(descriptor, indices, objectVariant)
        : inferredBranchDispatch(present.map(variant => variant.kind === 'reference'
          ? resolveModel(variant.name).discriminators ?? {}
          : variant.kind === 'generated-model'
            ? resolveModel(variant.id).discriminators ?? {}
            : variant.kind === 'object' ? Object.fromEntries(literalDiscriminator(variant)) : {}));
      if (!dispatch) return undefined;
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
          convert: convert(variant),
        })),
      });
    },
    afterGenerated: (present) => {
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
      const convertedObjects = objects.map(object => ({ object, converted: convert(object) }));
      if (convertedObjects.some(({ converted }) => !sameCode(converted, value))) {
        const discriminator = unionDispatch(descriptor, objectIndices, objectVariant);
        if (!discriminator && (objects.length > 1 || descriptor.variants.some(variant => ['reference', 'generated-model', 'any', 'unknown', 'intersection'].includes(variant.kind)))) {
          throw new ObjectUnionDiscriminatorError(descriptor.variants);
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
        let chain = result ?? value;
        for (let index = convertedObjects.length - 1; index >= 0; index--) {
          const guard = discriminator
            ? code`${objectValueExpression(expression)} && ${discriminatorMatch(presentTag(expression, discriminator.property), discriminator.values[index])}`
            : objectValueExpression(expression);
          chain = code`${guard} ? (${convertedObjects[index].converted}) : (${chain})`;
        }
        return chain;
      }
      return result;
    },
  });
}

function emitNested(
  descriptor: ModelConversionDescriptor,
  expression: string,
  direction: 'fromJSON' | 'toJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver | ToJsonModelResolver,
  resolveSerde?: SerdeResolver,
): Code {
  const value = legacyText(expression);
  const tags = metadata(descriptor);
  if (tags.serde && resolveSerde) {
    return direction === 'fromJSON'
      ? resolveSerde.deserialize(tags.serde.id, value)
      : direction === 'toJSON'
        ? resolveSerde.serialize(tags.serde.id, value)
        : value;
  }
  if (descriptor.kind === 'date' || tags.date) {
    return direction === 'fromJSON'
      ? code`${rt.conversion.deserializeDate}(${value})`
      : direction === 'toJSON'
        ? code`${rt.conversion.serializeDate}(${value})`
        : value;
  }
  if (descriptor.kind === 'intersection') {
    const bases: ModelBases = { basesOf: (id) => resolveModel(id).bases ?? [] };
    const merged = descriptor.variants.every(variant => !metadata(variant).serde) ? requireComposedObject(descriptor.variants, bases) : undefined;
    if (merged) return emitNested(merged, expression, direction, resolveModel, resolveSerde);
    // A scalar intersection converts by its one converting part.
    const conversions: Code[] = [];
    for (const variant of descriptor.variants) {
      const converted = emitNested(variant, expression, direction, resolveModel, resolveSerde);
      if (!sameCode(converted, value) && !conversions.some(known => sameCode(known, converted))) conversions.push(converted);
    }
    if (conversions.length > 1) throw new CompositionConflictError('two parts convert it differently');
    return conversions[0] ?? value;
  }
  if (descriptor.kind === 'union') {
    return emitNestedUnion(descriptor, expression, direction, resolveModel, resolveSerde);
  }
  if (descriptor.kind === 'generated-model') {
    const model = resolveModel(descriptor.id);
    if (direction === 'fromJSON' || direction === 'fromInit') {
      const fromJson = model;
      if (!('decode' in fromJson)) throw new Error(`Missing decode resolver for generated model ${descriptor.id}.`);
      const convert = direction === 'fromInit' ? fromInitCall(fromJson, expression) : emittedCode(fromJson.decode(expression));
      return code`${value} == null || ${value} instanceof ${emittedCode(fromJson.className)} ? ${value} : ${convert}`;
    }
    return code`${value} instanceof ${emittedCode(model.className)} ? ${encodeCall('encode' in model ? model : {}, expression)} : ${value}`;
  }
  if (descriptor.kind === 'reference') {
    const model = resolveModel(descriptor.name);
    if (descriptor.projection) {
      if (model.identity) return value;
      if (direction === 'toJSON') return 'encode' in model && model.encode ? emittedCode(model.encode(expression)) : value;
      if (!('decode' in model)) throw new Error(`Missing projected conversion for ${descriptor.name}.`);
      return emittedCode(direction === 'fromInit' ? (model.fromInit ?? model.decode)(expression) : model.decode(expression));
    }
    if (direction === 'fromJSON' || direction === 'fromInit') {
      const fromJson = model;
      if (!('decode' in fromJson)) throw new Error(`Missing decode resolver for generated model ${descriptor.name}.`);
      const convert = direction === 'fromInit' ? fromInitCall(fromJson, expression) : emittedCode(fromJson.decode(expression));
      return code`${value} == null || ${value} instanceof ${emittedCode(fromJson.className)} ? ${value} : ${convert}`;
    }
    return code`${value} instanceof ${emittedCode(model.className)} ? ${encodeCall('encode' in model ? model : {}, expression)} : ${value}`;
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
      const property = literal(name);
      // `data` and `source` are already record bindings. Other expressions are cast once here.
      const sourceText = recordIndex(fieldSource, JSON.stringify(name));
      const convert = (input: string): Code => atField(nested => emitNested(item, nested, direction, resolveModel, resolveSerde), input, property, direction);
      return { name, property, sourceValue: legacyText(sourceText), value: convert(sourceText), presentValue: convert(projectionLocal(index)) };
    });
    const additionalItem = descriptor.additionalProperties;
    const plainValue = legacyText('value');
    const additional = typeof additionalItem === 'object'
      ? atField(nested => emitNested(additionalItem, nested, direction, resolveModel, resolveSerde), 'value', legacyText('key'), direction)
      : plainValue;
    // Wire output omits an optional field whose value is undefined, as stringify and JSON.stringify do.
    const omitsUndefined = (name: string): boolean => direction === 'toJSON' && !descriptor.required.includes(name);
    const additionalChanged = !sameCode(additional, plainValue);
    const knownChanged = assignments.some(({ sourceValue, value: converted }) => !sameCode(converted, sourceValue));
    const knownKeys = join(Object.keys(descriptor.properties).map(name => literal(name)), code`, `);
    const defineProperty = rt.conversion.defineModelProperty;
    // A decoder reads the declared fields of any object by the JSON view, so it builds the copy from one Object.keys pass.
    // A projection does so in both directions, and also drops the keys it does not declare.
    if (descriptor.projection || (direction !== 'toJSON' && (knownChanged || additionalChanged))) {
      // An additionalProperties tag declares the other keys of a projection as data: they are copied as they are or by
      // the tag's type. Another object keeps its other keys the same way.
      const hasExtras = !descriptor.projection || typeof descriptor.additionalProperties === 'object' || descriptor.additionalPropertiesDeclared;
      // A decoder reads its input by the JSON view: one Object.keys pass reads each field once into a local.
      const captured = direction !== 'toJSON' && assignments.length > 0;
      // The same pass collects the other keys, and the copy writes them after the fields, in key order.
      const collectExtras = hasExtras && captured;
      const capture = captured
        ? [code`${legacyText(collectExtras ? 'let __golemExtra: string[] | undefined; ' : '')}${legacyText(presentKeysSource('source', assignments.map(({ name }, index) => [name, projectionLocal(index)] as const), local => `${local}: unknown`, collectExtras ? '(__golemExtra ??= []).push(__golemKey);' : undefined))}`]
        : [];
      const extras = !hasExtras
        ? join([])
        : collectExtras
          ? code`if (__golemExtra !== undefined) for (const key of __golemExtra) { const value = source[key]; if (value !== undefined) ${defineProperty}(out, key, ${additional}); }`
          : code`for (const [key, value] of Object.entries(source)) if (value !== undefined && !([${knownKeys}] as readonly string[]).includes(key)) ${defineProperty}(out, key, ${additional});`;
      const fields = assignments.map(({ name, property, sourceValue, value: converted, presentValue }, index) => direction !== 'toJSON'
        ? code`if (${legacyText(projectionLocal(index))} !== undefined) ${defineProperty}(out, ${property}, ${presentValue});`
        : omitsUndefined(name)
          ? code`if (${sourceValue} !== undefined) ${defineProperty}(out, ${property}, ${converted});`
          : code`if (Object.hasOwn(source, ${property})) ${defineProperty}(out, ${property}, ${sourceValue} === undefined ? undefined : (${converted}));`);
      const body = join([...capture, ...fields, extras].filter(piece => piece.parts.length > 0), code` `);
      return code`${objectValueExpression(expression)} ? ((source: Record<string, unknown>) => { const out: Record<string, unknown> = {}; ${body} return out; })(${legacyText(recordExpression(expression))}) : ${value}`;
    }
    if (!knownChanged && !additionalChanged) return value;
    const record = legacyText(recordExpression(expression));
    const base = additionalChanged
      ? code`Object.fromEntries(Object.entries(${record}).filter(([key, value]) => value !== undefined && !([${knownKeys}] as readonly string[]).includes(key)).map(([key, value]) => [key, ${additional}]))`
      : record;
    const fields = assignments.map(({ name, property, sourceValue, value: converted }) => {
      if (omitsUndefined(name)) return code`...(${sourceValue} !== undefined ? { [${property}]: ${converted} } : undefined)`;
      const guarded = sameCode(converted, sourceValue)
        ? sourceValue
        : code`${sourceValue} === undefined ? ${sourceValue} : (${converted})`;
      return code`[${property}]: ${guarded}`;
    });
    return code`${objectValueExpression(expression)} ? { ...${base}, ${join(fields, code`, `)} } : ${value}`;
  }
  return value;
}

export function emitModelFromJSON(
  descriptor: ModelConversionDescriptor,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde?: SerdeResolver,
): Code {
  return emitNested(descriptor, expression, 'fromJSON', resolveModel, resolveSerde);
}

/** Whether a value of `descriptor` can hold a value of `unknown` or `any` type, which can hold a model instance at any depth. */
function holdsUnknown(descriptor: ModelConversionDescriptor): boolean {
  if (metadata(descriptor).serde) return false;
  switch (descriptor.kind) {
    case 'unknown':
    case 'any':
      return true;
    case 'array':
      return holdsUnknown(descriptor.item);
    case 'tuple':
      return descriptor.items.some(holdsUnknown) || (descriptor.rest !== undefined && holdsUnknown(descriptor.rest.item));
    case 'union':
    case 'intersection':
      return descriptor.variants.some(holdsUnknown);
    case 'object':
      return Object.values(descriptor.properties).some(holdsUnknown)
        || (typeof descriptor.additionalProperties === 'object' && holdsUnknown(descriptor.additionalProperties));
    default:
      return false;
  }
}

/**
 * The class-level encode of a model value. A value that can hold an `unknown` or `any` value is written without the
 * program state of a model instance inside it, as stringify and toWireFormat write it.
 */
export function emitModelToJSON(
  descriptor: ModelConversionDescriptor,
  expression: string,
  resolveModel: (id: string) => ToJsonModelResolver,
  resolveSerde?: SerdeResolver,
): Code {
  const converted = emitNested(descriptor, expression, 'toJSON', resolveModel, resolveSerde);
  return holdsUnknown(descriptor) ? code`${rt.serde.withoutInstanceState}(${converted})` : converted;
}

/** Emit nested construction of domain models from partial model initializers. */
export function emitModelFromInit(
  descriptor: ModelConversionDescriptor,
  expression: string,
  resolveModel: (id: string) => FromJsonModelResolver,
): Code {
  return emitNested(descriptor, expression, 'fromInit', resolveModel);
}
