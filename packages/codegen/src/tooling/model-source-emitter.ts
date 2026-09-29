import type { DiscriminatorValue, ModelTypeDescriptor } from '@exprtlabs/codegen/model';
export {
  emitCodecRegistration,
  emitCodecRuntime,
  emitGraphStringify,
  emitParseFunction,
  emitStringifyFunction,
  fillFunctionName,
  fromWireFunctionName,
  parseFunctionName,
  pruneNamedImport,
  stringifyFunctionName,
  wireStringifyExportName,
  toWireFunctionName,
  validateFunctionName,
  type CodecRuntimeOptions,
  type NestedImportedSerde,
  type StringifySerdeResolver,
} from './stringify-emitter.js';
import {
  AMBIGUOUS_UNION_CONVERSION_ERROR,
  OBJECT_UNION_DISCRIMINATOR_ERROR,
  discriminatorMatch,
  emitScalarOrArrayConversion,
  literalDiscriminator,
  objectDiscriminator,
  objectValueExpression,
  objectVariant,
  presentUnionVariants,
  scalarOrArrayItem,
  emitDispatch,
  presentUnionIndices,
  unionDispatch,
  type ObjectTypeDescriptor,
  type VariantDispatch,
} from './union-conversion.js';

/** Generators read tag values through the same rule as the shared union conversion. */
export { literalValues } from './union-conversion.js';

export type TupleConversionDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'tuple' }>;
export type ModelConversionDescriptor = ModelTypeDescriptor;

/** A model's required tag properties and their literal value or values. */
export type ModelDiscriminators = Readonly<Record<string, DiscriminatorValue | readonly DiscriminatorValue[]>>;

export interface FromJsonModelResolver {
  readonly className: string;
  readonly discriminators?: ModelDiscriminators;
  /** Internal generated-model wire decoder expression. */
  readonly decode: (value: string) => string;
  /** Construct a domain model from a nested model initializer. */
  readonly fromInit?: (value: string) => string;
}

export interface ToJsonModelResolver {
  readonly className: string;
  readonly discriminators?: ModelDiscriminators;
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
  return expression === 'data' ? expression : `(${expression} as Record<string, unknown>)`;
}

function recordIndex(expression: string, property: string): string {
  return `${recordExpression(expression)}[${property}]`;
}

function taggedObjectExpression(
  expression: string,
  alternatives: readonly ObjectDescriptor[],
): string {
  const discriminator = objectDiscriminator(alternatives);
  if (!discriminator) return objectValueExpression(expression);
  const access = recordIndex(expression, JSON.stringify(discriminator.property));
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

function tupleRest(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'tuple' }>,
): TupleConversionDescriptor['rest'] {
  return descriptor.rest;
}

function emitTuple(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'tuple' }>,
  expression: string,
  withPaths: boolean,
  emit: (item: ModelConversionDescriptor, value: string, index: string) => string,
): string {
  const rest = tupleRest(descriptor);
  const array = `(${expression} as readonly unknown[])`;
  if (!rest) {
    const mapped = descriptor.items
      .map((item, index) => `index === ${index} ? (${emit(item, 'item', String(index))}) : `)
      .join('') + 'item';
    return `Array.isArray(${expression}) ? ${array}.map((item, index) => ${mapped}) : ${expression}`;
  }

  const prefix = descriptor.items.slice(0, rest.index);
  const suffix = descriptor.items.slice(rest.index);
  const prefixValues = prefix.map((item, index) => emit(item, `${array}[${index}]`, String(index)));
  const suffixValues = suffix.map((item, index) =>
    emit(item, `${array}[Math.max(${rest.index}, ${array}.length - ${suffix.length}) + ${index}]`, `Math.max(${rest.index}, ${array}.length - ${suffix.length}) + ${index}`),
  );
  const restValue = emit(rest.item, 'item', `index + ${rest.index}`);
  const restValues = restValue === 'item'
    ? `Array.from(${expression}).slice(${rest.index}, Math.max(${rest.index}, ${expression}.length - ${suffix.length}))`
    : `Array.from(${expression}).slice(${rest.index}, Math.max(${rest.index}, ${expression}.length - ${suffix.length})).map((item${withPaths ? ', index' : ''}) => ${restValue})`;
  const values = [...prefixValues, `...${restValues}`, ...suffixValues];
  return `Array.isArray(${expression}) ? [${values.join(', ')}] : ${expression}`;
}

function atField(converted: string, input: string, field: string, direction: 'fromJSON' | 'toJSON' | 'fromInit'): string {
  return converted === input || direction === 'fromInit'
    ? converted
    : `convertModelField('${direction === 'toJSON' ? 'serialize' : 'deserialize'}', ${field}, () => (${converted}))`;
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
    const objects = descriptor.variants.filter((variant): variant is ObjectDescriptor => variant.kind === 'object' && !metadata(variant).serde);
    if (objects.length === descriptor.variants.length) {
      const properties: Record<string, ModelConversionDescriptor> = Object.create(null);
      for (const object of objects) {
        for (const [name, property] of Object.entries(object.properties)) {
          properties[name] = properties[name]
            ? { kind: 'intersection', variants: [properties[name], property] }
            : property;
        }
      }
      const additional = objects.flatMap(object => typeof object.additionalProperties === 'object' ? [object.additionalProperties] : []);
      return emitNested({
        kind: 'object', properties,
        required: [...new Set(objects.flatMap(object => object.required))],
        additionalProperties: additional.length ? { kind: 'intersection', variants: additional } : true,
      }, expression, direction, resolveModel, resolveSerde);
    }
    const conversions = [...new Set(descriptor.variants
      .map(variant => emitNested(variant, expression, direction, resolveModel, resolveSerde))
      .filter(converted => converted !== expression))];
    if (conversions.length > 1) throw new Error('Intersection has conflicting conversions. Use one serde pair for the intersected value.');
    return conversions[0] ?? expression;
  }
  if (descriptor.kind === 'union') {
    const present = presentUnionVariants(descriptor);
    if (present.length === 1 && present.length !== descriptor.variants.length) {
      const converted = emitNested(present[0], expression, direction, resolveModel, resolveSerde);
      return converted === expression ? expression : `${expression} == null ? ${expression} : (${converted})`;
    }
    const array = scalarOrArrayItem(present);
    if (array) {
      const item = atField(emitNested(array.item, 'item', direction, resolveModel, resolveSerde), 'item', 'index', direction);
      const scalar = emitNested(array.item, expression, direction, resolveModel, resolveSerde);
      if (item === 'item' && scalar === expression) return expression;
      const indexParam = direction !== 'fromInit' && item.includes('index') ? ', index' : '';
      const mapped = item === 'item'
        ? expression
        : `(${expression} as readonly unknown[]).map((item${indexParam}) => ${item})`;
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
          ? `${objectValueExpression(expression)} && ${discriminatorMatch(recordIndex(expression, JSON.stringify(discriminator.property)), discriminator.values[index])}`
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
    const item = atField(emitNested(descriptor.item, 'item', direction, resolveModel, resolveSerde), 'item', 'index', direction);
    const indexParam = direction !== 'fromInit' && item.includes('index') ? ', index' : '';
    return `Array.isArray(${expression}) ? (${expression} as readonly unknown[]).map((item${indexParam}) => ${item}) : ${expression}`;
  }
  if (descriptor.kind === 'tuple') {
    return emitTuple(descriptor, expression, direction !== 'fromInit', (item, value, index) => atField(emitNested(item, value, direction, resolveModel, resolveSerde), value, index, direction));
  }
  if (descriptor.kind === 'object') {
    const assignments = Object.entries(descriptor.properties).map(([name, item]) => {
      const property = JSON.stringify(name);
      // `data` is already a record binding. Other expressions are cast once here.
      const sourceValue = recordIndex(expression, property);
      return {
        name,
        property,
        sourceValue,
        value: atField(emitNested(item, sourceValue, direction, resolveModel, resolveSerde), sourceValue, property, direction),
      };
    });
    const additional = typeof descriptor.additionalProperties === 'object'
      ? atField(emitNested(descriptor.additionalProperties, 'value', direction, resolveModel, resolveSerde), 'value', 'key', direction)
      : 'value';
    // Wire output omits an optional field whose value is undefined, as stringify and JSON.stringify do.
    const omitsUndefined = (name: string): boolean => direction === 'toJSON' && !descriptor.required.includes(name);
    if (descriptor.projection) {
      const knownKeys = Object.keys(descriptor.properties).map(name => JSON.stringify(name)).join(', ');
      const extras = typeof descriptor.additionalProperties === 'object'
        ? `...Object.entries(${recordExpression(expression)}).filter(([key]) => !([${knownKeys}] as readonly string[]).includes(key)).map(([key, value]) => [key, ${additional}])`
        : '';
      const fields = assignments.map(({ name, property, sourceValue, value }) => omitsUndefined(name)
        ? `...(${sourceValue} !== undefined ? [[${property}, ${value}]] : [])`
        : `...(Object.hasOwn(${recordExpression(expression)}, ${property}) ? [[${property}, ${sourceValue} === undefined ? undefined : (${value})]] : [])`);
      return `${objectValueExpression(expression)} ? Object.fromEntries([${[...fields, extras].filter(Boolean).join(', ')}]) : ${expression}`;
    }
    const additionalChanged = additional !== 'value';
    const knownChanged = assignments.some(({ sourceValue, value }) => value !== sourceValue);
    if (!knownChanged && !additionalChanged) return expression;
    const knownKeys = Object.keys(descriptor.properties).map((name) => JSON.stringify(name)).join(', ');
    const base = additionalChanged
      ? `Object.fromEntries(Object.entries(${recordExpression(expression)}).filter(([key]) => !([${knownKeys}] as readonly string[]).includes(key)).map(([key, value]) => [key, ${additional}]))`
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
