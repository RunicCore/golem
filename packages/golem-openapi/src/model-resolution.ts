import { descriptorNeedsConversion } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph, SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelConstraint, ModelTypeDescriptor, UnionDiscriminator } from '@exprtlabs/golem/model';
import { asRecord, escapeJsonPointerToken, isJsonObject, objectEntries } from './json.js';
import { identifier, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { componentOrigin, LocatedError } from './origin.js';
import {
  COMPOSITION_PROPERTY_NEVER,
  composedRequired,
  isConstraintOnlyPart,
  isSequenceSchema,
  joinMembers,
  neverNames,
  neverReason,
  ownKeywords,
  resolveComposition,
  type Composition,
  type CompositionReader,
  type SlotChild,
} from './composition.js';
import { effectiveSchemaTypes } from './normalize.js';
import { code, identifier as identifierPart, join, propertyKey, type Code } from '@exprtlabs/golem/internal/emitter';
import { orNull, prefixItemsType, schemaContext, schemaTypeCode, typeCode, type SchemaTypeContext, type TypeCode } from './types.js';
import {
  collectCanonicalResources,
  nextSchemaBase,
  resolveExactComponent,
  schemaDocumentBase,
  type ExactComponentTarget,
  type ResourceIndex,
} from './schema-projection.js';

export interface ModelDefinition {
  readonly name: string;
  readonly schemaName: string;
  readonly schema: unknown;
  readonly rawSchema: unknown;
  /** The model that the generated class extends: the first model `$ref` of the allOf. */
  baseName: string | null;
  /** The other models the allOf refers to; their fields are in `properties`, and a slot narrows each of them. */
  otherBaseNames: readonly string[];
  /** The union models that select this model as a variant. It narrows each of them, also when it does not extend them. */
  variantOf: string[];
  properties: Map<string, unknown>;
  additionalProperties: unknown;
  required: Set<string>;
  variants?: readonly string[];
  /** The variants of a union that another union also selects. They extend their own base, so the union class answers `instanceof` for them. */
  sharedVariants?: readonly string[];
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
  /** Whether it reaches a date or a model: its model type is then a private alias of the owner group, not `Types.<Name>`. */
  convertsValue?: boolean;
  /** Whether a model sits inside it: its init is then a function of the owner group. */
  initsModel?: boolean;
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
  /** How the module that holds the code names types of other modules; without it, the types namespace is the local name `Types`. */
  readonly names?: ModelNames;
}

/** What a module decides about the names its model code writes: each is a local name, or a part imported from the module that holds it. */
export interface ModelNames {
  /** The namespace the module imports `types.ts` under. */
  readonly types: Code;
  /** The class of the model `reference`. */
  readonly model: (reference: string) => Code;
  /** The fields type of the model `reference`. */
  readonly fields: (reference: string) => Code;
  /** The init type of the model `reference`. */
  readonly init: (reference: string) => Code;
  /** The model-layer type of a recursive alias that reaches a date or a model. */
  readonly aliasType: (alias: RecursiveAlias) => Code;
}

export const LOCAL_NAMES: ModelNames = {
  types: identifierPart('Types'),
  model: (reference) => identifierPart(`${reference}Model`),
  fields: (reference) => identifierPart(`${reference}Fields`),
  init: (reference) => identifierPart(`${reference}Init`),
  aliasType: (alias) => identifierPart(aliasModelTypeName(alias)),
};

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
  names?: ModelNames,
): ModelResolveEnv {
  return {
    document,
    dates,
    resources: resources ?? collectCanonicalResources(document),
    currentBase: currentBase ?? schemaDocumentBase(document),
    anchors,
    selections,
    ...(names ? { names } : {}),
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

function typeContext(env: ModelResolveEnv): SchemaTypeContext {
  return {
    qualifier: code`${(env.names ?? LOCAL_NAMES).types}.`,
    anchors: env.anchors,
    document: env.document,
    resources: env.resources,
    currentBase: env.currentBase,
  };
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

export function modelSchemaProperties(
  env: ModelResolveEnv,
  rawSchema: unknown,
  inheritedSchemaName: string | null = null,
): Map<string, unknown> {
  const properties = new Map<string, unknown>();
  const visiting = new Set<string>();
  const visit = (schema: unknown, current: ModelResolveEnv): void => {
    if (!isJsonObject(schema)) return;
    const nested = withSchemaBase(current, schema);
    const reference = directComponentSchemaRef(schema, nested);
    if (reference) {
      if (reference === inheritedSchemaName || visiting.has(reference)) return;
      const target = componentSchemaTarget(schema, nested);
      if (!target) return;
      visiting.add(reference);
      visit(target, nested);
      visiting.delete(reference);
      return;
    }
    for (const item of Array.isArray(schema.allOf) ? schema.allOf : []) visit(item, nested);
    for (const [name, property] of objectEntries(schema.properties)) {
      properties.set(name, property);
    }
  };
  visit(rawSchema, env);
  return properties;
}

/** The environment a component's own schema is read in: its anchors, and the analysis' dates and discriminator tables. */
export function componentEnv(env: ModelResolveEnv, schemaName: string, rawSchema: unknown): ModelResolveEnv {
  const anchors = schemaContext(env.document, schemaContext(env.document, { resources: env.resources }), schemaName, rawSchema).anchors;
  return modelEnv(env.document, undefined, anchors, env.resources, env.selections, env.dates, env.names);
}

/** The conversion descriptor of a recursive alias: each use of a recursive component, itself included, is a projection reference. */
export function aliasDescriptor(alias: RecursiveAlias, definitions: ModelDefinitions, env: ModelResolveEnv): ModelTypeDescriptor {
  alias.descriptor ??= modelConversionDescriptor(alias.rawSchema, definitions, componentEnv(env, alias.schemaName, alias.rawSchema), 'to', new Set(), true, 'definition');
  return alias.descriptor;
}

/** Whether a use of the alias converts a value (it reaches a date, a serde value or a model); if not, its model type is its wire type. */
export function aliasConvertsValue(alias: RecursiveAlias, definitions: ModelDefinitions, env: ModelResolveEnv): boolean {
  alias.convertsValue ??= descriptorNeedsConversion(
    { kind: 'reference', name: alias.name, projection: true },
    (name) => {
      const held = definitions.aliases.get(name);
      return held ? aliasDescriptor(held, definitions, env) : undefined;
    },
  );
  return alias.convertsValue;
}

/** The model-layer type of an alias that reaches a date or a model. */
export function aliasModelTypeName(alias: RecursiveAlias): string {
  return `${alias.name}Fields`;
}

/** The type of a use of a recursive alias in the model layer. */
export function aliasUseType(alias: RecursiveAlias, definitions: ModelDefinitions, env: ModelResolveEnv): Code {
  const names = env.names ?? LOCAL_NAMES;
  return aliasConvertsValue(alias, definitions, env) ? names.aliasType(alias) : code`${names.types}.${identifierPart(alias.name)}`;
}

/** Every model that the definition narrows: its class base, the other refs of its allOf, and the unions that select it. */
export function modelBases(definition: ModelDefinition | undefined): readonly string[] {
  return definition ? [...(definition.baseName ? [definition.baseName] : []), ...definition.otherBaseNames, ...definition.variantOf] : [];
}

export function modelSchemaReference(schema: unknown, env: ModelResolveEnv): string | null {
  return directComponentSchemaRef(schema, withSchemaBase(env, schema));
}

/** The type of a model field, as the code of the model layer writes it. */
export function modelFieldType(
  schema: unknown,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  visiting: ReadonlySet<unknown> = new Set(),
  nullThroughReference = true,
): Code {
  return modelFieldTypeNode(schema, definitions, env, visiting, nullThroughReference).code;
}

/** `T | null` when `nullable`. */
function nullableType(type: TypeCode, nullable: boolean): TypeCode {
  return nullable ? orNull(type) : type;
}

/** The members in parentheses, joined by `|`. */
function parenthesizedUnion(members: readonly TypeCode[]): TypeCode {
  return typeCode(join(members.map((member) => code`(${member.code})`), code` | `), members.length > 1 ? 'union' : 'primary');
}

function modelFieldTypeNode(
  schema: unknown,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  visiting: ReadonlySet<unknown> = new Set(),
  nullThroughReference = true,
): TypeCode {
  const nested = withSchemaBase(env, schema);
  const reference = modelSchemaReference(schema, nested);
  if (reference && definitions.has(reference)) {
    const nullable = nullThroughReference ? admitsNullThroughReference(schema, reference, definitions) : admitsNull(asRecord(schema));
    return nullableType(typeCode((env.names ?? LOCAL_NAMES).model(reference)), nullable);
  }
  const alias = reference ? definitions.aliases.get(reference) : undefined;
  if (alias) return nullableType(typeCode(aliasUseType(alias, definitions, env)), admitsNull(asRecord(schema)));
  if (visiting.has(schema)) throw new Error('Internal error: a schema reaches itself without a named recursive alias.');
  const seen = new Set(visiting).add(schema);
  const target = componentSchemaTarget(schema, nested);
  if (target !== undefined && target !== schema) return modelFieldTypeNode(target, definitions, nested, seen);
  const temporal = temporalFormat(schema, env);
  if (temporal) return nullableType(typeCode(temporal.type), admitsNull(asRecord(schema)));
  if (isJsonObject(schema) && schema.format === 'date-time'
    && (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string')))) {
    return nullableType(typeCode(code`Date`), admitsNull(schema));
  }
  // The resolver decides an allOf object; otherwise deciding allOf members win, then the schema's own array keywords,
  // then oneOf and anyOf.
  const composition = isJsonObject(schema) ? fieldComposition(schema, definitions, env, 'from', seen) : undefined;
  if (composition?.kind === 'object') return objectCompositionType(composition, definitions, seen);
  if (composition?.kind === 'variants') {
    return parenthesizedUnion(composition.variants.map((variant) => objectCompositionType(variant, definitions, seen)));
  }
  const allOfMembers = isJsonObject(schema) && hasAllOfMembers(schema)
    ? schema.allOf.map((item) => ({ item, descriptor: modelConversionDescriptor(item, definitions, nested, 'from', seen) }))
    : [];
  const decidingMembers = allOfMembers.filter(({ descriptor }) => isDecidingPart(descriptor));
  const [decidingMember] = decidingMembers;
  // A deciding member makes the schema's own union one more member; constraint-only members leave the union to convert it.
  const field = isJsonObject(schema) ? withOwnUnionsAsMembers(schema) : schema;
  if (field !== schema && decidingMembers.length > 0) return modelFieldTypeNode(field, definitions, env, seen, nullThroughReference);
  // One deciding sequence or model reference is the field's type, as it is its conversion (a lone `allOf [$ref Pet]`).
  if (decidingMembers.length === 1 && decidingMember
    && (isSequenceDescriptor(decidingMember.descriptor) || decidingMember.descriptor.kind === 'generated-model')) {
    return modelFieldTypeNode(decidingMember.item, definitions, nested, seen);
  }
  if (isJsonObject(schema) && decidingMembers.length === 0 && isSequenceSchema(schema)) {
    const nullable = admitsNull(schema);
    if (Array.isArray(schema.prefixItems)) {
      return nullableType(prefixItemsType(schema, (item) => modelFieldTypeNode(item, definitions, nested, seen)), nullable);
    }
    if (schema.items) return nullableType(typeCode(code`Array<${modelFieldTypeNode(schema.items, definitions, nested, seen).code}>`), nullable);
  }
  if (isJsonObject(schema) && (schema.oneOf || schema.anyOf)) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
    return parenthesizedUnion(variants
      .map((item) => modelFieldTypeNode(item, definitions, nested, seen, !isJsonObject(schema.discriminator))));
  }
  if (isJsonObject(schema) && (schema.properties || isJsonObject(schema.additionalProperties))) {
    const required = new Set(composedRequired(schema));
    const fields = objectEntries(schema.properties).map(([name, child]) => code`${propertyKey(name)}${required.has(name) ? code`` : code`?`}: ${modelFieldTypeNode(child, definitions, nested, seen).code}`);
    if (isJsonObject(schema.additionalProperties)) fields.push(code`[key: string]: ${fields.length ? code`unknown` : modelFieldTypeNode(schema.additionalProperties, definitions, nested, seen).code}`);
    return nullableType(typeCode(code`{ ${join(fields, code`; `)} }`), admitsNull(schema));
  }
  return schemaTypeCode(schema, typeContext(nested));
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
 * A schema's own `oneOf` and `anyOf` beside its `allOf` are two more allOf members: the value satisfies the allOf members and
 * the union (JSON Schema AND), so the one resolver reads them as it reads a union member.
 */
function withOwnUnionsAsMembers(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!hasAllOfMembers(schema) || (schema.oneOf === undefined && schema.anyOf === undefined)) return schema;
  const { oneOf, anyOf, discriminator, ...rest } = schema;
  const unions = [
    ...(oneOf === undefined ? [] : [{ oneOf, ...(discriminator === undefined ? {} : { discriminator }) }]),
    ...(anyOf === undefined ? [] : [{ anyOf, ...(discriminator === undefined || oneOf !== undefined ? {} : { discriminator }) }]),
  ];
  return { ...rest, allOf: [...schema.allOf, ...unions] };
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
      const discriminator = unionDiscriminatorTable(composition.union, composition.items, definitions, composition.scope);
      return { kind: 'union', variants: composition.variants.map(objectCompositionDescriptor), ...(discriminator ? { discriminator } : {}) };
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
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
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
    const discriminator = unionDiscriminatorTable(schema, variants, definitions, nested);
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
    const primitive = openApiPrimitiveDescriptor(schema);
    if (primitive) {
      const constrained = withOpenApiConstraints(primitive, schema);
      return admitsNull(schema)
        ? { kind: 'union', variants: [constrained, { kind: 'null' }] }
        : constrained;
    }
    const constraints = openApiKeywordConstraints(schema);
    if (constraints) return { kind: 'unknown', constraints };
  }
  return { kind: 'unknown' };
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
    basesOf: (id) => modelBases(definitions.get(id)),
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

function fieldComposition(
  schema: Readonly<Record<string, unknown>>,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  direction: 'from' | 'to',
  seen: ReadonlySet<unknown>,
): Composition<ModelResolveEnv> | undefined {
  return hasAllOfMembers(schema) ? resolvedComposition(schema, definitions, env, direction, seen, 'field') : undefined;
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

function objectCompositionType(
  composition: ObjectComposition,
  definitions: ModelDefinitions,
  seen: ReadonlySet<unknown>,
): TypeCode {
  const childType = (child: SlotChild<ModelResolveEnv>): TypeCode => {
    const types = child.sources.map((source) => modelFieldTypeNode(source.schema, definitions, source.scope, seen));
    const [only, ...more] = types;
    return only === undefined ? typeCode(code`never`) : more.length === 0 ? only : typeCode(join(types.map((type) => code`(${type.code})`), code` & `), 'intersection');
  };
  const required = new Set(composition.required);
  const slots = Object.entries(composition.slots);
  const fields = slots.map(([name, child]) => code`${propertyKey(name)}${required.has(name) ? code`` : code`?`}: ${childType(child).code}`);
  const { extra } = composition;
  if (extra.mode === 'values') {
    // An index signature holds every property: it names the value type when each property has it, else `unknown`.
    const key = JSON.stringify(extra.child.descriptor);
    const uniform = slots.every(([, child]) => JSON.stringify(child.descriptor) === key);
    const optional = slots.some(([name]) => !required.has(name));
    fields.push(code`[key: string]: ${uniform ? code`${childType(extra.child).code}${optional ? code` | undefined` : code``}` : code`unknown`}`);
  }
  return nullableType(typeCode(code`{ ${join(fields, code`; `)} }`), composition.nullable);
}

/** Where the schemas of a component sit: its name, and the bundled component an error names. */
export function componentSite(name: string): CompositionSite {
  return {
    where: (pointer) => `schema ${JSON.stringify(name)} at #/components/schemas/${escapeJsonPointerToken(name)}${pointer}`,
    origins: (where) => [componentOrigin('schemas', name, where)],
  };
}

/**
 * Resolve an OAS discriminator into the value → variant model table. Mapping
 * values are component names or references; a variant without a mapping key
 * is selected by its raw component name (the implicit mapping).
 */
export function discriminatorSelection(
  schemaName: string,
  schema: unknown,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  warn: (code: string, message: string) => void,
): DiscriminatorSelection | undefined {
  if (!isJsonObject(schema) || !isJsonObject(schema.discriminator)) return undefined;
  const { propertyName: property, mapping } = schema.discriminator;
  if (typeof property !== 'string') return undefined;
  const items = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
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
  for (const typeName of variants.keys()) {
    const variant = definitions.get(typeName);
    // OAS: the discriminator property must be declared by every schema it selects.
    if (variant && !modelSchemaProperties(nested, variant.rawSchema).has(property)) {
      const named = `schema ${JSON.stringify(schemaName)}`;
      const variantNamed = `variant ${JSON.stringify(variant.schemaName)}`;
      throw new LocatedError(
        `discriminator property ${JSON.stringify(property)} of ${named} is not declared by ${variantNamed}`,
        [componentOrigin('schemas', schemaName, named), componentOrigin('schemas', variant.schemaName, variantNamed)],
      );
    }
  }
  const componentNames = new Set(Object.keys(asRecord(asRecord(asRecord(env.document).components).schemas)));
  for (const [value, target] of objectEntries(mapping)) {
    const reference = typeof target === 'string' && componentNames.has(target)
      ? `#/components/schemas/${encodeURIComponent(target)}`
      : target;
    const resolved = typeof reference === 'string'
      ? resolveExactComponent(reference, nested.currentBase, nested.resources, nested.document)
      : null;
    const variant = resolved ? variants.get(resolved.typeName) : undefined;
    if (!variant) {
      const named = `schema ${JSON.stringify(schemaName)}`;
      throw new LocatedError(
        `discriminator mapping ${JSON.stringify(value)} of ${named} targets ${JSON.stringify(target)}, which is not one of its variants`,
        [componentOrigin('schemas', schemaName, named)],
      );
    }
    variant.values.push(value);
  }
  const selected = new Map<string, string>();
  for (const [typeName, variant] of variants) {
    if (variant.values.length === 0) {
      variant.values.push(variant.schemaName);
      if (variant.schemaName !== typeName) {
        warn('OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE', `schema ${JSON.stringify(schemaName)} selects ${typeName} by the implicit discriminator value ${JSON.stringify(variant.schemaName)} (the raw component name, not the generated name ${JSON.stringify(typeName)})`);
      }
    }
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
  return { propertyName: property, variants: selected };
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
  visit(rawSchema, modelEnv(document, undefined, undefined, resources), definition ? 'definition' : 'field', '');
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
  return variants.every((variant, index) => variant.values.length > 0 || isNullBranch(items[index]))
    ? { propertyName: selection.propertyName, variants }
    : undefined;
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
