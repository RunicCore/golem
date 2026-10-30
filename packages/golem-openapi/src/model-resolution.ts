import { descriptorNeedsConversion } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph, SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import { identifier } from '@exprtlabs/golem/internal/generator-support';
import { asRecord, escapeJsonPointerToken, isJsonObject, objectEntries, type JsonObject } from './json.js';
import type { GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import type { ModelConstraint, ModelTypeDescriptor, UnionDiscriminator } from '@exprtlabs/golem/internal/schema';
import { componentOrigin, LocatedError } from './origin.js';
import {
  COMPOSITION_PROPERTY_NEVER,
  COMPOSITION_UNSATISFIABLE,
  isConstraintOnlyPart,
  isSequenceSchema,
  joinMembers,
  neverNames,
  neverReason,
  ownKeywords,
  resolveComposition,
  type Composition,
  type CompositionReader,
  unionVariants,
} from './composition.js';
import { effectiveSchemaTypes } from './normalize.js';
import { code } from '@exprtlabs/golem/internal/emitter';
import { schemaContext } from './types.js';
import {
  collectCanonicalResources,
  nextSchemaBase,
  resolveExactComponent,
  schemaDocumentBase,
  type ExactComponentTarget,
  type ResourceIndex,
} from './schema-projection.js';

/** The id of an OpenAPI schema's model: the manifest and the validation closure name a model by it. */
export function modelStableId(digest: string, definition: ModelDefinition): string {
  return `openapi:${digest.slice(0, 16)}#/components/schemas/${definition.schemaName}`;
}

export interface ModelDefinition {
  readonly name: string;
  readonly schemaName: string;
  readonly schema: unknown;
  readonly rawSchema: unknown;
  /** The base model: the first model `$ref` of the allOf. */
  baseName: string | null;
  /** The other models the allOf refers to; their fields are in `properties`, and a slot narrows each of them. */
  otherBaseNames: readonly string[];
  /** The union models that select this model as a variant. It narrows each of them, also when it does not extend them. */
  variantOf: string[];
  properties: Map<string, unknown>;
  additionalProperties: unknown;
  required: Set<string>;
  variants?: readonly string[];
  discriminator?: unknown;
  isUnion?: boolean;
}

/**
 * A non-model component that reaches itself through `$ref`. It cannot be written inline, so it is a named node of the
 * schema graph, owned by one model group, and every use calls that node.
 */
export interface RecursiveAlias {
  readonly name: string;
  readonly schemaName: string;
  readonly rawSchema: unknown;
  /** The graph node that converts it; set when the graph is interned. */
  nodeId?: string;
  /** The conversion descriptor of the component, with each use of a recursive component as a projection reference. */
  descriptor?: ModelTypeDescriptor;
}

/** The models of a document by type name, and its recursive aliases. */
export class ModelDefinitions extends Map<string, ModelDefinition> {
  constructor(readonly aliases: ReadonlyMap<string, RecursiveAlias>) {
    super();
  }
}

interface DiscriminatorSelection {
  readonly propertyName: string;
  readonly variants: ReadonlyMap<string, string>;
  /** The variant that `defaultMapping` names: it takes every value whose tag selects no other variant, and may lack the tag. */
  readonly defaultVariant?: string;
}

/** Selections resolved (and diagnosed) once per discriminated union schema object, per analysis. */
export type DiscriminatorSelections = Map<object, DiscriminatorSelection | null>;

/** How `format: date-time`, `date` and `duration` strings become model values. */
export type OpenApiDates = 'date' | 'temporal';

export interface ModelResolveEnv {
  readonly document: unknown;
  readonly dates: OpenApiDates;
  readonly resources: ResourceIndex;
  readonly currentBase: string;
  readonly anchors?: ReadonlyMap<string, string>;
  readonly selections?: DiscriminatorSelections;
}

export interface OpenApiModelAnalysis {
  readonly definitions: ModelDefinitions;
  readonly ordered: readonly ModelDefinition[];
  readonly schemaGraph: SchemaGraph;
  readonly grouping: SchemaGraphGrouping;
  readonly resources: ResourceIndex;
  readonly nodesById: ReadonlyMap<string, SchemaNode>;
  /** By schema name, and by short codec name when that name is unambiguous. */
  readonly nodesByName: ReadonlyMap<string, SchemaNode>;
  /** The schema each node was interned for. */
  readonly definitionNameByNodeId: ReadonlyMap<string, string>;
  readonly nodesByCodecId: ReadonlyMap<string, SchemaNode>;
  readonly diagnostics: readonly GolemDiagnostic[];
  readonly selections: DiscriminatorSelections;
  readonly dates: OpenApiDates;
}

export function modelEnv(
  document: unknown,
  currentBase?: string,
  anchors?: ReadonlyMap<string, string>,
  resources?: ResourceIndex,
  selections?: DiscriminatorSelections,
  dates: OpenApiDates = 'date',
): ModelResolveEnv {
  return {
    document,
    dates,
    resources: resources ?? collectCanonicalResources(document),
    currentBase: currentBase ?? schemaDocumentBase(document),
    anchors,
    selections,
  };
}

export function withSchemaBase(env: ModelResolveEnv, schema: unknown): ModelResolveEnv {
  return { ...env, currentBase: nextSchemaBase(schema, env.currentBase, env.resources) };
}

/** `dates: temporal` string formats and the `@exprtlabs/golem/temporal` tag each converts with. */
const TEMPORAL_FORMATS = {
  'date-time': { typeName: 'Temporal.Instant', type: code`Temporal.Instant`, codec: 'TemporalInstant' },
  date: { typeName: 'Temporal.PlainDate', type: code`Temporal.PlainDate`, codec: 'TemporalPlainDate' },
  duration: { typeName: 'Temporal.Duration', type: code`Temporal.Duration`, codec: 'TemporalDuration' },
} as const;

export const TEMPORAL_SERDE_PREFIX = 'temporal:';

function temporalFormat(schema: unknown, env: ModelResolveEnv): (typeof TEMPORAL_FORMATS)[keyof typeof TEMPORAL_FORMATS] | undefined {
  if (env.dates !== 'temporal' || !isJsonObject(schema) || typeof schema.format !== 'string') return undefined;
  if (!(schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string')))) return undefined;
  return Object.hasOwn(TEMPORAL_FORMATS, schema.format) ? TEMPORAL_FORMATS[schema.format as keyof typeof TEMPORAL_FORMATS] : undefined;
}

function isTemporalDescriptor(descriptor: ModelTypeDescriptor): boolean {
  const serde = (descriptor as { readonly serde?: { readonly id?: string } }).serde;
  return descriptor.kind === 'class-value' && serde?.id?.startsWith(TEMPORAL_SERDE_PREFIX) === true;
}

export function directComponentSchemaRef(schema: unknown, env: ModelResolveEnv): string | null {
  if (isJsonObject(schema) && typeof schema.$ref !== 'string' && typeof schema.$dynamicRef === 'string') {
    const anchored = env.anchors?.get(schema.$dynamicRef);
    if (anchored) return anchored;
  }
  return exactComponentTarget(schema, env)?.typeName ?? null;
}

export function componentSchemaTarget(schema: unknown, env: ModelResolveEnv): unknown {
  const name = directComponentSchemaRef(schema, env);
  if (!name) return undefined;
  const schemas = asRecord(asRecord(asRecord(env.document).components).schemas);
  const byTypeName = objectEntries(schemas).find(([raw]) => identifier(raw) === name);
  return byTypeName?.[1];
}

/** One nullability rule for model fields, shared with types and runtime schemas. */
function admitsNull(schema: Readonly<Record<string, unknown>>): boolean {
  return effectiveSchemaTypes(schema).includes('null');
}

/** A reference admits null when it says so, or when the component it names does. */
function admitsNullThroughReference(
  schema: unknown,
  reference: string,
  definitions: ModelDefinitions,
): boolean {
  return admitsNull(asRecord(schema)) || admitsNull(asRecord(definitions.get(reference)?.schema));
}

/**
 * Visits a schema and the schemas it composes with allOf, through component references: each base before the schema itself.
 * A reference in progress, and the reference named `skipReference`, are not visited again.
 */
export function visitAllOfChain(
  env: ModelResolveEnv,
  rawSchema: unknown,
  visitSchema: (schema: JsonObject) => void,
  skipReference: string | null = null,
): void {
  const visiting = new Set<string>();
  const visit = (schema: unknown, current: ModelResolveEnv): void => {
    if (!isJsonObject(schema)) return;
    const nested = withSchemaBase(current, schema);
    const reference = directComponentSchemaRef(schema, nested);
    if (reference) {
      if (reference === skipReference || visiting.has(reference)) return;
      const target = componentSchemaTarget(schema, nested);
      if (!target) return;
      visiting.add(reference);
      visit(target, nested);
      visiting.delete(reference);
      return;
    }
    for (const item of Array.isArray(schema.allOf) ? schema.allOf : []) visit(item, nested);
    visitSchema(schema);
  };
  visit(rawSchema, env);
}

export function modelSchemaProperties(
  env: ModelResolveEnv,
  rawSchema: unknown,
  inheritedSchemaName: string | null = null,
): Map<string, unknown> {
  const properties = new Map<string, unknown>();
  visitAllOfChain(env, rawSchema, (schema) => {
    for (const [name, property] of objectEntries(schema.properties)) {
      properties.set(name, property);
    }
  }, inheritedSchemaName);
  return properties;
}

/** The environment a component's own schema is read in: its anchors, and the analysis' dates and discriminator tables. */
function componentEnv(env: ModelResolveEnv, schemaName: string, rawSchema: unknown): ModelResolveEnv {
  const anchors = schemaContext(env.document, schemaContext(env.document, { resources: env.resources }), schemaName, rawSchema).anchors;
  return modelEnv(env.document, undefined, anchors, env.resources, env.selections, env.dates);
}

/** The conversion descriptor of a recursive alias: each use of a recursive component, itself included, is a projection reference. */
export function aliasDescriptor(alias: RecursiveAlias, definitions: ModelDefinitions, env: ModelResolveEnv): ModelTypeDescriptor {
  alias.descriptor ??= modelConversionDescriptor(alias.rawSchema, definitions, componentEnv(env, alias.schemaName, alias.rawSchema), 'to', new Set(), true, 'definition');
  return alias.descriptor;
}

/** Every model that the definition narrows: its class base, the other refs of its allOf, and the unions that select it. */
export function modelBases(definition: ModelDefinition | undefined): readonly string[] {
  return definition ? [...(definition.baseName ? [definition.baseName] : []), ...definition.otherBaseNames, ...definition.variantOf] : [];
}

/** The bases that each model declares, which the composition check and the codec emitter both read. */
export function declaredModelBases(definitions: ModelDefinitions): Pick<CompositionReader<never>, 'basesOf'> {
  return { basesOf: (id) => modelBases(definitions.get(id)) };
}

function modelSchemaReference(schema: unknown, env: ModelResolveEnv): string | null {
  return directComponentSchemaRef(schema, withSchemaBase(env, schema));
}

function openApiKeywordConstraints(schema: Readonly<Record<string, unknown>>): ModelConstraint[] | undefined {
  const constraints: ModelConstraint[] = [];
  const numeric = (
    key: string,
    kind: 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum' | 'multipleOf'
      | 'minLength' | 'maxLength' | 'minItems' | 'maxItems'
      | 'minProperties' | 'maxProperties' | 'minContains' | 'maxContains',
  ): void => {
    const value = schema[key];
    if (typeof value === 'number') constraints.push({ kind, value });
  };
  numeric('minimum', 'minimum');
  numeric('maximum', 'maximum');
  numeric('exclusiveMinimum', 'exclusiveMinimum');
  numeric('exclusiveMaximum', 'exclusiveMaximum');
  numeric('multipleOf', 'multipleOf');
  numeric('minLength', 'minLength');
  numeric('maxLength', 'maxLength');
  numeric('minItems', 'minItems');
  numeric('maxItems', 'maxItems');
  numeric('minProperties', 'minProperties');
  numeric('maxProperties', 'maxProperties');
  numeric('minContains', 'minContains');
  numeric('maxContains', 'maxContains');
  if (typeof schema.pattern === 'string') constraints.push({ kind: 'pattern', value: schema.pattern });
  if (typeof schema.format === 'string') constraints.push({ kind: 'format', value: schema.format });
  if (schema.uniqueItems === true) constraints.push({ kind: 'uniqueItems' });
  return constraints.length ? constraints : undefined;
}

function withOpenApiConstraints(
  descriptor: ModelTypeDescriptor,
  schema: Readonly<Record<string, unknown>>,
): ModelTypeDescriptor {
  const extra = openApiKeywordConstraints(schema);
  if (!extra) return descriptor;
  return { ...descriptor, constraints: [...(descriptor.constraints ?? []), ...extra] };
}

/** An `enum` that lists an object or an array limits the whole value, `null` included, so it sits on the descriptor of the field. */
function withOpenApiEnum(
  descriptor: ModelTypeDescriptor,
  schema: Readonly<Record<string, unknown>>,
): ModelTypeDescriptor {
  if (!Array.isArray(schema.enum)) return descriptor;
  return { ...descriptor, constraints: [...(descriptor.constraints ?? []), { kind: 'enum', values: schema.enum }] };
}

/**
 * An allOf member that decides the field: not constraint-only, and not an array or tuple that converts nothing
 * (`{ items: { maxLength: 30 } }` restates a shape and cannot undo another schema's conversion).
 */
function isDecidingPart(part: ModelTypeDescriptor): boolean {
  return !isConstraintOnlyPart(part) && (descriptorNeedsConversion(part) || !isSequenceDescriptor(part));
}

function isSequenceDescriptor(descriptor: ModelTypeDescriptor): boolean {
  if (descriptor.kind === 'union') return descriptor.variants.some(isSequenceDescriptor);
  return descriptor.kind === 'array' || descriptor.kind === 'tuple';
}

/** A schema that no value satisfies: `false`, `not: true`, or an empty `enum`. */
function acceptsNoValue(schema: unknown): boolean {
  return schema === false || (isJsonObject(schema) && (schema.not === true || (Array.isArray(schema.enum) && schema.enum.length === 0)));
}

/**
 * `enum` limits a value to its listed values, with or without `type` (JSON Schema 2020-12 section 6.1.2). An empty list admits no value.
 * A list of scalars is a literal union without the values that the declared `type` excludes. A list with an object or an array has no literal form: the keyword constraints carry it as an `enum` constraint.
 */
function openApiEnumDescriptor(schema: { readonly enum?: unknown; readonly type?: unknown }): ModelTypeDescriptor | undefined {
  const values = schema.enum;
  if (!Array.isArray(values)) return undefined;
  if (values.some((value) => value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return undefined;
  const types = effectiveSchemaTypes(schema);
  const admitted = (value: unknown): boolean => types.length === 0
    || types.includes(value === null ? 'null' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value)
    || (typeof value === 'number' && types.includes('number'));
  const variants = values.filter(admitted).map((value): ModelTypeDescriptor => value === null ? { kind: 'null' } : { kind: 'literal', value });
  if (variants.length === 0) return { kind: 'never' };
  return variants.length === 1 ? variants[0]! : { kind: 'union', variants };
}

function openApiPrimitiveDescriptor(schema: { readonly type?: unknown }): ModelTypeDescriptor | undefined {
  const types = (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [])
    .filter((item): item is string => typeof item === 'string' && item !== 'null');
  if (types.length !== 1) return undefined;
  const type = types[0];
  if (type === 'string') return { kind: 'string' };
  if (type === 'boolean') return { kind: 'boolean' };
  if (type === 'integer') return { kind: 'number', constraints: [{ kind: 'integer' }] };
  if (type === 'number') return { kind: 'number' };
  return undefined;
}

export function hasAllOfMembers(schema: Readonly<Record<string, unknown>>): schema is Readonly<Record<string, unknown>> & { readonly allOf: readonly unknown[] } {
  return Array.isArray(schema.allOf) && schema.allOf.length > 0;
}

/**
 * A schema's own union beside its `allOf` is one more allOf member: the value satisfies the allOf members and the union
 * (JSON Schema AND), so the one resolver reads it as it reads a union member. A schema with both `oneOf` and `anyOf` is already
 * an allOf of the two here (`normalizeSchemaUnions`).
 */
function withOwnUnionsAsMembers(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!hasAllOfMembers(schema)) return schema;
  const { oneOf, anyOf, discriminator, ...rest } = schema;
  const key = oneOf === undefined ? 'anyOf' : 'oneOf';
  if (schema[key] === undefined) return schema;
  return { ...rest, allOf: [...schema.allOf, { [key]: schema[key], ...(discriminator === undefined ? {} : { discriminator }) }] };
}

/**
 * `type: array` or `[array, null]`, or no `type` beside `prefixItems` or `items`. Without a `type`, `properties`
 * or `additionalProperties` make the schema an object, as the wire type reads it.
 */
/** A tuple (prefixItems) or an array (items) schema: each prefix item converts by its own schema, and `items` converts the rest. */
function sequenceConversionDescriptor(
  schema: Readonly<Record<string, unknown>>,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  direction: 'from' | 'to',
  seen: ReadonlySet<unknown>,
): ModelTypeDescriptor | undefined {
  if (!isSequenceSchema(schema)) return undefined;
  const sequence = sequenceBodyDescriptor(schema, definitions, env, direction, seen);
  return sequence && admitsNull(schema) ? { kind: 'union', variants: [sequence, { kind: 'null' }] } : sequence;
}

function sequenceBodyDescriptor(
  schema: Readonly<Record<string, unknown>>,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  direction: 'from' | 'to',
  seen: ReadonlySet<unknown>,
): ModelTypeDescriptor | undefined {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((item) => modelConversionDescriptor(item, definitions, env, direction, seen));
    return schema.items === false
      ? { kind: 'tuple', items }
      : {
        kind: 'tuple',
        items,
        rest: {
          index: items.length,
          item: schema.items === undefined ? { kind: 'unknown' } : modelConversionDescriptor(schema.items, definitions, env, direction, seen),
        },
      };
  }
  if (schema.items) {
    return { kind: 'array', item: modelConversionDescriptor(schema.items, definitions, env, direction, seen) };
  }
  return undefined;
}

/** The schema converts by its own keywords: array items, oneOf, anyOf, properties or additionalProperties. */
function hasOwnConversionKeywords(schema: Readonly<Record<string, unknown>>): boolean {
  return isSequenceSchema(schema) || Boolean(schema.oneOf || schema.anyOf || schema.properties)
    || schema.additionalProperties !== undefined;
}

export function modelConversionDescriptor(
  schema: unknown,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  direction: 'from' | 'to' = 'from',
  visiting: ReadonlySet<unknown> = new Set(),
  nullThroughReference = true,
  position: 'field' | 'definition' = 'field',
): ModelTypeDescriptor {
  const nested = withSchemaBase(env, schema);
  const reference = modelSchemaReference(schema, nested);
  if (reference && definitions.has(reference)) {
    const generated: ModelTypeDescriptor = { kind: 'generated-model', id: reference };
    return (nullThroughReference ? admitsNullThroughReference(schema, reference, definitions) : admitsNull(asRecord(schema)))
      ? { kind: 'union', variants: [generated, { kind: 'null' }] }
      : generated;
  }
  const alias = reference ? definitions.aliases.get(reference) : undefined;
  if (alias) {
    const projection: ModelTypeDescriptor = { kind: 'reference', name: alias.name, projection: true };
    return admitsNull(asRecord(schema)) ? { kind: 'union', variants: [projection, { kind: 'null' }] } : projection;
  }
  if (visiting.has(schema)) throw new Error('Internal error: a schema reaches itself without a named recursive alias.');
  const seen = new Set(visiting).add(schema);
  const target = componentSchemaTarget(schema, nested);
  if (target !== undefined && target !== schema) return modelConversionDescriptor(target, definitions, nested, direction, seen);
  const temporal = temporalFormat(schema, env);
  if (temporal) {
    const value = {
      kind: 'class-value', typeName: temporal.typeName,
      serde: { id: `${TEMPORAL_SERDE_PREFIX}${temporal.codec}`, wireDescriptor: { kind: 'string' as const } },
    } as unknown as ModelTypeDescriptor;
    return admitsNull(asRecord(schema)) ? { kind: 'union', variants: [value, { kind: 'null' }] } : value;
  }
  if (isJsonObject(schema) && schema.format === 'date-time'
    && (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string')))) {
    const date: ModelTypeDescriptor = { kind: 'date' };
    return admitsNull(schema)
      ? { kind: 'union', variants: [date, { kind: 'null' }] } : date;
  }
  if (isJsonObject(schema) && hasAllOfMembers(schema)) {
    const composition = resolvedComposition(schema, definitions, env, direction, seen, position);
    if (composition.kind === 'object') return objectCompositionDescriptor(composition);
    if (composition.kind === 'inherits') return composition.descriptor;
    if (composition.kind === 'variants') {
      const variants = composition.variants.map(objectCompositionDescriptor);
      const declaredKey = asRecord(composition.union.discriminator).propertyName;
      const discriminator = unionDiscriminatorTable(composition.union, composition.items, definitions, composition.scope)
        ?? untaggedUnionTable(variants, definitions, typeof declaredKey === 'string' ? declaredKey : undefined);
      return { kind: 'union', variants, ...(discriminator ? { discriminator } : {}) };
    }
    const members = schema.allOf.map((item) => modelConversionDescriptor(item, definitions, nested, direction, seen));
    // Deciding members win. Members that only constrain, or restate an array without converting it, leave the schema's own
    // array, oneOf, anyOf and properties keywords to convert the field; the constraints join that descriptor.
    const deciding = members.filter(isDecidingPart);
    // A deciding member makes the schema's own union one more member; constraint-only members leave the union to convert it.
    const allOf = withOwnUnionsAsMembers(schema);
    if (allOf !== schema && deciding.length > 0) return modelConversionDescriptor(allOf, definitions, env, direction, seen, nullThroughReference, position);
    if (deciding.length === 0 && hasOwnConversionKeywords(schema)) {
      return joinMembers([
        modelConversionDescriptor(ownKeywords(schema), definitions, nested, direction, seen),
        ...members.filter(isConstraintOnlyPart),
      ]);
    }
    return joinMembers(deciding.length ? members.filter((part) => isConstraintOnlyPart(part) || isDecidingPart(part)) : members);
  }
  const sequence = isJsonObject(schema) ? sequenceConversionDescriptor(schema, definitions, nested, direction, seen) : undefined;
  if (sequence) return sequence;
  if (isJsonObject(schema) && (schema.oneOf || schema.anyOf)) {
    const variants = unionVariants(schema) ?? [];
    // A nullable array variant is a plain union of its own; its branches join the outer union.
    const convertedVariants = variants.flatMap((item): readonly ModelTypeDescriptor[] => {
      if (isNullBranch(item)) return [{ kind: 'null' }];
      // A discriminator needs object variants, so a discriminated union keeps its references non-null.
      const converted = modelConversionDescriptor(item, definitions, nested, direction, seen, !isJsonObject(schema.discriminator));
      return converted.kind === 'union' && converted.discriminator === undefined ? converted.variants : [converted];
    });
    const temporalVariants = convertedVariants.filter(isTemporalDescriptor);
    if (temporalVariants.length) {
      if (temporalVariants.length !== 1 || convertedVariants.some(item => !isTemporalDescriptor(item) && item.kind !== 'null')) {
        throw new Error('A date-time model union must have one Temporal branch and optional null. Ambiguous string branches cannot be converted to Temporal.');
      }
      return { kind: 'union', variants: convertedVariants };
    }
    const dateVariants = convertedVariants.filter(item => item.kind === 'date');
    if (dateVariants.length) {
      if (dateVariants.length !== 1 || convertedVariants.some(item => item.kind !== 'date' && item.kind !== 'null')) {
        throw new Error('A date-time model union must have one date-time branch and optional null. Ambiguous string branches cannot be converted to Date.');
      }
      return { kind: 'union', variants: convertedVariants };
    }
    const modelReferences = variants
      .map((item) => directComponentSchemaRef(item, nested))
      .filter((name): name is string => Boolean(name && definitions.has(name)));
    const permitsNull = variants.some((item) =>
      isJsonObject(item) &&
      (item.type === 'null' || (Array.isArray(item.type) && item.type.includes('null')))
    );
    // A reference with only null beside it is that model; any other branch (a string) stays a union branch.
    const onlyModelOrNull = convertedVariants.every((item) => item.kind === 'generated-model' || item.kind === 'null');
    if (modelReferences.length === 1 && onlyModelOrNull && (permitsNull || direction === 'to') && !isJsonObject(schema.discriminator)) {
      const id = modelReferences[0];
      if (!id) return { kind: 'unknown' };
      return permitsNull ? {
        kind: 'union',
        variants: [
          { kind: 'generated-model', id },
          { kind: 'null' },
        ],
      } : { kind: 'generated-model', id };
    }
    // A discriminator keeps even a one-variant union a tagged union.
    // A discriminator the document does not resolve to model variants (inline objects, a scalar beside the models) tags like a union without one.
    const declaredKey = asRecord(schema.discriminator).propertyName;
    const discriminator = unionDiscriminatorTable(schema, variants, definitions, nested)
      ?? untaggedUnionTable(convertedVariants, definitions, typeof declaredKey === 'string' ? declaredKey : undefined);
    if (convertedVariants.length === 1 && !discriminator) {
      const [only] = convertedVariants;
      if (only) return only;
    }
    if (convertedVariants.length > 1 || discriminator) {
      return { kind: 'union', variants: convertedVariants, ...(discriminator ? { discriminator } : {}) };
    }
  }
  if (isJsonObject(schema) && (schema.properties || schema.additionalProperties !== undefined)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    const empty = objectEntries(schema.properties).filter(([name, child]) => required.includes(name) && acceptsNoValue(child)).map(([name]) => name);
    if (empty.length > 0) {
      throw new CompositionError(COMPOSITION_UNSATISFIABLE, `No object satisfies this schema: the required ${empty.length > 1 ? 'properties' : 'property'} ${empty.map((name) => JSON.stringify(name)).join(', ')} accept${empty.length > 1 ? '' : 's'} no value, because the schema is an empty enum, \`not: true\` or \`false\`. Remove ${empty.length > 1 ? 'them' : 'it'} from required, or give ${empty.length > 1 ? 'them' : 'it'} a schema that accepts a value.`);
    }
    const object: ModelTypeDescriptor = {
      kind: 'object',
      properties: Object.fromEntries(objectEntries(schema.properties).map(([name, child]) => [name, modelConversionDescriptor(child, definitions, nested, direction, seen)])),
      required,
      additionalProperties: schema.additionalProperties === false
        ? false
        : isJsonObject(schema.additionalProperties)
          ? modelConversionDescriptor(schema.additionalProperties, definitions, nested, direction, seen)
          : true,
      ...(schema.additionalProperties === true ? { additionalPropertiesDeclared: true as const } : {}),
    };
    return admitsNull(schema) ? { kind: 'union', variants: [object, { kind: 'null' }] } : object;
  }
  if (isJsonObject(schema) && schema.const !== undefined
    && (typeof schema.const === 'string' || typeof schema.const === 'number' || typeof schema.const === 'boolean')) {
    return { kind: 'literal', value: schema.const };
  }
  if (isJsonObject(schema)) {
    const listed = openApiEnumDescriptor(schema);
    if (listed) return withOpenApiConstraints(listed, schema);
  }
  if (isJsonObject(schema)) {
    const primitive = openApiPrimitiveDescriptor(schema);
    if (primitive) {
      const constrained = withOpenApiConstraints(primitive, schema);
      return withOpenApiEnum(admitsNull(schema)
        ? { kind: 'union', variants: [constrained, { kind: 'null' }] }
        : constrained, schema);
    }
    const constraints = openApiKeywordConstraints(schema);
    if (constraints || Array.isArray(schema.enum)) return withOpenApiEnum({ kind: 'unknown', ...(constraints ? { constraints } : {}) }, schema);
  }
  return { kind: 'unknown' };
}

/** A composition error that names the component, or the inline schema, whose conversion stopped. */
export function locatedCompositionError(owner: string | CompositionSite, error: CompositionError): LocatedError {
  const site = typeof owner === 'string' ? componentSite(owner) : owner;
  const where = site.where('');
  return new LocatedError(`${where}: ${error.message}`, site.origins(where), { cause: error });
}

/** An allOf that no object satisfies, or whose members convert one value in two ways: generation stops with its code. */
export class CompositionError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function compositionReader(
  definitions: ModelDefinitions,
  direction: 'from' | 'to',
  seen: ReadonlySet<unknown>,
): CompositionReader<ModelResolveEnv> {
  return {
    reference(schema, env) {
      const nested = withSchemaBase(env, schema);
      const name = directComponentSchemaRef(schema, nested);
      const target = name ? componentSchemaTarget(schema, nested) : undefined;
      return name && target !== undefined ? { name, referenced: target, scope: nested, model: definitions.has(name) } : undefined;
    },
    nested: (schema, env) => withSchemaBase(env, schema),
    descriptor: (schema, env) => seen.has(schema) ? undefined : modelConversionDescriptor(schema, definitions, env, direction, seen),
    ...declaredModelBases(definitions),
  };
}

function resolvedComposition(
  schema: Readonly<Record<string, unknown>>,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  direction: 'from' | 'to',
  seen: ReadonlySet<unknown>,
  position: 'field' | 'definition',
): Composition<ModelResolveEnv> {
  const composition = resolveComposition(schema, env, compositionReader(definitions, direction, seen), position);
  if (composition.kind === 'rejected') throw new CompositionError(composition.code, composition.message);
  return composition;
}

type ObjectComposition = Extract<Composition<ModelResolveEnv>, { readonly kind: 'object' }>;

function objectCompositionDescriptor(composition: ObjectComposition): ModelTypeDescriptor {
  const { extra } = composition;
  const object: ModelTypeDescriptor = {
    kind: 'object',
    properties: Object.fromEntries(Object.entries(composition.slots).map(([name, child]) => [name, child.descriptor])),
    required: composition.required,
    additionalProperties: extra.mode === 'values' ? extra.child.descriptor : extra.mode === 'open',
    ...(extra.mode === 'open' && composition.declaredOpen ? { additionalPropertiesDeclared: true as const } : {}),
    ...(composition.constraints.length ? { constraints: composition.constraints } : {}),
  };
  return composition.nullable ? { kind: 'union', variants: [object, { kind: 'null' }] } : object;
}

/** Where the schemas of a component sit: its name, and the bundled component an error names. */
export function componentSite(name: string): CompositionSite {
  return {
    where: (pointer) => `schema ${JSON.stringify(name)} at #/components/schemas/${escapeJsonPointerToken(name)}${pointer}`,
    origins: (where) => [componentOrigin('schemas', name, where)],
  };
}

const UNSELECTED_VARIANT = 'OPENAPI_DISCRIMINATOR_VARIANT_UNSELECTED';

/**
 * Resolve an OAS discriminator into the value → variant model table. Mapping
 * values are component names or references; a variant without a mapping key
 * is selected by its raw component name (the implicit mapping). A `defaultMapping`
 * names the one variant that has no values and may lack the tag property.
 */
export function discriminatorSelection(
  schemaName: string,
  schema: unknown,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  warn: (code: string, message: string) => void,
): DiscriminatorSelection | undefined {
  if (!isJsonObject(schema) || !isJsonObject(schema.discriminator)) return undefined;
  const { propertyName: property, mapping, defaultMapping } = schema.discriminator;
  if (typeof property !== 'string') return undefined;
  const items = unionVariants(schema) ?? [];
  const nested = withSchemaBase(env, schema);
  const variants = new Map<string, { readonly schemaName: string; readonly values: string[] }>();
  for (const item of items) {
    // A null branch carries no tag; the table covers the model variants.
    if (isNullBranch(item)) continue;
    const target = exactComponentTarget(item, nested);
    // Only model components can carry a narrowed tag; other unions keep their schema.
    if (!target || !definitions.has(target.typeName)) return undefined;
    variants.set(target.typeName, { schemaName: target.schemaName, values: [] });
  }
  if (variants.size === 0) return undefined;
  const componentNames = new Set(Object.keys(asRecord(asRecord(asRecord(env.document).components).schemas)));
  const variantOf = (target: unknown): { readonly typeName: string; readonly variant: { readonly values: string[] } } | undefined => {
    const reference = typeof target === 'string' && componentNames.has(target)
      ? `#/components/schemas/${encodeURIComponent(target)}`
      : target;
    const resolved = typeof reference === 'string'
      ? resolveExactComponent(reference, nested.currentBase, nested.resources, nested.document)
      : null;
    const variant = resolved ? variants.get(resolved.typeName) : undefined;
    return resolved && variant ? { typeName: resolved.typeName, variant } : undefined;
  };
  const defaultVariant = defaultMapping === undefined ? undefined : variantOf(defaultMapping)?.typeName;
  if (defaultMapping !== undefined && defaultVariant === undefined) {
    const named = `schema ${JSON.stringify(schemaName)}`;
    throw new LocatedError(
      `discriminator defaultMapping of ${named} targets ${JSON.stringify(defaultMapping)}, which is not one of its variants`,
      [componentOrigin('schemas', schemaName, named)],
    );
  }
  for (const typeName of variants.keys()) {
    const variant = definitions.get(typeName);
    // OAS: the discriminator property must be declared by every schema it selects, except the default (3.2 defaultMapping).
    if (variant && typeName !== defaultVariant && !modelSchemaProperties(nested, variant.rawSchema).has(property)) {
      const named = `schema ${JSON.stringify(schemaName)}`;
      const variantNamed = `variant ${JSON.stringify(variant.schemaName)}`;
      throw new LocatedError(
        `discriminator property ${JSON.stringify(property)} of ${named} is not declared by ${variantNamed}`,
        [componentOrigin('schemas', schemaName, named), componentOrigin('schemas', variant.schemaName, variantNamed)],
      );
    }
  }
  for (const [value, target] of objectEntries(mapping)) {
    const resolved = variantOf(target);
    if (!resolved) {
      const named = `schema ${JSON.stringify(schemaName)}`;
      throw new LocatedError(
        `discriminator mapping ${JSON.stringify(value)} of ${named} targets ${JSON.stringify(target)}, which is not one of its variants`,
        [componentOrigin('schemas', schemaName, named)],
      );
    }
    // The default takes every unmatched value, a mapped one included, so it keeps no value of its own.
    if (resolved.typeName !== defaultVariant) resolved.variant.values.push(value);
  }
  const selected = new Map<string, string>();
  const mapped = new Set(objectEntries(mapping).map(([value]) => value));
  for (const [typeName, variant] of variants) {
    if (typeName === defaultVariant) continue;
    // A value names its component "unless a mapping is present for that value" (OpenAPI 3.1 and 3.2, Discriminator Object):
    // the rule is per value, so any mapping key equal to the component name replaces it, whichever variant the key targets
    // (the default included). A variant left with no value is selected by no tag value.
    if (mapped.has(variant.schemaName)) continue;
    if (variant.values.length === 0 && variant.schemaName !== typeName) {
      warn('OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE', `schema ${JSON.stringify(schemaName)} selects ${typeName} by the implicit discriminator value ${JSON.stringify(variant.schemaName)} (the raw component name, not the generated name ${JSON.stringify(typeName)})`);
    }
    variant.values.push(variant.schemaName);
  }
  for (const [typeName, variant] of variants) {
    for (const value of variant.values) {
      const previous = selected.get(value);
      if (previous !== undefined && previous !== typeName) {
        const named = `schema ${JSON.stringify(schemaName)}`;
        throw new LocatedError(
          `discriminator value ${JSON.stringify(value)} of ${named} selects both ${previous} and ${typeName}`,
          [componentOrigin('schemas', schemaName, named)],
        );
      }
      selected.set(value, typeName);
    }
  }
  for (const [typeName, variant] of variants) {
    if (typeName === defaultVariant || variant.values.length > 0) continue;
    // Its component name went to the mapping key of the same text, and no other key selects it.
    const key = variant.schemaName;
    const named = `schema ${JSON.stringify(schemaName)}`;
    throw new LocatedError(
      `${UNSELECTED_VARIANT}: no discriminator value of ${named} selects ${typeName}: the mapping key ${JSON.stringify(key)} sends that value to ${JSON.stringify(asRecord(mapping)[key])}. `
      + 'Give the variant a mapping value of its own, or remove it from the union',
      [componentOrigin('schemas', schemaName, named)],
    );
  }
  return { propertyName: property, variants: selected, ...(defaultVariant === undefined ? {} : { defaultVariant }) };
}

function isNullBranch(schema: unknown): boolean {
  return isJsonObject(schema) && schema.type === 'null';
}

function exactComponentTarget(schema: unknown, env: ModelResolveEnv): ExactComponentTarget | null {
  if (!isJsonObject(schema)) return null;
  const base = nextSchemaBase(schema, env.currentBase, env.resources);
  const reference = typeof schema.$ref === 'string' ? schema.$ref : typeof schema.$dynamicRef === 'string' ? schema.$dynamicRef : null;
  return reference ? resolveExactComponent(reference, base, env.resources, env.document) : null;
}

/** Where a checked schema sits, for the error that names it. */
export interface CompositionSite {
  /** The place of `pointer`, a JSON Pointer inside the schema. */
  where(pointer: string): string;
  /** The bundled components that the place names, so the error can append where each came from. */
  origins(where: string): readonly ReturnType<typeof componentOrigin>[];
}

/**
 * Stops generation for an allOf that no object satisfies or that converts one property differently, and warns about each
 * property that no value can hold. Reads every schema inside the root, so the error names the schema's pointer. Such
 * a property of a model component becomes `never`, so its class field passes the value through. A component that is not
 * a model (an array or a union) is read at field position, as the schemas that refer to it read it.
 */
export function checkComposition(
  site: CompositionSite,
  rawSchema: unknown,
  definition: ModelDefinition | undefined,
  definitions: ModelDefinitions,
  document: unknown,
  resources: ResourceIndex | undefined,
  warn: (code: string, message: string) => void,
  env: ModelResolveEnv = modelEnv(document, undefined, undefined, resources),
): void {
  const visit = (schema: unknown, scope: ModelResolveEnv, position: 'field' | 'definition', pointer: string): void => {
    if (!isJsonObject(schema) || directComponentSchemaRef(schema, withSchemaBase(scope, schema))) return;
    const where = site.where(pointer);
    if (hasAllOfMembers(schema)) {
      let composition: Composition<ModelResolveEnv>;
      try {
        composition = resolvedComposition(schema, definitions, scope, 'to', new Set([schema]), position);
      } catch (error) {
        if (!(error instanceof CompositionError)) throw error;
        throw new LocatedError(`${where}: ${error.message}`, site.origins(where), { cause: error });
      }
      for (const never of neverNames(composition)) {
        warn(COMPOSITION_PROPERTY_NEVER, `Property ${JSON.stringify(never.name)} of ${where} ${neverReason(never)}`);
        if (position === 'definition' && definition?.properties.has(never.name)) definition.properties.set(never.name, false);
      }
    }
    const nested = withSchemaBase(scope, schema);
    for (const [name, child] of objectEntries(schema.properties)) visit(child, nested, 'field', `${pointer}/properties/${escapeJsonPointerToken(name)}`);
    for (const keyword of ['items', 'additionalProperties', 'unevaluatedProperties'] as const) {
      visit(schema[keyword], nested, 'field', `${pointer}/${keyword}`);
    }
    for (const keyword of ['prefixItems', 'allOf', 'oneOf', 'anyOf'] as const) {
      const items = schema[keyword];
      if (Array.isArray(items)) items.forEach((item, index) => visit(item, nested, 'field', `${pointer}/${keyword}/${index}`));
    }
  };
  visit(rawSchema, env, definition ? 'definition' : 'field', '');
}

/**
 * The OAS discriminator as the shared union descriptor's tag table: entry i
 * lists the values that select variant i. Variant models keep their own
 * declared tag type.
 */
function unionDiscriminatorTable(
  schema: Readonly<Record<string, unknown>>,
  items: readonly unknown[],
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
): UnionDiscriminator | undefined {
  if (!isJsonObject(schema.discriminator)) return undefined;
  let selection = env.selections?.get(schema);
  if (selection === undefined) {
    // An inline union: component unions were resolved and diagnosed up front.
    selection = discriminatorSelection('<inline>', schema, definitions, env, () => undefined) ?? null;
    env.selections?.set(schema, selection);
  }
  if (!selection) return undefined;
  const byVariant = selection.variants;
  const variants = items.map((item) => {
    if (isNullBranch(item)) return { values: [] };
    const typeName = exactComponentTarget(item, env)?.typeName;
    return { values: [...byVariant].filter(([, variant]) => variant === typeName).map(([value]) => value) };
  });
  const defaultAt = selection.defaultVariant === undefined
    ? -1
    : items.findIndex((item) => exactComponentTarget(item, env)?.typeName === selection.defaultVariant);
  return { propertyName: selection.propertyName, variants, ...(defaultAt < 0 ? {} : { defaultVariant: defaultAt }) };
}

type TagValues = ReadonlyMap<string, readonly (string | number | boolean)[]>;

/** The values of a `const`, or of a union of `const`s. */
function literalTagValues(descriptor: ModelTypeDescriptor | undefined): readonly (string | number | boolean)[] | undefined {
  if (descriptor?.kind === 'literal') return [descriptor.value];
  if (descriptor?.kind !== 'union' || descriptor.variants.length === 0) return undefined;
  const values: (string | number | boolean)[] = [];
  for (const variant of descriptor.variants) {
    if (variant.kind !== 'literal') return undefined;
    values.push(variant.value);
  }
  return values;
}

/** The required properties of an inline object variant that hold only literals, in the order the object requires them. */
function objectTagValues(object: Extract<ModelTypeDescriptor, { readonly kind: 'object' }>): TagValues {
  const tags = new Map<string, readonly (string | number | boolean)[]>();
  for (const name of object.required) {
    const values = literalTagValues(object.properties[name]);
    if (values) tags.set(name, values);
  }
  return tags;
}

/**
 * The same, for a component model, read from its schema: a `const`, or a oneOf or anyOf of `const`s. A model's own descriptor is not
 * converted here, because a model whose property is this union would convert itself again.
 */
function modelTagValues(definition: ModelDefinition | undefined): TagValues | undefined {
  if (!definition || definition.isUnion) return undefined;
  const tags = new Map<string, readonly (string | number | boolean)[]>();
  for (const name of definition.required) {
    const property = definition.properties.get(name);
    const members = isJsonObject(property) && !('const' in property) ? unionVariants(property) : undefined;
    const values = (members ?? [property]).map((member) => isJsonObject(member) ? member.const : undefined);
    if (values.length > 0 && values.every((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      tags.set(name, values as readonly (string | number | boolean)[]);
    }
  }
  return tags;
}

/**
 * The tag table of a oneOf or anyOf that has no `discriminator` keyword: the first property of the first object variant that every
 * variant requires as a literal, when no value belongs to two variants. When a variant is neither an inline object nor a model, the
 * object variants alone are tagged and the others get no values. Without such a property the union keeps no table, except for one
 * model beside tagged objects: that model is the default variant and takes every object whose tag selects no object. `declared` is
 * the `propertyName` of a discriminator keyword the document wrote: then only that key tags the variants.
 */
function untaggedUnionTable(variants: readonly ModelTypeDescriptor[], definitions: ModelDefinitions, declared?: string): UnionDiscriminator | undefined {
  if (variants.length < 2) return undefined;
  const tagsOf = (variant: ModelTypeDescriptor): TagValues | undefined =>
    variant.kind === 'object' ? objectTagValues(variant) : variant.kind === 'generated-model' ? modelTagValues(definitions.get(variant.id)) : undefined;
  const present = variants.flatMap((variant, index) => variant.kind === 'null' ? [] : [{ index, tags: tagsOf(variant), variant }]);
  type Member = (typeof present)[number];
  // The first key that every member requires as a literal, with no value in two members, and the table it gives.
  const tableOf = (members: readonly Member[]): UnionDiscriminator | undefined => {
    for (const propertyName of declared === undefined ? members[0]?.tags?.keys() ?? [] : [declared]) {
      const values = members.map(({ tags }) => tags?.get(propertyName) ?? []);
      const flat = values.flat();
      if (values.some((set) => set.length === 0) || new Set(flat).size !== flat.length) continue;
      return { propertyName, variants: variants.map((_, index) => ({ values: values[members.findIndex((item) => item.index === index)] ?? [] })) };
    }
    return undefined;
  };
  const tagged = present.every(({ tags }) => tags) ? present : present.filter(({ variant }) => variant.kind === 'object');
  if (tagged.length === 0) return undefined;
  const table = tableOf(tagged);
  if (table) return table;
  // One model with no tag beside objects that share a tag is the default variant: it takes every object the tag does not select.
  const objects = present.filter(({ variant }) => variant.kind === 'object');
  const models = present.filter(({ variant }) => variant.kind === 'generated-model');
  if (models.length !== 1 || objects.length === 0 || objects.length + models.length !== present.length) return undefined;
  const objectTable = tableOf(objects);
  return objectTable && { ...objectTable, defaultVariant: models[0]!.index };
}

interface SchemaGraphGroup {
  readonly id: string;
  readonly filename: string;
  readonly nodes: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
}

export interface SchemaGraphGrouping {
  readonly groups: readonly SchemaGraphGroup[];
  readonly owner: ReadonlyMap<string, string>;
  readonly runtimeEdges: ReadonlyMap<string, ReadonlySet<string>>;
}
