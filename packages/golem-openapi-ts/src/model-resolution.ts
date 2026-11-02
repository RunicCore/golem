import { isDeepStrictEqual } from 'node:util';
import { builtinClassDescriptor, descriptorNeedsConversion } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph, SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import { identifier } from '@exprtlabs/golem/internal/generator-support';
import { asRecord, escapeJsonPointerToken, isJsonObject, objectEntries, type JsonObject } from './json.js';
import type { GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import type { ConstraintSchemaValue, ModelConstraint, ModelTypeDescriptor, UnionDiscriminator } from '@exprtlabs/golem/internal/schema';
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
import { dateClassOf } from './date-class.js';
import { effectiveSchemaTypes } from './normalize.js';
import { schemaContext, typedListedValues, type NeverPropertiesOf } from './types.js';
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
  /** Collects the keywords of the schemas converted under this env that no descriptor carries (see `noteUncarried`); none collects nothing. */
  readonly uncarried?: Set<string>;
  /**
   * What the caller of the next conversion holds of the schema it converts: an allOf `member` (the composition holds its `required` names and its object type),
   * or a keyword's `sub`-schema (`subschemaConverter` holds its `required` names).
   */
  readonly holds?: 'member' | 'sub';
}

/** One schema interned into the graph: the descriptor as the graph received it, before it sealed and rewrote the references of every node to codec ids. */
export interface SchemaGraphInput {
  /** The name the graph interned it under; none for an unnamed object, which the graph names by its shape. */
  readonly name?: string;
  readonly descriptor: ModelTypeDescriptor;
}

/** What the analysis interned into the graph, in order: each model and recursive alias, then the inline value of each operation. */
export interface SchemaGraphInputs {
  readonly models: readonly (SchemaGraphInput & { readonly name: string })[];
  /** By the key of `convertedNodeIds`. A value that names a model (`$ref`) has no input: it is the node of that model. */
  readonly values: ReadonlyMap<string, SchemaGraphInput>;
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
  /** The node of each operation body, stream item, parameter and response header that converts something, by `requestBodyKey`, `responseBodyKey`, `parameterKey` or `responseHeaderKey`; a value that converts nothing has none. */
  readonly convertedNodeIds: ReadonlyMap<string, string>;
  /**
   * The keywords that the descriptors of a model do not carry, by model name, with those of every model it refers to: a model not in the map is complete.
   * The model plane alone cannot check such a model as the schema does.
   */
  readonly uncarriedModels: ReadonlyMap<string, readonly string[]>;
  /** The same for the operation values of `convertedNodeIds`, by the same keys: a value not in the map is complete. */
  readonly uncarriedValues: ReadonlyMap<string, readonly string[]>;
  /** What the graph was given to intern, for the golem-mode manifest: the models job interns the same descriptors again. */
  readonly graphInputs: SchemaGraphInputs;
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
  return { ...modelEnv(env.document, undefined, anchors, env.resources, env.selections, env.dates), uncarried: env.uncarried };
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

/** Converts a sub-schema of a keyword (`not`, `contains`, `if`, ...) with the descriptor builder that converts a field. */
type SubSchema = (schema: unknown) => ConstraintSchemaValue;

/**
 * Which keywords a call carries. `typed` keywords judge one JSON type and pass any other value, so they sit on the value's own
 * descriptor, inside a nullable union. `any` keywords judge every value, `null` included, so they sit on the whole descriptor.
 */
type KeywordPart = 'typed' | 'any' | 'all';

const OPEN_OBJECT: ModelTypeDescriptor = { kind: 'object', properties: {}, required: [], additionalProperties: true };

/**
 * The one path from the keywords of an OpenAPI schema to model constraints, for every kind of descriptor. A keyword that the
 * descriptor already holds in its shape (`properties`, `items`, `prefixItems`, `additionalProperties`, a literal `enum`) is not read here.
 */
function openApiKeywordConstraints(schema: Readonly<Record<string, unknown>>, sub: SubSchema, part: KeywordPart = 'all'): ModelConstraint[] | undefined {
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
  const subschema = (value: unknown): ConstraintSchemaValue | undefined => typeof value === 'boolean' || isJsonObject(value) ? sub(value) : undefined;
  const withSubschema = (kind: 'contains' | 'propertyNames' | 'unevaluatedProperties' | 'unevaluatedItems' | 'not'): void => {
    const converted = subschema(schema[kind]);
    if (converted !== undefined) constraints.push({ kind, schema: converted });
  };
  if (part !== 'any') {
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
    withSubschema('contains');
    withSubschema('propertyNames');
    withSubschema('unevaluatedProperties');
    withSubschema('unevaluatedItems');
    for (const [pattern, child] of objectEntries(schema.patternProperties)) {
      const converted = subschema(child);
      if (converted !== undefined) constraints.push({ kind: 'patternProperties', pattern, schema: converted });
    }
    const required = Object.fromEntries(objectEntries(schema.dependentRequired).flatMap(([name, names]) =>
      Array.isArray(names) ? [[name, names.filter((item): item is string => typeof item === 'string')] as const] : []));
    if (Object.keys(required).length) constraints.push({ kind: 'dependentRequired', value: required });
    const dependent = Object.fromEntries(objectEntries(schema.dependentSchemas).flatMap(([name, child]) => {
      const converted = subschema(child);
      return converted === undefined ? [] : [[name, converted] as const];
    }));
    if (Object.keys(dependent).length) constraints.push({ kind: 'dependentSchemas', value: dependent });
  }
  if (part !== 'typed') {
    withSubschema('not');
    const condition = subschema(schema.if);
    if (condition !== undefined) {
      const then = subschema(schema.then);
      const otherwise = subschema(schema.else);
      constraints.push({ kind: 'ifThenElse', if: condition, ...(then === undefined ? {} : { then }), ...(otherwise === undefined ? {} : { else: otherwise }) });
    }
    // A scalar `const` is a literal descriptor where the schema converts as a scalar; here it limits a value of another shape.
    if (schema.const !== undefined) constraints.push({ kind: 'enum', values: [schema.const] });
  }
  return constraints.length ? constraints : undefined;
}

function withOpenApiConstraints(
  descriptor: ModelTypeDescriptor,
  schema: Readonly<Record<string, unknown>>,
  sub: SubSchema,
  part: KeywordPart = 'all',
): ModelTypeDescriptor {
  const extra = openApiKeywordConstraints(schema, sub, part);
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

/** The keywords that judge every value of the schema, `null` included, and the `enum` that no literal descriptor holds. */
function withOpenApiWholeValue(descriptor: ModelTypeDescriptor, schema: Readonly<Record<string, unknown>>, sub: SubSchema): ModelTypeDescriptor {
  return withOpenApiEnum(withOpenApiConstraints(descriptor, schema, sub, 'any'), schema);
}

/** Every keyword of the schema that the descriptor does not hold in its shape, for a descriptor that no inner step has constrained. */
function carryKeywords(descriptor: ModelTypeDescriptor, schema: Readonly<Record<string, unknown>>, sub: SubSchema): ModelTypeDescriptor {
  return withOpenApiEnum(withOpenApiConstraints(descriptor, schema, sub), schema);
}

type JsonClass = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
const JSON_CLASSES: readonly JsonClass[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];

/** The JSON types that a value of the descriptor can have. A descriptor of a shape not listed here can have any. */
function valueClasses(descriptor: ModelTypeDescriptor): readonly JsonClass[] {
  switch (descriptor.kind) {
    case 'string': return ['string'];
    // A class value has the JSON types of its serde's wire form.
    case 'class-value': return valueClasses((descriptor as { readonly serde?: { readonly wireDescriptor?: ModelTypeDescriptor } }).serde?.wireDescriptor ?? { kind: 'unknown' });
    case 'number': return ['number'];
    case 'boolean': return ['boolean'];
    case 'null': return ['null'];
    case 'literal': return [typeof descriptor.value as JsonClass];
    case 'object': return ['object'];
    case 'array':
    case 'tuple': return ['array'];
    case 'union': return [...new Set(descriptor.variants.flatMap(valueClasses))];
    case 'never': return [];
    default: return JSON_CLASSES;
  }
}

/** Whether no value can satisfy both descriptors: they have no JSON type in common, or they are different literals. */
function areDisjoint(left: ModelTypeDescriptor, right: ModelTypeDescriptor): boolean {
  if (left.kind === 'literal' && right.kind === 'literal') return left.value !== right.value;
  const classes = valueClasses(right);
  return !valueClasses(left).some((type) => classes.includes(type));
}

/**
 * `oneOf` accepts a value that exactly one branch accepts, and the union descriptor accepts a value that any branch accepts. A union that a
 * discriminator tags, or whose branches no value can satisfy together, is exact as it is. Any other `oneOf` keeps the `oneOf` constraint beside the union.
 */
function withExactOneOf(descriptor: ModelTypeDescriptor, union: Readonly<Record<string, unknown>>): ModelTypeDescriptor {
  if (!Array.isArray(union.oneOf) || descriptor.kind !== 'union' || descriptor.discriminator !== undefined) return descriptor;
  const { variants } = descriptor;
  if (variants.every((left, at) => variants.slice(at + 1).every((right) => areDisjoint(left, right)))) return descriptor;
  return { ...descriptor, constraints: [...(descriptor.constraints ?? []), { kind: 'oneOf', schemas: variants }] };
}

/**
 * A sub-schema that lists `required` names and converts to nothing (no `properties`) judges only the objects among its values:
 * `{ required: ['cvc'] }` is the rule "an object has `cvc`", and every other value passes.
 */
function withRequiredNames(descriptor: ModelTypeDescriptor, schema: unknown): ModelTypeDescriptor {
  const names = isJsonObject(schema) && Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [];
  if (names.length === 0 || descriptor.kind !== 'unknown') return descriptor;
  const rule: ModelConstraint = { kind: 'ifThenElse', if: OPEN_OBJECT, then: { ...OPEN_OBJECT, required: names } };
  return { ...descriptor, constraints: [...(descriptor.constraints ?? []), rule] };
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

/** A schema that no value satisfies: `false`, `not: true`, or an `enum` or `const` that is empty or that its `type` empties. */
function acceptsNoValue(schema: unknown): boolean {
  return schema === false || (isJsonObject(schema) && (schema.not === true || typedListedValues(schema)?.length === 0));
}

/**
 * `enum` and `const` limit a value to the listed values, with or without `type` (JSON Schema 2020-12 sections 6.1.2 and 6.1.3). An empty list admits no value.
 * A list of scalars is a literal union without the values that the declared `type` excludes. A list with an object or an array has no literal form: the keyword constraints carry it as an `enum` constraint.
 */
function openApiEnumDescriptor(schema: { readonly const?: unknown; readonly enum?: unknown; readonly type?: unknown }): ModelTypeDescriptor | undefined {
  const values = typedListedValues(schema);
  if (!values) return undefined;
  const listed = schema.const !== undefined ? [schema.const] : (schema.enum as readonly unknown[]);
  if (listed.some((value) => value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return undefined;
  const variants = values.map((value): ModelTypeDescriptor => value === null ? { kind: 'null' } : { kind: 'literal', value: value as string | number | boolean });
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
  if (!sequence) return undefined;
  const sub = subschemaConverter(definitions, env, direction, seen);
  return withOpenApiWholeValue(admitsNull(schema) ? { kind: 'union', variants: [sequence, { kind: 'null' }] } : sequence, schema, sub);
}

function sequenceBodyDescriptor(
  schema: Readonly<Record<string, unknown>>,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  direction: 'from' | 'to',
  seen: ReadonlySet<unknown>,
): ModelTypeDescriptor | undefined {
  // `unevaluatedItems` judges the items that no `items` or `prefixItems` evaluates, so beside `prefixItems` alone it is the rest of the
  // tuple, and beside `items` it judges nothing: the descriptor holds it in its shape, and no constraint repeats it.
  const { unevaluatedItems: _held, ...own } = schema;
  const sub = subschemaConverter(definitions, env, direction, seen);
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((item) => modelConversionDescriptor(item, definitions, env, direction, seen));
    const rest = schema.items ?? schema.unevaluatedItems;
    return withOpenApiConstraints(rest === false
      ? { kind: 'tuple', items }
      : {
        kind: 'tuple',
        items,
        rest: {
          index: items.length,
          item: rest === undefined ? { kind: 'unknown' } : modelConversionDescriptor(rest, definitions, env, direction, seen),
        },
      }, own, sub, 'typed');
  }
  if (schema.items) {
    return withOpenApiConstraints({ kind: 'array', item: modelConversionDescriptor(schema.items, definitions, env, direction, seen) }, own, sub, 'typed');
  }
  return undefined;
}

/** The schema converts by its own keywords: array items, oneOf, anyOf, properties, additionalProperties or a scalar type. */
function hasOwnConversionKeywords(schema: Readonly<Record<string, unknown>>): boolean {
  return isSequenceSchema(schema) || Boolean(schema.oneOf || schema.anyOf || schema.properties)
    || schema.additionalProperties !== undefined
    // A scalar type of the schema itself, beside members that only constrain: `{ type: integer, allOf: [{ minimum: 1 }] }` is an integer with a minimum.
    || (typeof schema.type === 'string' && ['integer', 'number', 'string', 'boolean'].includes(schema.type));
}

/**
 * The keywords that limit the text of a date-time string. The model holds a `Date` or a `Temporal` value, not the text, so
 * no descriptor of it can check them.
 */
const DATE_TEXT_KEYWORDS = ['pattern', 'minLength', 'maxLength', 'enum', 'const', 'not', 'if', 'allOf', 'anyOf', 'oneOf'] as const;

/** The keywords that evaluate properties or items beside `unevaluatedProperties` or `unevaluatedItems`, which a union or a condition of the descriptor cannot follow. */
const EVALUATING_KEYWORDS = ['if', 'dependentSchemas', 'oneOf', 'anyOf'] as const;

/** The keywords that a `$ref` does not carry when it has them beside it: the reference converts as the schema it names. */
const REFERENCE_SIBLINGS = [
  'type', 'enum', 'const', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'items', 'prefixItems', 'contains', 'minContains', 'maxContains', 'minProperties', 'maxProperties',
  'required', 'properties', 'additionalProperties', 'patternProperties', 'propertyNames', 'dependentRequired', 'dependentSchemas',
  'if', 'not', 'oneOf', 'anyOf', 'allOf', 'unevaluatedProperties', 'unevaluatedItems',
] as const;

const UPPER_BOUNDS: ReadonlySet<string> = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']);
const LOWER_BOUNDS: ReadonlySet<string> = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']);

/** Whether the schema `target`, which a `$ref` names, already limits a value as the keyword `keyword: value` beside the `$ref` does: the same value, or a looser bound. */
function impliedByTarget(keyword: string, value: unknown, target: Readonly<Record<string, unknown>>): boolean {
  const held = target[keyword];
  if (held === undefined) return false;
  if (isDeepStrictEqual(value, held)) return true;
  if (typeof value === 'number' && typeof held === 'number') return UPPER_BOUNDS.has(keyword) ? value >= held : LOWER_BOUNDS.has(keyword) && value <= held;
  if (keyword === 'type' || keyword === 'required') {
    const own: unknown[] = Array.isArray(value) ? value : [value];
    const named: unknown[] = Array.isArray(held) ? held : [held];
    // A type beside the reference names a type the target has; it lists names the target also requires.
    return keyword === 'type' ? named.every((type) => own.includes(type)) : own.every((name) => named.includes(name));
  }
  return false;
}

/** The schema that a chain of component `$ref`s names, or none when it names no component of the document. */
function referenceTarget(schema: unknown, env: ModelResolveEnv): Readonly<Record<string, unknown>> | undefined {
  let target = componentSchemaTarget(schema, env);
  for (let hops = 0; hops < 16 && isJsonObject(target) && typeof target.$ref === 'string' && Object.keys(target).length === 1; hops += 1) {
    target = componentSchemaTarget(target, env);
  }
  return isJsonObject(target) ? target : undefined;
}

/** The keywords of a schema that its descriptor does not carry. The first three rules name keywords that no descriptor kind holds. */
function uncarriedKeywords(schema: unknown, dates: OpenApiDates, target?: Readonly<Record<string, unknown>>): string[] {
  if (!isJsonObject(schema)) return [];
  const present = (names: readonly string[]): string[] => names.filter((name) => schema[name] !== undefined);
  const isString = schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'));
  // The model holds a date value, not its text.
  const dated = dateClassOf(schema, dates) !== undefined;
  // With an allOf the composition holds `unevaluatedProperties`; with none, a union or a condition evaluates names that the descriptor does not list.
  const unevaluating = !dated && !hasAllOfMembers(schema) && present(EVALUATING_KEYWORDS).length > 0 ? present(['unevaluatedProperties', 'unevaluatedItems']) : [];
  // A keyword beside a `$ref` that the named schema already states, or states more tightly, adds nothing to what the reference converts.
  const reference = typeof schema.$ref === 'string' || typeof schema.$dynamicRef === 'string'
    ? present(REFERENCE_SIBLINGS).filter((keyword) => target === undefined || !impliedByTarget(keyword, schema[keyword], target))
    : [];
  return [...(dated ? present(DATE_TEXT_KEYWORDS) : []), ...unevaluating, ...present(['additionalItems']), ...reference];
}

/** Records the keywords of the schema that no descriptor carries, in the collector of the env. */
function noteUncarried(schema: unknown, env: ModelResolveEnv): void {
  if (env.uncarried) for (const keyword of uncarriedKeywords(schema, env.dates, referenceTarget(schema, withSchemaBase(env, schema)))) env.uncarried.add(keyword);
}

/** The descriptor of one JSON type with no keyword of its shape: an object of unknown values, an array of unknown items, `null`. */
function typeDescriptor(type: string, required: readonly string[]): ModelTypeDescriptor | undefined {
  switch (type) {
    case 'string': return { kind: 'string' };
    case 'number': return { kind: 'number' };
    case 'integer': return { kind: 'number', constraints: [{ kind: 'integer' }] };
    case 'boolean': return { kind: 'boolean' };
    case 'null': return { kind: 'null' };
    case 'array': return { kind: 'array', item: { kind: 'unknown' } };
    case 'object': return { kind: 'object', properties: {}, required, additionalProperties: { kind: 'unknown' } };
    default: return undefined;
  }
}

/**
 * The descriptor of a schema that names its `type` and has no keyword of that shape: the union of the descriptors of its types.
 * An allOf member that names only `object` stays a constraint-only part: the composition holds the object type.
 */
function typesDescriptor(schema: Readonly<Record<string, unknown>>, holds: ModelResolveEnv['holds']): ModelTypeDescriptor | undefined {
  if (schema.type === undefined) return undefined;
  const types = effectiveSchemaTypes(schema);
  if (holds === 'member' && types.every((type) => type === 'object')) return undefined;
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [];
  const variants = types.flatMap((type) => typeDescriptor(type, required) ?? []);
  return variants.length > 1 ? { kind: 'union', variants } : variants[0];
}

/** The converter of the sub-schemas of a keyword, which reads them as it reads a field. */
function subschemaConverter(definitions: ModelDefinitions, env: ModelResolveEnv, direction: 'from' | 'to', seen: ReadonlySet<unknown>): SubSchema {
  return (child) => typeof child === 'boolean' ? child : withRequiredNames(modelConversionDescriptor(child, definitions, { ...env, holds: 'sub' }, direction, seen), child);
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
  const holds = env.holds;
  if (holds) env = { ...env, holds: undefined };
  const nested = withSchemaBase(env, schema);
  noteUncarried(schema, env);
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
  const sub = subschemaConverter(definitions, nested, direction, seen);
  const builtin = dateClassOf(schema, env.dates);
  if (builtin) {
    const value = builtinClassDescriptor(builtin);
    return admitsNull(asRecord(schema)) ? { kind: 'union', variants: [value, { kind: 'null' }] } : value;
  }
  if (isJsonObject(schema) && hasAllOfMembers(schema)) {
    const composition = resolvedComposition(schema, definitions, env, direction, seen, position);
    // The composition holds the schema's `unevaluatedProperties` and its members' keywords; the keywords beside the allOf join them.
    const beside = (descriptor: ModelTypeDescriptor): ModelTypeDescriptor => {
      const { unevaluatedProperties: _held, ...rest } = schema;
      return carryKeywords(descriptor, composition.kind === 'members' ? schema : rest, sub);
    };
    if (composition.kind === 'object') return beside(objectCompositionDescriptor(composition));
    if (composition.kind === 'inherits') return beside(composition.descriptor);
    if (composition.kind === 'variants') {
      const variants = composition.variants.map(objectCompositionDescriptor);
      const declaredKey = asRecord(composition.union.discriminator).propertyName;
      const discriminator = unionDiscriminatorTable(composition.union, composition.items, definitions, composition.scope)
        ?? untaggedUnionTable(variants, definitions, typeof declaredKey === 'string' ? declaredKey : undefined);
      return withExactOneOf(beside({ kind: 'union', variants, ...(discriminator ? { discriminator } : {}) }), asRecord(composition.union));
    }
    const members = schema.allOf.map((item) => modelConversionDescriptor(item, definitions, { ...nested, holds: 'member' }, direction, seen));
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
    return beside(joinMembers(deciding.length ? members.filter((part) => isConstraintOnlyPart(part) || isDecidingPart(part)) : members));
  }
  const sequence = isJsonObject(schema) ? sequenceConversionDescriptor(schema, definitions, nested, direction, seen) : undefined;
  if (sequence) return sequence;
  const union = isJsonObject(schema) && (schema.oneOf || schema.anyOf) ? ((): ModelTypeDescriptor | undefined => {
    const variants = unionVariants(schema) ?? [];
    // A nullable array variant is a plain union of its own; its branches join the outer union.
    const convertedVariants = variants.flatMap((item): readonly ModelTypeDescriptor[] => {
      if (isNullBranch(item)) return [{ kind: 'null' }];
      // A discriminator needs object variants, so a discriminated union keeps its references non-null.
      const converted = modelConversionDescriptor(item, definitions, nested, direction, seen, !isJsonObject(schema.discriminator));
      return converted.kind === 'union' && converted.discriminator === undefined ? converted.variants : [converted];
    });
    const classVariants = convertedVariants.filter(item => item.kind === 'class-value');
    if (classVariants.length) {
      if (classVariants.length !== 1 || convertedVariants.some(item => item.kind !== 'class-value' && item.kind !== 'null')) {
        throw new Error('A date-time model union must have one Date or Temporal branch and optional null. Ambiguous string branches cannot be converted to Date or Temporal.');
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
    return undefined;
  })() : undefined;
  if (union) return withExactOneOf(carryKeywords(union, asRecord(schema), sub), asRecord(schema));
  if (isJsonObject(schema) && (schema.properties || schema.additionalProperties !== undefined)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    const empty = objectEntries(schema.properties).filter(([name, child]) => required.includes(name) && acceptsNoValue(child)).map(([name]) => name);
    if (empty.length > 0) {
      throw new CompositionError(COMPOSITION_UNSATISFIABLE, `No object satisfies this schema: the required ${empty.length > 1 ? 'properties' : 'property'} ${empty.map((name) => JSON.stringify(name)).join(', ')} accept${empty.length > 1 ? '' : 's'} no value, because the schema is an empty enum, an enum or const that its type excludes, \`not: true\` or \`false\`. Remove ${empty.length > 1 ? 'them' : 'it'} from required, or give ${empty.length > 1 ? 'them' : 'it'} a schema that accepts a value.`);
    }
    // Beside `properties` alone, `unevaluatedProperties` judges the names that `properties` does not list, as `additionalProperties` does.
    const { unevaluatedProperties: _held, ...own } = schema;
    const closing = schema.additionalProperties ?? schema.unevaluatedProperties;
    const object: ModelTypeDescriptor = withOpenApiConstraints({
      kind: 'object',
      properties: Object.fromEntries(objectEntries(schema.properties).map(([name, child]) => [name, modelConversionDescriptor(child, definitions, nested, direction, seen)])),
      required,
      additionalProperties: closing === false
        ? false
        : isJsonObject(closing)
          ? modelConversionDescriptor(closing, definitions, nested, direction, seen)
          : true,
      ...(schema.additionalProperties === true ? { additionalPropertiesDeclared: true as const } : {}),
    }, own, sub, 'typed');
    return withOpenApiWholeValue(admitsNull(schema) ? { kind: 'union', variants: [object, { kind: 'null' }] } : object, schema, sub);
  }
  if (isJsonObject(schema)) {
    const listed = openApiEnumDescriptor(schema);
    if (listed) {
      // A scalar `const` is held by the literal; the keyword constraints must not list it again.
      const { const: _held, ...keywords } = schema;
      return withOpenApiConstraints(listed, keywords, sub);
    }
  }
  if (isJsonObject(schema)) {
    const primitive = openApiPrimitiveDescriptor(schema);
    if (primitive) {
      const constrained = withOpenApiConstraints(primitive, schema, sub, 'typed');
      return withOpenApiWholeValue(admitsNull(schema)
        ? { kind: 'union', variants: [constrained, { kind: 'null' }] }
        : constrained, schema, sub);
    }
    const shaped = typesDescriptor(schema, holds);
    if (shaped) return withOpenApiEnum(withOpenApiConstraints(shaped, schema, sub), schema);
    const constraints = openApiKeywordConstraints(schema, sub);
    const unknown: ModelTypeDescriptor = constraints || Array.isArray(schema.enum) ? withOpenApiEnum({ kind: 'unknown', ...(constraints ? { constraints } : {}) }, schema) : { kind: 'unknown' };
    // An allOf member or a sub-schema has its `required` names held by its caller; any other schema without `type` or `properties` holds them as a rule of its objects.
    return holds === undefined ? withRequiredNames(unknown, schema) : unknown;
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
    descriptor: (schema, env) => seen.has(schema) ? undefined : modelConversionDescriptor(schema, definitions, { ...env, holds: 'member' }, direction, seen),
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
    for (const keyword of ['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'not', 'contains', 'propertyNames', 'if', 'then', 'else'] as const) {
      visit(schema[keyword], nested, 'field', `${pointer}/${keyword}`);
    }
    for (const keyword of ['patternProperties', 'dependentSchemas'] as const) {
      for (const [name, child] of objectEntries(schema[keyword])) visit(child, nested, 'field', `${pointer}/${keyword}/${escapeJsonPointerToken(name)}`);
    }
    for (const keyword of ['prefixItems', 'allOf', 'oneOf', 'anyOf'] as const) {
      const items = schema[keyword];
      if (Array.isArray(items)) items.forEach((item, index) => visit(item, nested, 'field', `${pointer}/${keyword}/${index}`));
    }
  };
  visit(rawSchema, env, definition ? 'definition' : 'field', '');
}

/**
 * Reads the names that no value can hold for the type writer: the rule of `checkComposition`, which warns about each of them,
 * so the type of such a property is `never`. A component root that is a model is read at definition position, as the check does.
 */
export function neverPropertiesReader(
  analysis: Pick<OpenApiModelAnalysis, 'definitions' | 'resources' | 'selections' | 'dates'>,
  document: unknown,
): NeverPropertiesOf {
  return (schema, { currentBase, anchors, component }) => {
    if (!hasAllOfMembers(schema)) return [];
    const definition = component === undefined ? undefined : analysis.definitions.get(identifier(component));
    const isModel = definition !== undefined && definition.schemaName === component && !definition.isUnion;
    const env = modelEnv(document, currentBase, anchors, analysis.resources, analysis.selections, analysis.dates);
    const composition = resolvedComposition(schema, analysis.definitions, env, 'to', new Set([schema]), isModel ? 'definition' : 'field');
    return neverNames(composition).map((never) => never.name);
  };
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
}

export interface SchemaGraphGrouping {
  readonly groups: readonly SchemaGraphGroup[];
  readonly owner: ReadonlyMap<string, string>;
  readonly runtimeEdges: ReadonlyMap<string, ReadonlySet<string>>;
}
