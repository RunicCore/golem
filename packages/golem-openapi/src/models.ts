import {
  emitModelFromJSON,
  FIELD_CONVERSION_INPUT,
  singleCallConverter,
  emitModelFromInit,
  emitModelToJSON,
  emitCodecRuntime,
  fillFunctionName,
  type CodecRuntimeOptions,
  type FromJsonModelResolver,
  type ModelDiscriminators,
} from '@exprtlabs/golem/emitter';
import { createSchemaGraph, codecPublicId, internDescriptors, type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/schema-graph';
import type { CodecSchemaClosureEntry, CodecValidationPlan } from '@exprtlabs/golem/validation-plan';
import { assertSupportedModelFieldName, type JsonSchema } from '@exprtlabs/golem/schema';
import { sourceDigest } from '@exprtlabs/golem/manifest';
import { buildCodecValidationPlan, compilePlanValidators } from '@exprtlabs/golem/validation-plan';
import type { DiscriminatorValue, ModelConstraint, ModelTypeDescriptor, UnionDiscriminator } from '@exprtlabs/golem/model';

import { asRecord, isJsonObject, jsonLiteral, objectEntries } from './json.js';
import {
  GolemDiagnosticSeverity,
  identifier,
  NameScope,
  propertyName,
  RESERVED_MODEL_MEMBERS,
  type GolemDiagnostic,
} from '@exprtlabs/golem/generator-api';
import { componentOrigin, ComponentNameScope, LocatedError } from './origin.js';
import { effectiveSchemaTypes, resolveLocal, type OpenApiSchema } from './normalize.js';
import { generatedBanner, GENERATOR_NAME, PACKAGE_VERSION } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import { schemaContext, schemaType, type SchemaTypeContext } from './types.js';
import {
  collectCanonicalResources,
  nextSchemaBase,
  resolveExactComponent,
  schemaDocumentBase,
  type ExactComponentTarget,
  type ResourceIndex,
} from './schema-projection.js';

interface ModelDefinition {
  readonly name: string;
  readonly schemaName: string;
  readonly schema: unknown;
  readonly rawSchema: unknown;
  baseName: string | null;
  properties: Map<string, unknown>;
  additionalProperties: unknown;
  required: Set<string>;
  variants?: readonly string[];
  discriminator?: unknown;
  isUnion?: boolean;
}

interface DiscriminatorSelection {
  readonly propertyName: string;
  readonly variants: ReadonlyMap<string, string>;
}

/** Selections resolved (and diagnosed) once per discriminated union schema object, per analysis. */
type DiscriminatorSelections = Map<object, DiscriminatorSelection | null>;

/** How `format: date-time`, `date` and `duration` strings become model values. */
export type OpenApiDates = 'date' | 'temporal';

interface ModelResolveEnv {
  readonly document: unknown;
  readonly dates: OpenApiDates;
  readonly resources: ResourceIndex;
  readonly currentBase: string;
  readonly anchors?: ReadonlyMap<string, string>;
  readonly selections?: DiscriminatorSelections;
}

export interface OpenApiModelAnalysis {
  readonly definitions: ReadonlyMap<string, ModelDefinition>;
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

function modelEnv(
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

function withSchemaBase(env: ModelResolveEnv, schema: unknown): ModelResolveEnv {
  return { ...env, currentBase: nextSchemaBase(schema, env.currentBase, env.resources) };
}

/** `dates: temporal` string formats and the `@exprtlabs/golem/temporal` tag each converts with. */
const TEMPORAL_FORMATS = {
  'date-time': { typeName: 'Temporal.Instant', codec: 'TemporalInstant' },
  date: { typeName: 'Temporal.PlainDate', codec: 'TemporalPlainDate' },
  duration: { typeName: 'Temporal.Duration', codec: 'TemporalDuration' },
} as const;

const TEMPORAL_SERDE_PREFIX = 'temporal:';

function temporalFormat(schema: unknown, env: ModelResolveEnv): (typeof TEMPORAL_FORMATS)[keyof typeof TEMPORAL_FORMATS] | undefined {
  if (env.dates !== 'temporal' || !isJsonObject(schema) || typeof schema.format !== 'string') return undefined;
  if (!(schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string')))) return undefined;
  return Object.hasOwn(TEMPORAL_FORMATS, schema.format) ? TEMPORAL_FORMATS[schema.format as keyof typeof TEMPORAL_FORMATS] : undefined;
}

function isTemporalDescriptor(descriptor: ModelTypeDescriptor): boolean {
  const serde = (descriptor as { readonly serde?: { readonly id?: string } }).serde;
  return descriptor.kind === 'class-value' && serde?.id?.startsWith(TEMPORAL_SERDE_PREFIX) === true;
}

/**
 * Calls the `@exprtlabs/golem/temporal` codec a `temporal:` serde id names; other ids never reach OpenAPI models.
 * Conversion code holds values as `unknown`; wire validation has already checked them, so the call casts.
 */
const TEMPORAL_SERDE = {
  deserialize: (id: string, value: string) => `deserialize${temporalCodecName(id)}((${value}) as never)`,
  serialize: (id: string, value: string) => `serialize${temporalCodecName(id)}((${value}) as never)`,
};

function temporalCodecName(id: string): string {
  if (!id.startsWith(TEMPORAL_SERDE_PREFIX)) throw new Error(`Unexpected serde id in an OpenAPI model: ${id}`);
  return id.slice(TEMPORAL_SERDE_PREFIX.length);
}

function typeContext(env: ModelResolveEnv): SchemaTypeContext {
  return {
    qualifier: 'Types.',
    anchors: env.anchors,
    document: env.document,
    resources: env.resources,
    currentBase: env.currentBase,
  };
}

function directComponentSchemaRef(schema: unknown, env: ModelResolveEnv): string | null {
  if (isJsonObject(schema) && typeof schema.$ref !== 'string' && typeof schema.$dynamicRef === 'string') {
    const anchored = env.anchors?.get(schema.$dynamicRef);
    if (anchored) return anchored;
  }
  return exactComponentTarget(schema, env)?.typeName ?? null;
}

function componentSchemaTarget(schema: unknown, env: ModelResolveEnv): unknown {
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

function modelSchemaProperties(
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

function isModelSchema(env: ModelResolveEnv, schema: unknown, visiting = new Set<unknown>()): boolean {
  if (!isJsonObject(schema) || visiting.has(schema)) return false;
  visiting.add(schema);
  const nested = withSchemaBase(env, schema);
  const target = componentSchemaTarget(schema, nested);
  if (target !== undefined && target !== schema) return isModelSchema(nested, target, visiting);
  if (schema.type === 'object' || schema.properties || schema.additionalProperties !== undefined) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.some((item) => isModelSchema(nested, item, visiting));
  }
  return false;
}

function modelBaseSchemaName(schema: unknown, env: ModelResolveEnv): string | null {
  const record = asRecord(schema);
  const nested = withSchemaBase(env, schema);
  const candidates = Array.isArray(record.allOf) ? record.allOf : [schema];
  for (const candidate of candidates) {
    const name = directComponentSchemaRef(candidate, nested);
    if (name) return name;
  }
  return null;
}

function modelAdditionalProperties(
  env: ModelResolveEnv,
  rawSchema: unknown,
): unknown {
  let result: unknown;
  const visiting = new Set<string>();
  const visit = (schema: unknown, current: ModelResolveEnv): void => {
    if (!isJsonObject(schema)) return;
    const nested = withSchemaBase(current, schema);
    const reference = directComponentSchemaRef(schema, nested);
    if (reference) {
      if (visiting.has(reference)) return;
      const target = componentSchemaTarget(schema, nested);
      if (!target) return;
      visiting.add(reference);
      visit(target, nested);
      visiting.delete(reference);
      return;
    }
    for (const item of Array.isArray(schema.allOf) ? schema.allOf : []) visit(item, nested);
    if (schema.additionalProperties !== undefined) result = schema.additionalProperties;
  };
  visit(rawSchema, env);
  return result;
}

function modelSchemaReference(schema: unknown, env: ModelResolveEnv): string | null {
  return directComponentSchemaRef(schema, withSchemaBase(env, schema));
}

function modelFieldType(
  schema: unknown,
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
  visiting: ReadonlySet<unknown> = new Set(),
): string {
  const nested = withSchemaBase(env, schema);
  const reference = modelSchemaReference(schema, nested);
  if (reference && definitions.has(reference)) {
    const record = asRecord(schema);
    return `${reference}Model${admitsNull(record) ? ' | null' : ''}`;
  }
  if (visiting.has(schema)) throw new Error('Recursive schema aliases must resolve to an object model.');
  const seen = new Set(visiting).add(schema);
  const target = componentSchemaTarget(schema, nested);
  if (target !== undefined && target !== schema) return modelFieldType(target, definitions, nested, seen);
  const temporal = temporalFormat(schema, env);
  if (temporal) return admitsNull(asRecord(schema)) ? `${temporal.typeName} | null` : temporal.typeName;
  if (isJsonObject(schema) && schema.format === 'date-time'
    && (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string')))) {
    return admitsNull(schema) ? 'Date | null' : 'Date';
  }
  if (isJsonObject(schema) && (schema.oneOf || schema.anyOf)) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
    return variants
      .map((item) => modelFieldType(item, definitions, nested, seen))
      .map((type) => `(${type})`)
      .join(' | ');
  }
  if (isJsonObject(schema) && schema.type === 'array' && schema.items) {
    return `Array<${modelFieldType(schema.items, definitions, nested, seen)}>`;
  }
  if (isJsonObject(schema) && (schema.properties || isJsonObject(schema.additionalProperties))) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = objectEntries(schema.properties).map(([name, child]) => `${propertyName(name)}${required.has(name) ? '' : '?'}: ${modelFieldType(child, definitions, nested, seen)}`);
    if (isJsonObject(schema.additionalProperties)) fields.push(`[key: string]: ${fields.length ? 'unknown' : modelFieldType(schema.additionalProperties, definitions, nested, seen)}`);
    return `{ ${fields.join('; ')} }`;
  }
  return schemaType(schema, typeContext(nested));
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

function mergeAllOfDescriptors(parts: readonly ModelTypeDescriptor[]): ModelTypeDescriptor {
  const extras: ModelConstraint[] = [];
  const typed: ModelTypeDescriptor[] = [];
  for (const part of parts) {
    const constraintOnly = part.kind === 'unknown'
      && part.constraints?.length
      && part.validations === undefined
      && part.serde === undefined;
    if (constraintOnly) extras.push(...(part.constraints ?? []));
    else typed.push(part);
  }
  if (typed.length === 1) {
    const [base] = typed;
    if (!base) return { kind: 'intersection', variants: [...parts] };
    return extras.length ? { ...base, constraints: [...(base.constraints ?? []), ...extras] } : base;
  }
  if (typed.length === 0 && extras.length) return { kind: 'unknown', constraints: extras };
  return { kind: 'intersection', variants: [...parts] };
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

function modelConversionDescriptor(
  schema: unknown,
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
  direction: 'from' | 'to' = 'from',
  visiting: ReadonlySet<unknown> = new Set(),
): ModelTypeDescriptor {
  const nested = withSchemaBase(env, schema);
  const reference = modelSchemaReference(schema, nested);
  if (reference && definitions.has(reference)) {
    const generated: ModelTypeDescriptor = { kind: 'generated-model', id: reference };
    return admitsNull(asRecord(schema))
      ? { kind: 'union', variants: [generated, { kind: 'null' }] }
      : generated;
  }
  if (visiting.has(schema)) throw new Error('Recursive schema aliases must resolve to an object model.');
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
  if (isJsonObject(schema) && Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return mergeAllOfDescriptors(
      schema.allOf.map((item) => modelConversionDescriptor(item, definitions, nested, direction, seen)),
    );
  }
  if (isJsonObject(schema) && schema.type === 'array' && schema.items) {
    return {
      kind: 'array',
      item: modelConversionDescriptor(schema.items, definitions, nested, direction, seen),
    };
  }
  if (isJsonObject(schema) && (schema.oneOf || schema.anyOf)) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
    const convertedVariants = variants.map(item => isNullBranch(item)
      ? { kind: 'null' as const }
      : modelConversionDescriptor(item, definitions, nested, direction, seen));
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
    if (modelReferences.length === 1 && (permitsNull || direction === 'to') && !isJsonObject(schema.discriminator)) {
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
    return {
      kind: 'object',
      properties: Object.fromEntries(objectEntries(schema.properties).map(([name, child]) => [name, modelConversionDescriptor(child, definitions, nested, direction, seen)])),
      required,
      additionalProperties: schema.additionalProperties === false
        ? false
        : isJsonObject(schema.additionalProperties)
          ? modelConversionDescriptor(schema.additionalProperties, definitions, nested, direction, seen)
          : true,
    };
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

/**
 * Tags a model declares itself: required properties whose schema is a const or
 * an enum of literals. The shared union conversion infers dispatch from these
 * when a union has no discriminator table.
 */
function modelDiscriminators(definition: ModelDefinition | undefined): ModelDiscriminators | undefined {
  if (!definition) return undefined;
  const tags: Record<string, DiscriminatorValue | readonly DiscriminatorValue[]> = {};
  const literal = (value: unknown): value is DiscriminatorValue =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  for (const [name, schema] of definition.properties) {
    if (!definition.required.has(name) || !isJsonObject(schema)) continue;
    if (literal(schema.const)) tags[name] = schema.const;
    else if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(literal)) {
      tags[name] = schema.enum.length === 1 ? schema.enum[0] : schema.enum;
    }
  }
  return Object.keys(tags).length ? tags : undefined;
}

/** How generated conversion code decodes and constructs a referenced model. */
function modelResolver(reference: string, definitions: ReadonlyMap<string, ModelDefinition>): FromJsonModelResolver {
  const discriminators = modelDiscriminators(definitions.get(reference));
  return {
    className: `${reference}Model`,
    decode: (value) => `decodeGeneratedModelTrusted(${reference}Model, ${value})`,
    fromInit: (value) => definitions.get(reference)?.isUnion
      ? `initialize${reference}(${value})`
      : `new ${reference}Model(${value} as ${reference}Init)`,
    ...(discriminators ? { discriminators } : {}),
  };
}

function modelFromJSONExpression(
  schema: unknown,
  expression: string,
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
): string {
  return emitModelFromJSON(
    modelConversionDescriptor(schema, definitions, env, 'from'),
    expression,
    (reference) => modelResolver(reference, definitions),
    TEMPORAL_SERDE,
  );
}

function modelInitExpression(schema: unknown, expression: string, definitions: ReadonlyMap<string, ModelDefinition>, env: ModelResolveEnv): string {
  const descriptor = modelConversionDescriptor(schema, definitions, env, 'from');
  return emitModelFromInit(descriptor, expression, reference => modelResolver(reference, definitions));
}

function modelToJSONExpression(
  schema: unknown,
  expression: string,
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
): string {
  return emitModelToJSON(
    modelConversionDescriptor(schema, definitions, env, 'to'),
    expression,
    (reference) => ({ className: `${reference}Model`, encode: value => `encodeGeneratedModel(${value})` }),
    TEMPORAL_SERDE,
  );
}

/**
 * `emit(FIELD_CONVERSION_INPUT)` shows the shape of a field conversion. A single call passes its function and the
 * field value to `convertModelField`; any other conversion becomes a module-level function of the field value,
 * so no field allocates a closure.
 */
function rootFieldConversion(
  helpers: string[],
  helperName: (index: number) => string,
  direction: 'deserialize' | 'serialize',
  field: string,
  input: string,
  emit: (value: string) => string,
  inputType: string,
): string {
  const converted = emit(FIELD_CONVERSION_INPUT);
  if (converted === FIELD_CONVERSION_INPUT) return input;
  let convert = singleCallConverter(converted);
  if (!convert) {
    convert = helperName(helpers.length);
    helpers.push(`function ${convert}(${FIELD_CONVERSION_INPUT}: ${inputType}) { return ${converted}; }`);
  }
  return `convertModelField('${direction}', ${JSON.stringify(field)}, ${convert}, ${input})`;
}

function modelFieldDeclaration(
  name: string,
  schema: unknown,
  required: boolean,
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
): string {
  const description = isJsonObject(schema) && schema.description
    ? `  /** ${String(schema.description).replace(/\*\//g, '*\\/').replace(/\s+/g, ' ')} */\n`
    : '';
  return `${description}  declare ${propertyName(name)}${required ? '' : '?'}: ${modelFieldType(schema, definitions, env)};`;
}

function modelPropertyAccess(name: string): string {
  return `[${JSON.stringify(name)}]`;
}

function modelPropertyCondition(target: string, name: string): string {
  const access = `${target}${modelPropertyAccess(name)}`;
  return `${access} !== undefined`;
}

function modelPropertyAssignment(target: string, name: string, value: string): string {
  return `${target}${modelPropertyAccess(name)} = ${value};`;
}

/**
 * Resolve an OAS discriminator into the value → variant model table. Mapping
 * values are component names or references; a variant without a mapping key
 * is selected by its raw component name (the implicit mapping).
 */
function discriminatorSelection(
  schemaName: string,
  schema: unknown,
  definitions: ReadonlyMap<string, ModelDefinition>,
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

export function collectOpenApiModelDefinitions(document: unknown, resources?: ResourceIndex): {
  definitions: Map<string, ModelDefinition>;
  ordered: ModelDefinition[];
  diagnostics: GolemDiagnostic[];
  selections: DiscriminatorSelections;
} {
  const diagnostics: GolemDiagnostic[] = [];
  const selections: DiscriminatorSelections = new Map();
  const warn = (code: string, message: string): void => {
    diagnostics.push({ code, severity: GolemDiagnosticSeverity.Warning, message });
  };
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const env = modelEnv(document, undefined, undefined, resources, selections);
  const definitions = new Map<string, ModelDefinition>();
  const schemaScope = new ComponentNameScope('models.ts schema identifiers');
  for (const [rawName, rawSchema] of objectEntries(schemas)) {
    const name = identifier(rawName);
    const schema = resolveLocal(document, rawSchema);
    if (!isModelSchema(env, schema)) continue;
    schemaScope.claim(name, `component schema ${JSON.stringify(rawName)}`, rawName);
    definitions.set(name, {
      name,
      schemaName: rawName,
      schema,
      rawSchema,
      baseName: null,
      properties: new Map(),
      additionalProperties: null,
      required: new Set(),
    });
  }

  for (const definition of definitions.values()) {
    const requestedBase = modelBaseSchemaName(definition.rawSchema, env);
    definition.baseName = requestedBase && definitions.has(requestedBase) && requestedBase !== definition.name
      ? requestedBase
      : null;
    definition.properties = modelSchemaProperties(env, definition.rawSchema, definition.baseName);
    for (const propertyName of definition.properties.keys()) assertSupportedModelFieldName(propertyName);
    definition.additionalProperties = modelAdditionalProperties(
      env,
      definition.rawSchema,
    );
    definition.required = new Set();
    const collectRequired = (schema: unknown, visiting = new Set<string>(), current = env): void => {
      if (!isJsonObject(schema)) return;
      const nested = withSchemaBase(current, schema);
      const reference = directComponentSchemaRef(schema, nested);
      if (reference) {
        if (visiting.has(reference)) return;
        const target = componentSchemaTarget(schema, nested);
        if (target) {
          // Base `required` fields still constrain a derived allOf schema when
          // that schema redeclares the field to narrow its type (for example,
          // a discriminator const). Collect them so the derived declaration
          // cannot become optional in the emitted TypeScript class.
          visiting.add(reference);
          collectRequired(target, visiting, nested);
          visiting.delete(reference);
        }
        return;
      }
      for (const item of Array.isArray(schema.allOf) ? schema.allOf : []) collectRequired(item, visiting, nested);
      for (const property of Array.isArray(schema.required) ? schema.required : []) {
        definition.required.add(String(property));
      }
    };
    collectRequired(definition.rawSchema);
  }

  // Union models are decided against declared inheritance only, so the result
  // does not depend on component order. A union model class requires its
  // variants to extend it, so a union with a variant that another union also
  // selects stays a plain union type (decoded through its tag table).
  const unions: ModelDefinition[] = [];
  for (const [rawName, rawSchema] of objectEntries(schemas)) {
    if (!isJsonObject(rawSchema)) continue;
    // A discriminator makes anyOf select exactly one variant, as oneOf does.
    const alternatives = Array.isArray(rawSchema.oneOf)
      ? rawSchema.oneOf
      : Array.isArray(rawSchema.anyOf) && isJsonObject(rawSchema.discriminator) ? rawSchema.anyOf : undefined;
    if (!alternatives) continue;
    const name = identifier(rawName);
    if (definitions.has(name)) continue;
    const variants = alternatives
      .map((item) => directComponentSchemaRef(item, env))
      .filter((variant): variant is string => Boolean(variant && definitions.has(variant)));
    if (variants.length !== alternatives.length || variants.length === 0) continue;
    const commonBase = definitions.get(variants[0] ?? '')?.baseName ?? null;
    if (!commonBase || !variants.every((variant) => definitions.get(variant)?.baseName === commonBase)) continue;
    unions.push({
      name,
      schemaName: rawName,
      schema: rawSchema,
      rawSchema,
      baseName: commonBase,
      properties: new Map(),
      additionalProperties: null,
      required: new Set(),
      variants,
      discriminator: rawSchema.discriminator,
      isUnion: true,
    });
  }
  const claims = new Map<string, number>();
  for (const union of unions) {
    for (const variant of union.variants ?? []) claims.set(variant, (claims.get(variant) ?? 0) + 1);
  }
  for (const union of unions) {
    const shared = (union.variants ?? []).filter((variant) => claims.get(variant) !== 1);
    if (shared.length) {
      warn('OPENAPI_UNION_SHARED_VARIANT', `schema ${JSON.stringify(union.schemaName)} gets no union model class because ${shared.map((variant) => definitions.get(variant)?.schemaName ?? variant).map((name) => JSON.stringify(name)).join(', ')} is also a variant of another union; values typed by it still decode to the variant models`);
      continue;
    }
    schemaScope.claim(union.name, `union schema ${JSON.stringify(union.schemaName)}`, union.schemaName);
    definitions.set(union.name, union);
    for (const variant of union.variants ?? []) {
      const child = definitions.get(variant);
      if (child) child.baseName = union.name;
    }
  }

  for (const [rawName, rawSchema] of objectEntries(schemas)) {
    const schema = resolveLocal(document, rawSchema);
    if (!isJsonObject(schema) || !isJsonObject(schema.discriminator)) continue;
    if (!Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf)) {
      warn('OPENAPI_DISCRIMINATOR_INHERITANCE_UNSUPPORTED', `schema ${JSON.stringify(rawName)} declares a discriminator without oneOf/anyOf; subtypes that extend it through allOf are not selected when it is decoded`);
      continue;
    }
    const selection = discriminatorSelection(rawName, schema, definitions, env, warn);
    selections.set(schema, selection ?? null);
    if (isJsonObject(rawSchema)) selections.set(rawSchema, selection ?? null);
    if (!selection) {
      warn('OPENAPI_DISCRIMINATOR_NOT_LOWERED', `schema ${JSON.stringify(rawName)} has a discriminator, but not every oneOf/anyOf variant is a component model; its discriminator is not used for conversion`);
      continue;
    }
  }

  const ordered: ModelDefinition[] = [];
  const visiting = new Set<string>();
  const visit = (definition: ModelDefinition): void => {
    if (ordered.includes(definition)) return;
    if (visiting.has(definition.name)) {
      throw new Error(`circular allOf model inheritance involving ${definition.name}`);
    }
    visiting.add(definition.name);
    if (definition.baseName) {
      const base = definitions.get(definition.baseName);
      if (base) visit(base);
    }
    visiting.delete(definition.name);
    ordered.push(definition);
  };
  for (const definition of definitions.values()) visit(definition);

  return { definitions, ordered, diagnostics, selections };
}

export function generateModelManifest(
  document: unknown,
  profile: OpenApiGenerationProfile,
  analysis?: OpenApiModelAnalysis,
): unknown {
  profile = requireProfile(profile);
  const modelAnalysis = analysis ?? analyzeOpenApiModels(document, profile.validation);
  const { ordered, schemaGraph } = modelAnalysis;
  const digest = sourceDigest(document);
  const stableId = (definition: ModelDefinition) =>
    `openapi:${digest.slice(0, 16)}#/components/schemas/${definition.schemaName}`;
  const byName = new Map(ordered.map((definition) => [definition.name, definition]));
  const sharedSchemaContext = schemaContext(document, { resources: modelAnalysis.resources });
  const models = ordered.map((definition) => {
    const anchors = schemaContext(
      document,
      sharedSchemaContext,
      definition.schemaName,
      definition.rawSchema,
    ).anchors;
    const env = modelEnv(document, undefined, anchors, modelAnalysis.resources, modelAnalysis.selections, modelAnalysis.dates);
    const fieldEnv = withSchemaBase(env, definition.rawSchema);
    const fields = [...definition.properties.entries()].map(([name, schema]) => ({
      name,
      required: definition.required.has(name),
      type: modelFieldType(schema, byName, fieldEnv),
      modelReferences: [...new Set([
        modelSchemaReference(schema, fieldEnv),
        ...(isJsonObject(schema) && schema.type === 'array'
          ? [modelSchemaReference(schema.items, fieldEnv)]
          : []),
      ].filter((reference): reference is string => Boolean(reference && byName.has(reference))))].sort(),
    }));
    return {
      id: stableId(definition),
      codecId: openApiCodecId(modelAnalysis, definition.name),
      sourceKind: 'openapi',
      allowAny: profile.allowAny ?? false,
      type: {
        module: './types.ts',
        export: definition.name,
        aliases: [{ module: './index.ts', export: definition.name }],
      },
      generated: {
        module: `./models/${definition.name}.ts`,
        export: `${definition.name}Model`,
      },
      fields,
      inheritance: definition.baseName && byName.get(definition.baseName)
        ? { baseModelId: stableId(byName.get(definition.baseName) ?? definition) }
        : null,
      discriminator: definition.discriminator || null,
      variants: definition.variants || [],
    };
  });
  return {
    generator: {
      name: GENERATOR_NAME,
      version: PACKAGE_VERSION,
    },
    runtime: { name: '@exprtlabs/golem', minimumVersion: PACKAGE_VERSION },
    source: {
      kind: 'openapi',
      dialect: asRecord(document).openapi,
      digest,
    },
    profile,
    models,
    ...(profile.validation ? {
      validationSchemaClosure: openApiValidationSchemaClosure(schemaGraph, ordered, stableId),
    } : {}),
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
  definitions: ReadonlyMap<string, ModelDefinition>,
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

/**
 * A model class owns its codec. `allOf: [{ $ref: X }]` collapses to a bare
 * reference to X, which would make the subclass delegate to a codec that is
 * never registered under its own id; keep it an object node extending X, as
 * `allOf: [{ $ref: X }, { type: 'object' }]` would.
 */
function modelClassDescriptor(
  descriptor: ModelTypeDescriptor,
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
): ModelTypeDescriptor {
  if (descriptor.kind !== 'generated-model') return descriptor;
  // The alias has exactly its base's shape, including its policy for undeclared members.
  const base = definitions.get(descriptor.id);
  const baseDescriptor = base ? modelConversionDescriptor(base.rawSchema, definitions, env, 'to') : undefined;
  if (baseDescriptor?.kind === 'object') return { ...baseDescriptor };
  return {
    kind: 'intersection',
    variants: [descriptor, { kind: 'object', properties: {}, required: [], additionalProperties: true }],
  };
}

export function internOpenApiSchemaGraph(
  document: unknown,
  ordered: readonly ModelDefinition[],
  definitions: ReadonlyMap<string, ModelDefinition>,
  validationEnabled = true,
  resources?: ResourceIndex,
  selections?: DiscriminatorSelections,
  dates: OpenApiDates = 'date',
): { readonly schemaGraph: SchemaGraph; readonly nodeIdByDefinition: ReadonlyMap<string, string> } {
  const schemaGraph = createSchemaGraph({}, {
    codecSource: 'openapi',
  });
  const sharedSchemaContext = schemaContext(document, resources ? { resources } : {});
  const nodeIdByDefinition = internDescriptors(schemaGraph, ordered.map((definition) => {
    const anchors = schemaContext(
      document,
      sharedSchemaContext,
      definition.schemaName,
      definition.rawSchema,
    ).anchors;
    const env = modelEnv(document, undefined, anchors, resources, selections, dates);
    return {
      name: definition.name,
      descriptor: definition.isUnion
        ? modelConversionDescriptor(definition.rawSchema, definitions, env, 'to')
        : modelClassDescriptor(modelConversionDescriptor(definition.rawSchema, definitions, env, 'to'), definitions, env),
      emitClass: true,
      validationEnabled,
    };
  }));
  schemaGraph.seal();
  return { schemaGraph, nodeIdByDefinition };
}

/**
 * Each schema resolves to the node interned for it. Graph nodes carry the short codec name, so
 * schemas that shorten alike (`PaymentModel`, `TPayment`, `Payment`) have separate nodes only
 * when their shapes differ; equal shapes would share one codec and are rejected.
 */
function nodesByDefinitionName(
  schemaGraph: SchemaGraph,
  nodeIdByDefinition: ReadonlyMap<string, string>,
): { readonly nodesByName: Map<string, SchemaNode>; readonly definitionNameByNodeId: Map<string, string> } {
  const nodes = [...schemaGraph.nodes.values()];
  const shortCounts = new Map<string, number>();
  for (const node of nodes) shortCounts.set(node.name, (shortCounts.get(node.name) ?? 0) + 1);
  const nodesByName = new Map(nodes.filter((node) => shortCounts.get(node.name) === 1).map((node) => [node.name, node] as const));
  const definitionNameByNodeId = new Map<string, string>();
  for (const [definitionName, nodeId] of nodeIdByDefinition) {
    const node = schemaGraph.nodes.get(nodeId);
    if (!node) throw new Error(`Internal error: model ${definitionName} has no schema node.`);
    const other = definitionNameByNodeId.get(node.id);
    if (other !== undefined) {
      const otherNamed = JSON.stringify(other);
      const named = JSON.stringify(definitionName);
      throw new LocatedError(`OpenAPI components ${otherNamed} and ${named} both map to the model name "${node.name}" once characters that are not letters, digits or underscores are replaced. Rename one of them.`, [componentOrigin('schemas', other, otherNamed), componentOrigin('schemas', definitionName, named)]);
    }
    definitionNameByNodeId.set(node.id, definitionName);
    nodesByName.set(definitionName, node);
  }
  return { nodesByName, definitionNameByNodeId };
}

export function analyzeOpenApiModels(
  document: unknown,
  validationEnabled = true,
  dates: OpenApiDates = 'date',
): OpenApiModelAnalysis {
  const resources = collectCanonicalResources(document);
  const { definitions, ordered, diagnostics, selections } = collectOpenApiModelDefinitions(document, resources);
  const { schemaGraph, nodeIdByDefinition } = internOpenApiSchemaGraph(document, ordered, definitions, validationEnabled, resources, selections, dates);
  const nodes = [...schemaGraph.nodes.values()];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const { nodesByName, definitionNameByNodeId } = nodesByDefinitionName(schemaGraph, nodeIdByDefinition);
  const nodesByCodecId = new Map(nodes.map((node) => [node.codecId, node]));
  const grouping = schemaGraphGroups(schemaGraph, definitions, nodesByName, definitionNameByNodeId);
  return { definitions, ordered, schemaGraph, grouping, resources, nodesById, nodesByName, definitionNameByNodeId, nodesByCodecId, diagnostics, selections, dates };
}

function openApiValidationSchemaClosure(
  schemaGraph: SchemaGraph,
  definitions: readonly ModelDefinition[],
  stableId: (definition: ModelDefinition) => string,
): CodecSchemaClosureEntry[] {
  const idsByName = new Map(definitions.map((definition) => [definition.name, stableId(definition)]));
  const nodesByCodecId = new Map([...schemaGraph.nodes.values()].map((node) => [node.codecId, node]));
  const compact = (value: unknown, wire: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => compact(item, wire));
    if (value === null || typeof value !== 'object') return value;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$defs' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        const definitions = Object.create(null) as Record<string, unknown>;
        for (const [name, schema] of Object.entries(child)) {
          const node = nodesByCodecId.get(name);
          definitions[name] = node
            ? { $ref: wire && !node.sameSchema ? `${node.codecId}#wire` : node.codecId }
            : compact(schema, wire);
        }
        result[key] = definitions;
      } else {
        result[key] = compact(child, wire);
      }
    }
    return result;
  };
  const asJsonSchema = (value: unknown): JsonSchema => {
    if (typeof value === 'boolean' || isJsonObject(value)) return value;
    throw new TypeError('Generated OpenAPI codec schema must be a JSON Schema object or boolean.');
  };
  return [...schemaGraph.nodes.values()]
    .filter((node) => node.kind !== 'reference')
    .sort((left, right) => left.codecId.localeCompare(right.codecId))
    .map((node) => ({
      codecId: node.codecId,
      modelSchema: asJsonSchema(compact(node.modelJsonSchema ?? node.jsonSchema, false)),
      ...(node.sameSchema ? {} : { wireSchema: asJsonSchema(compact(node.jsonSchema, true)) }),
      ...(node.modelOnlyJsonSchema === undefined ? {} : { modelOnlySchema: asJsonSchema(compact(node.modelOnlyJsonSchema, false)) }),
      ...(node.wireOnlyJsonSchema === undefined ? {} : { wireOnlySchema: asJsonSchema(compact(node.wireOnlyJsonSchema, true)) }),
      aliases: [...new Set([
        node.id,
        node.name,
        node.codecId,
        ...(idsByName.has(node.name) ? [idsByName.get(node.name) ?? ''] : []),
      ].filter(Boolean))],
    }));
}

function schemaGraphView(
  graph: SchemaGraph,
  nodeIds: ReadonlySet<string>,
  dependencyIds: ReadonlySet<string> = new Set(),
): SchemaGraph {
  const nodes = new Map<string, SchemaNode>();
  for (const [id, node] of graph.nodes) {
    if (nodeIds.has(id)) nodes.set(id, node);
    else if (dependencyIds.has(id)) {
      nodes.set(id, {
        ...node,
        descriptor: { kind: 'generated-model', id: node.name },
        edges: [],
        emitClass: node.emitClass,
        kind: 'reference',
      });
    }
  }
  return {
    nodes,
    operations: new Map(),
    intern: graph.intern.bind(graph),
    nodeFor: graph.nodeFor.bind(graph),
    addOperation: graph.addOperation.bind(graph),
    seal: () => undefined,
    topo: () => graph.topo().flatMap((node) => {
      const emitted = nodes.get(node.id);
      return emitted ? [emitted] : [];
    }),
  };
}

interface SchemaGraphGroup {
  readonly id: string;
  readonly filename: string;
  readonly nodes: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
}

interface SchemaGraphGrouping {
  readonly groups: readonly SchemaGraphGroup[];
  readonly owner: ReadonlyMap<string, string>;
  readonly runtimeEdges: ReadonlyMap<string, ReadonlySet<string>>;
}

function schemaGraphGroups(
  schemaGraph: SchemaGraph,
  definitions: ReadonlyMap<string, ModelDefinition>,
  nodesByName: ReadonlyMap<string, SchemaNode>,
  definitionNameByNodeId: ReadonlyMap<string, string>,
): SchemaGraphGrouping {
  const runtimeEdges = new Map([...schemaGraph.nodes].map(([id, node]) => [id, new Set(node.edges)]));
  const addRuntimeEdge = (fromName: string, toName: string | undefined): void => {
    if (!toName) return;
    const from = nodesByName.get(fromName);
    const to = nodesByName.get(toName);
    if (!from || !to) return;
    runtimeEdges.get(from.id)?.add(to.id);
  };
  for (const definition of definitions.values()) {
    // Inheritance and discriminator dispatch produce runtime class references
    // that are not necessarily represented by codec-schema edges. Keep every
    // class-load cycle inside one ESM module so subclass/union initialization
    // cannot observe a partially initialized binding.
    addRuntimeEdge(definition.name, definition.baseName ?? undefined);
    for (const variant of definition.variants ?? []) addRuntimeEdge(definition.name, variant);
  }
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    const index = nextIndex++;
    indices.set(id, index);
    lowLinks.set(id, index);
    stack.push(id);
    onStack.add(id);
    for (const target of [...(runtimeEdges.get(id) ?? [])].sort()) {
      if (!schemaGraph.nodes.has(target)) continue;
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? index, lowLinks.get(target) ?? index));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? index, indices.get(target) ?? index));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component.sort());
  };
  for (const id of [...schemaGraph.nodes.keys()].sort()) if (!indices.has(id)) visit(id);

  const owner = new Map<string, string>();
  const groups = components.map((ids) => {
    const models = new Set(ids.flatMap((id) => {
      const model = definitionNameByNodeId.get(id);
      return model === undefined ? [] : [model];
    }));
    const id = `group-${hashGroup([...ids].map((nodeId) => schemaGraph.nodes.get(nodeId)?.codecId ?? nodeId))}`;
    for (const nodeId of ids) owner.set(nodeId, id);
    return { id, filename: `models/_${id}.ts`, nodes: new Set(ids), models };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return { groups, owner, runtimeEdges };
}

function hashGroup(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of [...ids].sort().join('\0')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function reachableSchemaNodes(
  schemaGraph: SchemaGraph,
  roots: ReadonlySet<string>,
  runtimeEdges?: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const result = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || result.has(id)) continue;
    result.add(id);
    for (const edge of runtimeEdges?.get(id) ?? schemaGraph.nodes.get(id)?.edges ?? []) pending.push(edge);
  }
  return result;
}

function generatedFunctionName(nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire'): string {
  if (functionName === 'stringify') return `stringify${nodeId}`;
  if (functionName === 'fill') return fillFunctionName(nodeId);
  return functionName === 'fromWire' ? `fromWireFormat${nodeId}` : `toWireFormat${nodeId}`;
}

function generatedCodeWithoutLiterals(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (literal) => literal.replace(/[^\n]/g, ' '),
  );
}

function pruneGeneratedImports(source: string): string {
  const lines = source.match(/^import[^\n]*(?:\n|$)/gm) ?? [];
  if (lines.length === 0) return source;
  const body = generatedCodeWithoutLiterals(source.replace(/^import[^\n]*(?:\n|$)/gm, ''));
  const uses = (name: string): boolean => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\w$])${escapedName}(?![\\w$])`).test(body);
  };
  const pruned = new Map<string, string>();
  for (const line of lines) {
    const named = line.match(/^(import\s+)(type\s+)?\{([^}]*)\}(\s+from\s+.+;)(\n?)$/);
    if (named) {
      const [, prefix, typeOnly, contents, suffix, newline] = named;
      const imported = (contents ?? '').split(',').map((specifier) => specifier.trim()).filter(Boolean);
      // An empty import list is deliberate: it only keeps a module in the program.
      if (imported.length === 0) {
        pruned.set(line, line);
        continue;
      }
      const retained = imported.filter((specifier) => {
        const withoutKind = specifier.replace(/^type\s+/, '');
        const localName = withoutKind.split(/\s+as\s+/).at(-1);
        return Boolean(localName && uses(localName));
      });
      pruned.set(line, retained.length
        ? `${prefix}${typeOnly ?? ''}{ ${retained.join(', ')} }${suffix}${newline ?? ''}`
        : '');
      continue;
    }
    const namespace = line.match(/^(import\s+(?:type\s+)?\*\s+as\s+)([A-Za-z_$][\w$]*)(\s+from\s+.+;)(\n?)$/);
    if (namespace) {
      pruned.set(line, uses(namespace[2] ?? '') ? line : '');
      continue;
    }
    // Side-effect imports are intentional: a group module's import of another group registers its codecs.
    pruned.set(line, line);
  }
  return source.replace(/^import[^\n]*(?:\n|$)/gm, (line) => pruned.get(line) ?? line);
}

export function generateOpenApiModelArtifacts(
  document: unknown,
  profile: OpenApiGenerationProfile,
  analysis: OpenApiModelAnalysis,
  helpers: { readonly copyAdditionalProperties?: boolean; readonly objectFromJSON?: boolean } = {},
): { readonly files: ReadonlyMap<string, string>; readonly entryReexports: string; readonly diagnostics: readonly GolemDiagnostic[] } {
  const { schemaGraph, definitions, ordered, grouping } = analysis;
  const { groups, owner, runtimeEdges } = grouping;
  const digest = sourceDigest(document);
  const stableId = (definition: ModelDefinition) =>
    `openapi:${digest.slice(0, 16)}#/components/schemas/${definition.schemaName}`;
  const validationClosure = profile.validation
    ? openApiValidationSchemaClosure(schemaGraph, ordered, stableId)
    : [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const groupForModel = new Map<string, string>();
  const definitionsByGroup = new Map<string, ModelDefinition[]>();
  for (const group of groups) for (const name of group.models) groupForModel.set(name, group.id);
  const sharedModelEnv = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates);
  for (const definition of ordered) {
    const node = analysis.nodesByName.get(definition.name);
    const groupId = node ? owner.get(node.id) : undefined;
    if (!groupId) continue;
    const items = definitionsByGroup.get(groupId) ?? [];
    items.push(definition);
    definitionsByGroup.set(groupId, items);
  }
  const dependenciesByGroup = new Map<string, Set<string>>();
  const exportedFillFunctionsByGroup = new Map<string, Set<string>>();
  const exportedInitializersByGroup = new Map<string, Set<string>>();
  for (const group of groups) {
    const dependencies = new Set([...reachableSchemaNodes(schemaGraph, group.nodes, runtimeEdges)]
      .filter((id) => !group.nodes.has(id)));
    dependenciesByGroup.set(group.id, dependencies);
    for (const nodeId of dependencies) {
      const node = schemaGraph.nodes.get(nodeId);
      const dependencyGroupId = owner.get(nodeId);
      if (!node || node.kind !== 'object' || !dependencyGroupId || dependencyGroupId === group.id) continue;
      const exports = exportedFillFunctionsByGroup.get(dependencyGroupId) ?? new Set<string>();
      exports.add(nodeId);
      exportedFillFunctionsByGroup.set(dependencyGroupId, exports);
    }
  }
  for (const group of groups) {
    const groupDefinitions = definitionsByGroup.get(group.id) ?? [];
    const initializerCalls = groupDefinitions.flatMap((definition) =>
      [...definition.properties.values()].map((schema) => modelInitExpression(schema, 'value', definitions, sharedModelEnv)),
    ).join('\n');
    for (const match of initializerCalls.matchAll(/\binitialize([A-Za-z_$][\w$]*)\(/g)) {
      const initializerName = match[1];
      if (!initializerName || group.models.has(initializerName)) continue;
      const initializerGroupId = groupForModel.get(initializerName);
      if (!initializerGroupId || initializerGroupId === group.id) continue;
      const exports = exportedInitializersByGroup.get(initializerGroupId) ?? new Set<string>();
      exports.add(initializerName);
      exportedInitializersByGroup.set(initializerGroupId, exports);
    }
  }
  const files = new Map<string, string>();
  const diagnostics: GolemDiagnostic[] = [];
  const codecExports = (name: string): string[] => {
    const node = analysis.nodesByName.get(name);
    if (!node) return [];
    const aliases: readonly (readonly [string, string])[] = [
      [`stringify${node.id}`, `stringify${name}`],
      [`parse${node.id}`, `parse${name}`],
      [`fromWireFormat${node.id}`, `fromWireFormat${name}`],
      [`toWireFormat${node.id}`, `toWireFormat${name}`],
      [`validate${node.id}`, `validate${name}`],
      [`assert${node.id}`, `assert${name}`],
      [`encode${name}`, `encode${name}`],
    ];
    return aliases.map(([local, exported]) => local === exported ? local : `${local} as ${exported}`);
  };
  for (const group of groups) {
    const localIds = group.nodes;
    const dependencyIds = dependenciesByGroup.get(group.id) ?? new Set<string>();
    const importsByModule = new Map<string, Set<string>>();
    const addImport = (moduleName: string, name: string): void => {
      const values = importsByModule.get(moduleName) ?? new Set<string>();
      values.add(name);
      importsByModule.set(moduleName, values);
    };
    for (const nodeId of dependencyIds) {
      const node = schemaGraph.nodes.get(nodeId);
      const dependencyGroupId = owner.get(nodeId);
      const dependencyGroup = dependencyGroupId ? groupById.get(dependencyGroupId) : undefined;
      if (!node || !dependencyGroup || dependencyGroupId === group.id) continue;
      const codecModule = `./_${dependencyGroup.id}.js`;
      for (const functionName of ['stringify', 'fromWire', 'toWire'] as const) {
        addImport(codecModule, generatedFunctionName(node.id, functionName));
      }
      if (node.kind === 'object') addImport(codecModule, generatedFunctionName(node.id, 'fill'));
      const modelName = analysis.definitionNameByNodeId.get(nodeId);
      if (node.emitClass && modelName !== undefined) {
        const modelModule = `./${modelName}.js`;
        addImport(modelModule, `${modelName}Model`);
        for (const suffix of ['Fields', 'JSON', 'Init'] as const) {
          addImport(modelModule, `type ${modelName}${suffix}`);
        }
      }
    }
    const groupDefinitions = definitionsByGroup.get(group.id) ?? [];
    for (const definition of groupDefinitions) {
      if (!definition.baseName) continue;
      const baseGroupId = groupForModel.get(definition.baseName);
      if (!baseGroupId || baseGroupId === group.id) continue;
      addImport(`./${definition.baseName}.js`, `${definition.baseName}Model`);
      addImport(`./${definition.baseName}.js`, `type ${definition.baseName}Fields`);
      addImport(`./_${baseGroupId}.js`, `encode${definition.baseName}`);
    }
    const initializerCalls = groupDefinitions.flatMap((definition) =>
      [...definition.properties.values()].map((schema) => modelInitExpression(schema, 'value', definitions, sharedModelEnv)),
    ).join('\n');
    for (const match of initializerCalls.matchAll(/\binitialize([A-Za-z_$][\w$]*)\(/g)) {
      const initializerName = match[1];
      if (!initializerName || group.models.has(initializerName)) continue;
      const initializerGroup = groupForModel.get(initializerName);
      if (initializerGroup && initializerGroup !== group.id) {
        addImport(`./_${initializerGroup}.js`, `initialize${initializerName}`);
      }
    }
    const moduleImports = [...importsByModule]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([moduleName, imports]) => `import { ${[...imports].sort().join(', ')} } from ${JSON.stringify(moduleName)};`);
    const dependencyGroups = new Set([...dependencyIds].flatMap((nodeId) => {
      const dependencyGroupId = owner.get(nodeId);
      return dependencyGroupId && dependencyGroupId !== group.id ? [dependencyGroupId] : [];
    }));
    for (const dependencyGroupId of [...dependencyGroups].sort()) {
      // A dependency may be needed only for schema registration. Importing its
      // group for side effects ensures its codec exists before addNestedCodecSchema
      // resolves the closure; named imports are still pruned to actual calls.
      moduleImports.push(`import ${JSON.stringify(`./_${dependencyGroupId}.js`)};`);
    }
    const validatorModule = `${group.filename.slice(0, -3)}.validators.generated.ts`;
    let groupPlan: CodecValidationPlan | undefined;
    if (profile.validation) {
      const dependencyCodecIds = new Set([...dependencyIds].flatMap((id) => {
        const node = schemaGraph.nodes.get(id);
        return node ? [node.codecId] : [];
      }));
      const externalCodecs = validationClosure.filter((entry) => dependencyCodecIds.has(entry.codecId));
      groupPlan = buildCodecValidationPlan(
        schemaGraphView(schemaGraph, localIds, dependencyIds),
        externalCodecs,
      );
      const compiled = compilePlanValidators(groupPlan, {
        owner: '@exprtlabs/golem-openapi',
        unknownFormats: profile.unknownFormats ?? 'warn',
        documentName: 'the OpenAPI document',
      });
      diagnostics.push(...compiled.diagnostics);
      files.set(validatorModule, compiled.source);
      moduleImports.push(`import { validators } from ${JSON.stringify(`./_${group.id}.validators.generated.js`)};`);
    }
    const modelModule = generateModels(document, profile, {
      ...helpers,
      copyAdditionalProperties: groupDefinitions.some((definition) => Boolean(definition.additionalProperties)),
      objectFromJSON: group.models.size === 0 ? false : helpers.objectFromJSON,
      analysis,
      onlyNames: group.models,
      graphNodeIds: localIds,
      dependencyNodeIds: dependencyIds,
      moduleFile: group.filename,
      moduleImports,
      codecFunctionImport: (nodeId, functionName) => {
        const dependencyGroupId = owner.get(nodeId);
        if (!dependencyGroupId || dependencyGroupId === group.id) return undefined;
        return generatedFunctionName(nodeId, functionName);
      },
      exportedFillFunctionIds: exportedFillFunctionsByGroup.get(group.id),
      exportedInitializerNames: exportedInitializersByGroup.get(group.id),
      ...(groupPlan ? { resolvedSchemas: Object.fromEntries(groupPlan.ownSchemas.map((id) => [id, groupPlan.schemas[id]])) } : {}),
    });
    files.set(group.filename, modelModule);
    for (const name of group.models) {
      const filename = `models/${name}.ts`;
      const runtimeExports = codecExports(name);
      files.set(filename, `${generatedBanner()}\nexport { ${name}Model${runtimeExports.length ? `, ${runtimeExports.join(', ')}` : ''} } from './_${group.id}.js';\nexport type { ${name}Fields, ${name}JSON, ${name}Init } from './_${group.id}.js';\n`);
    }
  }
  const reexports = ordered.map((definition) =>
    `export { ${definition.name}Model, ${codecExports(definition.name).map((name) => name.includes(' as ') ? name.slice(name.indexOf(' as ') + 4) : name).join(', ')} } from './models/${definition.name}.js';\nexport type { ${definition.name}Fields, ${definition.name}JSON, ${definition.name}Init } from './models/${definition.name}.js';`,
  );
  return { files, entryReexports: reexports.join('\n'), diagnostics };
}

/**
 * A union model's decoder and initializer use the shared union conversion,
 * which dispatches on the discriminator table (or inferred required literal
 * tags) and rejects an unknown tag.
 */
function unionConversion(
  definition: ModelDefinition,
  direction: 'fromJSON' | 'fromInit',
  definitions: ReadonlyMap<string, ModelDefinition>,
  env: ModelResolveEnv,
): string {
  const descriptor = modelConversionDescriptor(definition.rawSchema, definitions, env, 'from');
  const resolve = (reference: string) => modelResolver(reference, definitions);
  try {
    return direction === 'fromJSON'
      ? emitModelFromJSON(descriptor, 'value', resolve, TEMPORAL_SERDE)
      : emitModelFromInit(descriptor, 'value', resolve);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const named = `schema ${JSON.stringify(definition.schemaName)}`;
    throw new LocatedError(
      `${named}: ${message} Declare an OpenAPI discriminator (propertyName and mapping) on the oneOf/anyOf, or give each variant a required const tag.`,
      [componentOrigin('schemas', definition.schemaName, named)],
      { cause: error },
    );
  }
}

/**
 * Emit codecs for a module. When the shared emitter rejects a conversion,
 * re-emit node by node to name the OpenAPI schema that caused it.
 */
function emitSchemaCodecRuntime(
  graph: SchemaGraph,
  options: CodecRuntimeOptions,
  definitions: ReadonlyMap<string, ModelDefinition>,
): string {
  // Group modules import each other's codec functions, anonymous ones included.
  options = { ...options, exportAnonymousCodecs: true };
  try {
    return emitCodecRuntime(graph, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failing = graph.topo().find((node) => {
      try {
        emitCodecRuntime({ ...schemaGraphView(graph, new Set(graph.nodes.keys())), topo: () => [node] }, options);
        return false;
      } catch {
        return true;
      }
    });
    if (!failing) throw error;
    const definition = definitions.get(failing.name);
    const schemaName = definition?.schemaName ?? failing.name;
    const advice = /union/i.test(message)
      ? ' Declare an OpenAPI discriminator (propertyName and mapping) on the oneOf/anyOf, or give each object variant a required const tag.'
      : '';
    const named = `schema ${JSON.stringify(schemaName)}`;
    throw new LocatedError(`${named}: ${message}${advice}`, [componentOrigin('schemas', schemaName, named)], { cause: error });
  }
}

export function generateModels(
  document: unknown,
  profile: OpenApiGenerationProfile,
  helpers: {
    readonly copyAdditionalProperties?: boolean;
    readonly objectFromJSON?: boolean;
    readonly analysis?: OpenApiModelAnalysis;
    readonly onlyNames?: ReadonlySet<string>;
    readonly graphNodeIds?: ReadonlySet<string>;
    readonly dependencyNodeIds?: ReadonlySet<string>;
    readonly moduleFile?: string;
    readonly modelImport?: (name: string) => string | undefined;
    readonly codecFunctionImport?: (nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire') => string | undefined;
    readonly moduleImports?: readonly string[];
    /** The validation plan's resolved schemas of this module's models by codec id and plane. */
    readonly resolvedSchemas?: Readonly<Record<string, object | boolean>>;
    readonly exportedFillFunctionIds?: ReadonlySet<string>;
    readonly exportedInitializerNames?: ReadonlySet<string>;
  } = {},
): string {
  requireProfile(profile);
  const analysis = helpers.analysis ?? analyzeOpenApiModels(document, profile.validation);
  const definitions = analysis.definitions;
  const ordered = helpers.onlyNames
    ? analysis.ordered.filter((definition) => helpers.onlyNames?.has(definition.name))
    : analysis.ordered;
  const moduleScope = new ComponentNameScope('models.ts');
  const emitObjectFromJSON = helpers.objectFromJSON !== false;
  const emitCopy = helpers.copyAdditionalProperties === true
    || (helpers.copyAdditionalProperties === undefined
      && ordered.some((definition) => definition.additionalProperties));
  if (emitObjectFromJSON) moduleScope.claim('objectFromJSON', 'internal helper objectFromJSON');
  if (emitCopy) moduleScope.claim('copyAdditionalProperties', 'internal helper copyAdditionalProperties');
  moduleScope.claim('Types', 'import binding Types');
  moduleScope.claim('ModelInit', 'import binding ModelInit');
  const reservedMembers = new Set(RESERVED_MODEL_MEMBERS);
  const sharedModelEnv = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates);
  const usesDate = ordered.some(definition => [...definition.properties.values(), definition.additionalProperties].some(schema => /\bDate\b/.test(modelFieldType(schema, definitions, sharedModelEnv))));
  const initializerCalls = ordered.flatMap(definition => [...definition.properties.values()].map(schema => modelInitExpression(schema, 'value', definitions, sharedModelEnv))).join('\n');
  const schemaGraph = analysis.schemaGraph;
  const emittedSchemaGraph = helpers.graphNodeIds
    ? schemaGraphView(schemaGraph, helpers.graphNodeIds, helpers.dependencyNodeIds)
    : schemaGraph;
  const codecIdFor = (name: string): string => {
    const node = analysis.nodesByName.get(name);
    return node?.codecId ?? name;
  };
  const output = [
    generatedBanner(),
    ...(profile.validation && profile.mobx ? ["import { enhanceValidatorWithMobX } from '@exprtlabs/golem/mobx-validation';"] : []),
    `import { registerGeneratedModel, type ModelInit, type GeneratedModelConstructor, type generatedModelWireBrand, type generatedModelFieldsBrand${ordered.some(definition => definition.isUnion) ? ", type generatedModelResultBrand" : ""}${emitCopy ? ", findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor" : ""} } from '@exprtlabs/golem/model';`,
    `import { assertPropertyAcyclic, assertWireAcyclic, beginDecode, convertModelField, decodeCheckedInput, decodeDetachedInput, endDecode, decodeGeneratedModelTrusted, defineModelProperty, encodeGeneratedModel${usesDate ? ", deserializeDate, serializeDate" : ""} } from '@exprtlabs/golem/conversion';`,
    "import { assertModelValue, createObjectCodec, isValidModelValue, modelValueIssues, parseJson, registerIModelClass, requireIModelClass, requireModelValidator, requireObjectCodec, resolveGeneratedModelSchemaRefs, serdeFailFast, serdeValidates, stringifyJsonArray, stringifyJsonBoolean, stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString, validationFailure, validationUnavailable, IssueRepresentation, IssueSource, type SerdeOptions as __GolemSerdeOptions, type ValidateOptions as __GolemValidateOptions } from '@exprtlabs/golem/serde';",
    ...(profile.mobx ? [
      "import { asGenObservable } from '@exprtlabs/golem/mobx';",
    ] : []),
    `import type * as Types from '${helpers.moduleFile?.includes('/') ? '../types.js' : './types.js'}';`,
    ...(helpers.moduleImports ?? []),
    '',
    ...(emitObjectFromJSON ? [
      'function objectFromJSON<T extends object>(json: unknown, modelName: string): Partial<T> {',
      '  return requireModelObject(json, modelName) as Partial<T>;',
      '}',
      '',
    ] : []),
    ...(emitCopy ? [
      'function copyAdditionalProperties(target: object, source: object, known: readonly string[], convert?: (value: unknown) => unknown): void {',
      '  for (const [name, value] of Object.entries(source)) {',
      '    if (known.includes(name)) continue;',
      '    Object.defineProperty(target, name, { value: convert ? convert(value) : value, enumerable: true, configurable: true, writable: true });',
      '  }',
      '}',
      '',
    ] : []),
  ];
  const sharedSchemaContext = schemaContext(document, { resources: analysis.resources });

  for (const definition of ordered) {
    const anchors = schemaContext(
      document,
      sharedSchemaContext,
      definition.schemaName,
      definition.rawSchema,
    ).anchors;
    const env = modelEnv(document, undefined, anchors, analysis.resources, analysis.selections, analysis.dates);
    const fieldEnv = withSchemaBase(env, definition.rawSchema);
    const typeName = definition.name;
    const className = `${typeName}Model`;
    const variantUnion = (definition.variants ?? []).map(variant => `${variant}Model`).join(' | ');
    moduleScope.claim(className, `generated model ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    for (const suffix of ['Fields', 'JSON', 'Init']) {
      moduleScope.claim(`${typeName}${suffix}`, `generated ${suffix} type for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    }
    moduleScope.claim(`decode${typeName}`, `internal decoder for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    moduleScope.claim(`encode${typeName}`, `internal encoder for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    const classScope = new NameScope(`${className} members`);
    const baseClass = definition.baseName ? `${definition.baseName}Model` : null;
    const fields = [...definition.properties.entries()];
    for (const [name] of fields) {
      classScope.rejectReserved(name, `field ${JSON.stringify(name)} on ${className}`, reservedMembers, 'generated model API member');
      classScope.claim(name, `field ${JSON.stringify(name)}`);
    }
    const additionalPropertyType = definition.additionalProperties === true
      ? 'unknown'
      : isJsonObject(definition.additionalProperties)
        ? modelFieldType(definition.additionalProperties, definitions, fieldEnv)
        : null;
    const implementsType = definition.isUnion || (additionalPropertyType && additionalPropertyType !== 'unknown') ? '' : ` implements ${typeName}Fields`;
    const declarations = fields.map(([name, schema]) =>
      modelFieldDeclaration(name, schema, definition.required.has(name), definitions, fieldEnv),
    );
    const assignments = fields.map(([name, schema]) =>
      `    if (${modelPropertyCondition('values', name)}) ${modelPropertyAssignment('this', name, `(${modelInitExpression(schema, `values${modelPropertyAccess(name)}`, definitions, fieldEnv)}) as ${modelFieldType(schema, definitions, fieldEnv)}`)}`,
    );
    const fieldHelpers: string[] = [];
    const fieldHelperName = (direction: 'encode' | 'decode') => (index: number): string => {
      const helper = `convert${typeName}Field${index}${direction === 'encode' ? 'Encode' : 'Decode'}`;
      moduleScope.claim(helper, `internal field converter for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
      return helper;
    };
    const jsonProperties = fields.map(([name, schema]) => {
      const input = `model${modelPropertyAccess(name)}`;
      const converted = rootFieldConversion(
        fieldHelpers, fieldHelperName('encode'), 'serialize', name, input,
        (value) => modelToJSONExpression(schema, value, definitions, fieldEnv),
        // The guard on the property excludes an undefined value before the conversion runs.
        `Exclude<${className}${modelPropertyAccess(name)}, undefined>`,
      );
      return `  if (${modelPropertyCondition('model', name)}) ${modelPropertyAssignment('result', name, converted)}`;
    });
    const allProperties = modelSchemaProperties(fieldEnv, definition.rawSchema);
    const allFieldNames = [...allProperties.keys()];
    const fieldNames = allFieldNames.map(name => JSON.stringify(name)).join(', ');
    const additionalConverter = (direction: 'from' | 'init' | 'to'): string => {
      if (!isJsonObject(definition.additionalProperties)) return '';
      const emit = direction === 'from' ? modelFromJSONExpression : direction === 'init' ? modelInitExpression : modelToJSONExpression;
      const expression = emit(definition.additionalProperties, 'value', definitions, fieldEnv);
      return expression === 'value' ? '' : `, (value) => ${expression}`;
    };
    const decodeLines = [...allProperties].flatMap(([name, schema]) => {
      const expression = `value${modelPropertyAccess(name)}`;
      const rootConverted = rootFieldConversion(
        fieldHelpers, fieldHelperName('decode'), 'deserialize', name, expression,
        (input) => modelFromJSONExpression(schema, input, definitions, fieldEnv),
        'unknown',
      );
      // `result` already contains every own enumerable input property.  Keep
      // the initializer copy as-is for fields with no wire conversion and
      // only replace values that must become model instances or pass through
      // a codec.  The constructor remains the sole model-instance writer.
      return rootConverted === expression
        ? []
        : [`  if (${modelPropertyCondition('value', name)}) ${modelPropertyAssignment('result', name, rootConverted)}`];
    });
    const additionalFrom = additionalConverter('from');
    const identityDeserialize = decodeLines.length === 0 && additionalFrom === '';
    output.push(
      `export type ${typeName}Fields = ${definition.baseName ? `${definition.baseName}Fields & ` : ''}{`,
      ...fields.map(([name, schema]) => `  ${propertyName(name)}${definition.required.has(name) ? '' : '?'}: ${modelFieldType(schema, definitions, fieldEnv)};`),
      ...(additionalPropertyType ? [`  [key: string]: ${fields.length || definition.baseName ? 'unknown' : additionalPropertyType};`] : []),
      '};',
      `export type ${typeName}JSON = Types.${typeName};`,
      `export type ${typeName}Init = ModelInit<${typeName}Fields>;`,
      '',
      ...fieldHelpers.flatMap(helper => [helper, '']),
      ...(!definition.isUnion ? [
        `function deserialize${typeName}Fields(json: unknown): ${typeName}Init {`,
        `  const value = objectFromJSON<Record<string, unknown>>(json, ${JSON.stringify(className)});`,
        ...(identityDeserialize
          ? [`  return value as ${typeName}Init;`]
          : [
            '  const result: Record<string, unknown> = { ...value };',
            ...decodeLines,
            ...(additionalFrom ? [`  copyAdditionalProperties(result, value, [${fieldNames}]${additionalFrom});`] : []),
            `  return result as ${typeName}Init;`,
          ]),
        '}',
        '',
      ] : definition.isUnion ? [
        ...(initializerCalls.includes(`initialize${typeName}(`) || helpers.exportedInitializerNames?.has(typeName) ? [
          `${helpers.moduleFile ? 'export ' : ''}function initialize${typeName}(json: unknown): ${variantUnion} {`,
          `  const value = objectFromJSON<Record<string, unknown>>(json, ${JSON.stringify(className)});`,
          `  const initialized: unknown = ${unionConversion(definition, 'fromInit', definitions, env)};`,
          `  return initialized as ${variantUnion};`,
          '}',
          '',
        ] : []),
      ] : []),
      `export ${definition.isUnion ? 'abstract ' : ''}class ${className}${baseClass ? ` extends ${baseClass}` : ''}${implementsType} {`,
      ...(additionalPropertyType && additionalPropertyType !== 'unknown'
        ? ['  /** Dynamic map values are preserved during conversion. */']
        : additionalPropertyType ? ['  [key: string]: unknown;'] : []),
      ...declarations,
      `  declare readonly [generatedModelWireBrand]: Types.${typeName};`,
      `  declare readonly [generatedModelFieldsBrand]: ${typeName}Fields;`,
      ...(definition.isUnion ? [`  declare static readonly [generatedModelResultBrand]: ${variantUnion};`] : []),
      `  constructor(values: ${typeName}Init = {}) {`,
      ...(baseClass ? ['    super(values);'] : []),
      ...assignments,
      ...(additionalPropertyType
        ? [`    if (findGeneratedModelDefinition(this) === findGeneratedModelDefinitionForConstructor(${className})) copyAdditionalProperties(this, values, [${fieldNames}]${additionalConverter('init')});`]
        : []),
      ...(profile.mobx && !definition.isUnion ? [
        `    if (new.target === ${className}) asGenObservable(this);`,
      ] : []),
      '  }',
      '',
      '}',
      '',
      ...(definition.isUnion ? [
        `function decode${typeName}(json: unknown): ${variantUnion} {`,
        `  const value = objectFromJSON<Types.${typeName}>(json, ${JSON.stringify(className)});`,
        `  const decoded: unknown = ${unionConversion(definition, 'fromJSON', definitions, env)};`,
        `  return decoded as ${variantUnion};`,
        '}',
      ] : [
        `function decode${typeName}(json: unknown, constructor: GeneratedModelConstructor = ${className}): ${className} {`,
        `  return Reflect.construct(constructor, [deserialize${typeName}Fields(json)]) as ${className};`,
        '}',
      ]),
      '',
      `${helpers.moduleFile ? 'export ' : ''}function encode${typeName}(model: ${className}): Types.${typeName} {`,
      baseClass ? `  const result: Record<string, unknown> = { ...encode${definition.baseName}(model) };` : '  const result: Record<string, unknown> = {};',
      ...jsonProperties,
      ...(additionalPropertyType
        ? [`  if (findGeneratedModelDefinition(model) === findGeneratedModelDefinitionForConstructor(${className})) copyAdditionalProperties(result, model, [${fieldNames}]${additionalConverter('to')});`]
        : []),
      `  return result as Types.${typeName};`,
      '}',
      '',
      '',
      ...([
        `registerGeneratedModel(${className}, {`,
        `  fields: [${allFieldNames.map((name) => JSON.stringify(name)).join(', ')}] as const,`,
        `  conversion: { decode: decode${typeName}, encode: encode${typeName} },`,
        `  codecId: ${JSON.stringify(codecIdFor(definition.name))},`,
        `  profile: ${JSON.stringify(profile)},`,
        ...(profile.validation && profile.mobx ? ['  enhanceValidator: enhanceValidatorWithMobX,'] : []),
        ...(additionalPropertyType ? ['  additionalProperties: true,'] : []),
        '});',
        '',
        `registerIModelClass(${JSON.stringify(codecIdFor(definition.name))}, ${className});`,
        '',
      ]),
    );
  }
  if (helpers.resolvedSchemas) {
    output.push(`const modelSchemas = JSON.parse(${JSON.stringify(JSON.stringify(helpers.resolvedSchemas))}) as Readonly<Record<string, object>>;`, '');
  }
  const codecRuntimeOptions: CodecRuntimeOptions = {
    validationEnabled: profile.validation,
    serde: TEMPORAL_SERDE,
    ...(helpers.resolvedSchemas ? { resolvedSchemasExpr: 'modelSchemas' } : {}),
    issueSource: 'OpenAPI',
    wireType: (node) => {
      const modelName = analysis.definitionNameByNodeId.get(node.id);
      return modelName !== undefined && definitions.has(modelName) ? `Types.${modelName}` : undefined;
    },
    fieldsType: (node) => {
      const modelName = analysis.definitionNameByNodeId.get(node.id);
      return modelName !== undefined && definitions.has(modelName) ? `${modelName}Fields` : undefined;
    },
    ...(helpers.exportedFillFunctionIds ? { exportedFillFunctionIds: helpers.exportedFillFunctionIds } : {}),
    nestedConstruct: (codecId) => {
      const node = analysis.nodesByCodecId.get(codecId)
        ?? analysis.nodesByName.get(codecId)
        ?? analysis.nodesById.get(codecId);
      const modelName = node ? analysis.definitionNameByNodeId.get(node.id) ?? node.name : codecId;
      return helpers.modelImport?.(modelName) ?? `${modelName}Model`;
    },
    nestedGenerated: (name) => {
      const node = analysis.nodesByName.get(name)
        ?? analysis.nodesById.get(name)
        ?? analysis.nodesByCodecId.get(name);
      const modelName = node ? analysis.definitionNameByNodeId.get(node.id) ?? node.name : name;
      return node?.emitClass ? (helpers.modelImport?.(modelName) ?? `${modelName}Model`) : 'undefined';
    },
    nestedImportedSerde: (codecId) => {
      if (!helpers.codecFunctionImport) return undefined;
      const node = analysis.nodesByCodecId.get(codecId) ?? analysis.nodesById.get(codecId);
      if (!node || helpers.graphNodeIds?.has(node.id)) return undefined;
      const stringify = helpers.codecFunctionImport(node.id, 'stringify');
      const fill = helpers.codecFunctionImport(node.id, 'fill');
      const fromWire = helpers.codecFunctionImport(node.id, 'fromWire');
      const toWire = helpers.codecFunctionImport(node.id, 'toWire');
      return stringify && fromWire && toWire
        ? { stringify, fromWire, toWire, ...(fill ? { fill } : {}) }
        : undefined;
    },
  };
  output.push(emitSchemaCodecRuntime(emittedSchemaGraph, codecRuntimeOptions, definitions));
  const source = output.join('\n').trim();
  // Only import converter helpers actually used by this model graph. A converter passed to `convertModelField` is referenced, not called.
  const sourceBody = source.replace(/^import \{[^\n]+\} from '@exprtlabs\/golem\/conversion';\n/m, '');
  const conversionImports = [
    'assertAcyclicValue', 'assertPropertyAcyclic', 'assertWireAcyclic', 'beginDecode', 'decodeCheckedInput', 'decodeDetachedInput', 'endDecode', 'convertModelField', 'decodeGeneratedModel', 'decodeGeneratedModelTrusted', 'defineModelProperty', 'encodeGeneratedModel', 'deserializeDate', 'serializeDate', 'unknownDiscriminatorValue', 'withDiscriminatorValue', 'jsonWithDiscriminator', 'requireModelObject',
  ].filter(name => new RegExp(`\\b${name}\\b`).test(sourceBody));
  // `dates: temporal` fields call their codecs from `@exprtlabs/golem/temporal`; import exactly those used.
  const temporalImports = [...new Set(source.match(/\b(?:de)?serializeTemporal[A-Za-z]+(?=\()/g) ?? [])].sort();
  const temporalImport = temporalImports.length ? `import { ${temporalImports.join(', ')} } from '@exprtlabs/golem/temporal';\n` : '';
  const trimmed = source.replace(/^import \{[^\n]+\} from '@exprtlabs\/golem\/conversion';\n/m,
    (conversionImports.length ? `import { ${conversionImports.join(', ')} } from '@exprtlabs/golem/conversion';\n` : '') + temporalImport);
  return pruneGeneratedImports(`${trimmed}\n`);
}

/** The runtime codec id of a model: what the manifest records and a rewrite stamps. */
function openApiCodecId(analysis: OpenApiModelAnalysis, name: string): string {
  return analysis.nodesByName.get(name)?.codecId ?? codecPublicId(name, { kind: 'unknown' }, undefined, { source: 'openapi', constructs: true });
}

export type { OpenApiSchema };
