import { assertSupportedModelFieldName } from '@exprtlabs/golem/internal/schema';
import { asRecord, isJsonObject, objectEntries } from './json.js';
import { GolemDiagnosticSeverity, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { identifier } from '@exprtlabs/golem/internal/generator-support';
import { ComponentNameScope } from './origin.js';
import { resolveLocal } from './normalize.js';
import type { ResourceIndex } from './schema-projection.js';
import {
  type ModelDefinition,
  type RecursiveAlias,
  ModelDefinitions,
  type DiscriminatorSelections,
  type ModelResolveEnv,
  modelEnv,
  withSchemaBase,
  directComponentSchemaRef,
  componentSchemaTarget,
  modelSchemaProperties,
  visitAllOfChain,
  hasAllOfMembers,
  componentSite,
  discriminatorSelection,
  checkComposition,
  convertedSubschemas,
  partSchemaTarget,
  type OpenApiDates,
} from './model-resolution.js';

function isModelSchema(env: ModelResolveEnv, schema: unknown, visiting = new Set<unknown>()): boolean {
  if (!isJsonObject(schema) || visiting.has(schema)) return false;
  visiting.add(schema);
  const nested = withSchemaBase(env, schema);
  const target = componentSchemaTarget(schema, nested);
  if (target !== undefined && target !== schema) return isModelSchema(nested, target, visiting);
  // An allOf beside the schema's own union, or with a union member, is a union of objects, not a class that extends the allOf.
  if (hasAllOfMembers(schema) && (schema.oneOf !== undefined || schema.anyOf !== undefined || schema.allOf.some(isInlineUnion))) return false;
  if (schema.type === 'object' || schema.properties || schema.additionalProperties !== undefined) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.some((item) => isModelSchema(nested, item, visiting));
  }
  return false;
}

function isInlineUnion(schema: unknown): boolean {
  return isJsonObject(schema) && (schema.oneOf !== undefined || schema.anyOf !== undefined);
}

/**
 * The non-model components that reach themselves through `$ref`, found once before the type and conversion walks.
 * A model reference ends a path, as it ends the walks; only the keywords the walks follow count. A non-recursive
 * non-model component is not named: each use inlines it.
 */
function findRecursiveAliases(env: ModelResolveEnv): ReadonlyMap<string, RecursiveAlias> {
  const schemas = asRecord(asRecord(asRecord(env.document).components).schemas);
  const components = new Map<string, { readonly schemaName: string; readonly rawSchema: unknown }>();
  for (const [schemaName, rawSchema] of objectEntries(schemas)) {
    if (!isModelSchema(env, resolveLocal(env.document, rawSchema))) components.set(identifier(schemaName), { schemaName, rawSchema });
  }
  const edgesOf = new Map<string, ReadonlySet<string>>();
  const collect = (schema: unknown, scope: ModelResolveEnv, edges: Set<string>, parts = new Set<unknown>()): void => {
    if (!isJsonObject(schema)) return;
    const nested = withSchemaBase(scope, schema);
    const reference = directComponentSchemaRef(schema, nested);
    if (reference) {
      if (components.has(reference)) edges.add(reference);
      return;
    }
    // A reference to part of a component (a property, a nested anchor) continues in that part, as the conversion does.
    const part = partSchemaTarget(schema, nested);
    if (part) {
      if (!parts.has(part.schema)) collect(part.schema, part.env, edges, new Set(parts).add(part.schema));
      return;
    }
    for (const { child } of convertedSubschemas(schema)) collect(child, nested, edges, parts);
  };
  const edges = (name: string): ReadonlySet<string> => {
    let found = edgesOf.get(name);
    if (!found) {
      const collected = new Set<string>();
      collect(components.get(name)?.rawSchema, env, collected);
      edgesOf.set(name, found = collected);
    }
    return found;
  };
  const reachesOwnName = (name: string): boolean => {
    const visited = new Set<string>();
    const pending = [...edges(name)];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next === name) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(...edges(next));
    }
    return false;
  };
  return new Map([...components].filter(([name]) => reachesOwnName(name)).map(([name, { schemaName, rawSchema }]) => [name, { name, schemaName, rawSchema }]));
}

/** The component schemas that the allOf refers to, in order. */
function modelBaseSchemaNames(schema: unknown, env: ModelResolveEnv): string[] {
  const record = asRecord(schema);
  const nested = withSchemaBase(env, schema);
  const candidates = Array.isArray(record.allOf) ? record.allOf : [schema];
  return candidates.flatMap((candidate) => directComponentSchemaRef(candidate, nested) ?? []);
}

function modelAdditionalProperties(
  env: ModelResolveEnv,
  rawSchema: unknown,
): unknown {
  let result: unknown;
  visitAllOfChain(env, rawSchema, (schema) => {
    if (schema.additionalProperties !== undefined) result = schema.additionalProperties;
  });
  return result;
}

export function collectOpenApiModelDefinitions(document: unknown, resources?: ResourceIndex, dates: OpenApiDates = 'date'): {
  definitions: ModelDefinitions;
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
  const env = modelEnv(document, undefined, undefined, resources, selections, dates);
  const definitions = new ModelDefinitions(findRecursiveAliases(env));
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
      otherBaseNames: [],
      variantOf: [],
      properties: new Map(),
      additionalProperties: null,
      required: new Set(),
    });
  }

  for (const definition of definitions.values()) {
    const [requestedBase, ...others] = modelBaseSchemaNames(definition.rawSchema, env);
    definition.baseName = requestedBase && definitions.has(requestedBase) && requestedBase !== definition.name
      ? requestedBase
      : null;
    definition.otherBaseNames = others.filter((name) => definitions.has(name) && name !== definition.name && name !== definition.baseName);
    definition.properties = modelSchemaProperties(env, definition.rawSchema, definition.baseName);
    for (const propertyName of definition.properties.keys()) assertSupportedModelFieldName(propertyName);
    definition.additionalProperties = modelAdditionalProperties(
      env,
      definition.rawSchema,
    );
    definition.required = new Set();
    // Base `required` fields still constrain a derived allOf schema when
    // that schema redeclares the field to narrow its type (for example,
    // a discriminator const). Collect them so the derived declaration
    // cannot become optional in the emitted TypeScript type.
    visitAllOfChain(env, definition.rawSchema, (schema) => {
      for (const property of Array.isArray(schema.required) ? schema.required : []) {
        definition.required.add(String(property));
      }
    });
  }

  // A union model is decided against declared inheritance only, so the result does not depend on
  // component order. A variant that one union selects takes that union as its base. A variant that
  // several unions select cannot take them all: it keeps its own base, and each of those unions
  // lists it as a variant.
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
      otherBaseNames: [],
      variantOf: [],
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
    for (const variant of new Set(union.variants)) claims.set(variant, (claims.get(variant) ?? 0) + 1);
  }
  for (const union of unions) {
    schemaScope.claim(union.name, `union schema ${JSON.stringify(union.schemaName)}`, union.schemaName);
    definitions.set(union.name, union);
    for (const variant of union.variants ?? []) {
      const child = definitions.get(variant);
      if (!child) continue;
      child.variantOf.push(union.name);
      if (claims.get(variant) === 1) child.baseName = union.name;
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
    }
  }

  // The composition check reads the unions: a variant that a union selects extends it, so a derived component narrows an
  // inherited union property to that variant. A union component itself is read at field position, as the schemas that refer
  // to it read it.
  for (const [rawName, rawSchema] of objectEntries(schemas)) {
    const definition = definitions.get(identifier(rawName));
    const model = definition?.schemaName === rawName && !definition.isUnion ? definition : undefined;
    checkComposition(componentSite(rawName), model ? model.rawSchema : rawSchema, model, definitions, document, resources, warn, env);
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
