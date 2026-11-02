/**
 * The query fields of a model that a query string decodes: `NestModelInterceptor` turns `?limit=10` into the number 10 for
 * a field the model declares as a number. The table is read from the wire schema at build time, so no codec carries a schema
 * at run time.
 */

import { compareText } from '@exprtlabs/golem/generator-api';
import { fragmentPointerTokens, GENERATED_MODEL_SCHEMA_REF_PREFIX, VALIDATION_KEYWORD, type JsonSchema } from '@exprtlabs/golem/internal/schema';
import { codecShortName, type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { QueryFieldShape, QueryFieldTable } from '../runtime/query-decode.js';

type SchemaRecord = Readonly<Record<string, unknown>>;
type QueryScalar = QueryFieldShape['types'][number];

/** The wire schema of a model or alias that the build holds outside the schema being read, by the name a `$ref` carries. */
export type QueryReferenceResolver = (name: string) => JsonSchema | undefined;

/** A schema with the root that its own `#/…` references resolve against. */
interface Scope {
  readonly resolve: QueryReferenceResolver;
  readonly root: unknown;
  /** The `$ref` targets being read now, from the field down through its array items: a target met again ends the descent. */
  readonly reading: Set<unknown>;
}

/** What a field's schema admits, reduced to what a query string can carry. */
interface FieldShape {
  readonly types: Set<string>;
  readonly literals: unknown[];
  item?: FieldShape;
  /** The shape of each position a tuple lists (`prefixItems`); `item` holds the entries after them. */
  prefix?: FieldShape[];
  /** The `items` of each array branch read so far, with the first position it covers: a position that a later branch lists takes them too. */
  rests?: { readonly from: number; readonly items: unknown; readonly scope: Scope }[];
}

const SCALARS: readonly QueryScalar[] = ['string', 'number', 'integer', 'boolean'];

function schemaRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as SchemaRecord : undefined;
}

function newShape(): FieldShape {
  return { types: new Set(), literals: [] };
}

/**
 * The schema a `$ref` names, with the root that its own local references resolve against: a JSON pointer into the root
 * schema (`#/$defs/Name`), or a model by the name the reference carries (a placeholder, or an id with its plane). An
 * unknown reference names nothing; the validator reports it.
 */
function resolveReference(reference: string, scope: Scope): { readonly schema: unknown; readonly scope: Scope } | undefined {
  if (reference === '#' || reference.startsWith('#/')) {
    let schema = scope.root;
    if (reference !== '#') {
      for (const key of fragmentPointerTokens(reference.slice(1))) {
        schema = typeof schema === 'object' && schema !== null && Object.hasOwn(schema, key)
          ? (schema as Record<string, unknown>)[key]
          : undefined;
      }
    }
    return schema === undefined ? undefined : { schema, scope };
  }
  const bare = reference.startsWith(GENERATED_MODEL_SCHEMA_REF_PREFIX) ? reference.slice(GENERATED_MODEL_SCHEMA_REF_PREFIX.length) : reference;
  const hash = bare.indexOf('#');
  const schema = scope.resolve(hash < 0 ? bare : bare.slice(0, hash));
  return schema === undefined ? undefined : { schema, scope: { ...scope, root: schema } };
}

/**
 * The positions that a tuple lists (`prefixItems`), and the `items` that follow them. A position decodes by every branch that
 * reaches it: the branch that lists it, and each branch whose `items` start at or before it, whichever branch is read first.
 */
function collectPositions(shape: FieldShape, listed: readonly unknown[], items: unknown, scope: Scope): void {
  if (listed.length > 0) {
    const prefix = shape.prefix ??= [];
    listed.forEach((position, index) => {
      if (prefix[index] === undefined) {
        prefix[index] = newShape();
        for (const earlier of shape.rests ?? []) if (earlier.from <= index) collectShape(earlier.items, prefix[index], earlier.scope);
      }
      collectShape(position, prefix[index], scope);
    });
  }
  if (items === undefined || items === false) return;
  const rest = { from: listed.length, items, scope };
  (shape.rests ??= []).push(rest);
  shape.prefix?.forEach((position, index) => { if (index >= rest.from) collectShape(items, position, scope); });
}

function collectShape(schema: unknown, shape: FieldShape, scope: Scope): void {
  if (schema === true) {
    shape.types.add('string');
    return;
  }
  const record = schemaRecord(schema);
  if (!record) return;
  const types = typeof record.type === 'string' ? [record.type] : Array.isArray(record.type) ? record.type : [];
  for (const type of types) if (typeof type === 'string') shape.types.add(type);
  if ('const' in record) shape.literals.push(record.const);
  if (Array.isArray(record.enum)) shape.literals.push(...record.enum);
  // An `items` keyword stands for an array also when the schema names no type.
  const listed: unknown[] = Array.isArray(record.prefixItems) ? record.prefixItems : [];
  if (types.includes('array') || record.items !== undefined || listed.length > 0) {
    shape.item ??= newShape();
    collectShape(record.items, shape.item, scope);
    collectPositions(shape, listed, record.items, scope);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = record[keyword];
    if (Array.isArray(branches)) for (const branch of branches) collectShape(branch, shape, scope);
  }
  collectShape(schemaRecord(record[VALIDATION_KEYWORD])?.schema, shape, scope);
  const target = typeof record.$ref === 'string' ? resolveReference(record.$ref, scope) : undefined;
  // A reference cycle adds nothing more.
  if (target !== undefined && !scope.reading.has(target.schema)) {
    scope.reading.add(target.schema);
    collectShape(target.schema, shape, target.scope);
    scope.reading.delete(target.schema);
  }
}

function collectFields(schema: unknown, fields: Map<string, FieldShape>, scope: Scope, seen = new Set<unknown>()): void {
  const record = schemaRecord(schema);
  // A reference cycle, or a branch met twice, adds no field.
  if (!record || seen.has(record)) return;
  seen.add(record);
  const properties = schemaRecord(record.properties);
  if (properties) {
    for (const [name, property] of Object.entries(properties)) {
      let shape = fields.get(name);
      if (!shape) {
        shape = newShape();
        fields.set(name, shape);
      }
      collectShape(property, shape, scope);
    }
  }
  const target = typeof record.$ref === 'string' ? resolveReference(record.$ref, scope) : undefined;
  if (target) collectFields(target.schema, fields, target.scope, seen);
  for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
    const branches = record[keyword];
    if (Array.isArray(branches)) for (const branch of branches) collectFields(branch, fields, scope, seen);
  }
  collectFields(schemaRecord(record[VALIDATION_KEYWORD])?.schema, fields, scope, seen);
}

/** Whether a query string (scalar) can decode to something other than itself. */
function decodesScalar(shape: FieldShape): boolean {
  if (shape.types.has('string')) return false;
  return shape.types.has('number') || shape.types.has('integer') || shape.types.has('boolean')
    || shape.literals.some((value) => typeof value === 'number' || typeof value === 'boolean');
}

/** Whether the field can decode to a value different from its string. */
function decodesField(shape: FieldShape): boolean {
  if (decodesScalar(shape)) return true;
  if (!shape.item) return false;
  // A single string becomes a one-item array unless the field also admits a string.
  return !shape.types.has('string') || decodesScalar(shape.item) || (shape.prefix?.some(decodesScalar) ?? false);
}

function tableShape(shape: FieldShape): QueryFieldShape {
  const types = SCALARS.filter((type) => shape.types.has(type));
  // A field that admits a string returns its text first, so its literals decide nothing.
  const literals = types.includes('string')
    ? []
    : [...new Set(shape.literals)].filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
  return {
    types,
    ...(literals.length > 0 ? { literals } : {}),
    ...(shape.item ? { item: tableShape(shape.item) } : {}),
    ...(shape.prefix ? { prefix: shape.prefix.map(tableShape) } : {}),
  };
}

/**
 * The fields of a model's wire schema that a query string decodes, or undefined when it has none. `resolve` names the
 * schema of a model that lives outside the wire schema, such as the base of a model in another file.
 * A reference into the wire schema itself (`#/$defs/Name`) resolves against it.
 */
export function queryFieldTable(wireSchema: JsonSchema, resolve: QueryReferenceResolver): QueryFieldTable | undefined {
  const fields = new Map<string, FieldShape>();
  collectFields(wireSchema, fields, { resolve, root: wireSchema, reading: new Set() });
  const decoded = [...fields].filter(([, shape]) => decodesField(shape));
  return decoded.length === 0
    ? undefined
    : Object.fromEntries(decoded.sort(([left], [right]) => compareText(left, right)).map(([name, shape]) => [name, tableShape(shape)]));
}

const graphSchemas = new WeakMap<SchemaGraph, ReadonlyMap<string, JsonSchema>>();

/** The wire schema of each node of the graph, by its name, its codec id and the short name of its id. */
function wireSchemasOf(graph: SchemaGraph): ReadonlyMap<string, JsonSchema> {
  let schemas = graphSchemas.get(graph);
  if (schemas === undefined) {
    const found = new Map<string, JsonSchema>();
    for (const node of graph.nodes.values()) {
      for (const name of [node.name, node.codecId, codecShortName(node.codecId)]) if (!found.has(name)) found.set(name, node.jsonSchema);
    }
    graphSchemas.set(graph, schemas = found);
  }
  return schemas;
}

/**
 * The query fields of a node: its wire schema read with the other nodes of the graph as the models a `$ref` names. An SDK
 * model is an object there, and an object adds no field a query string decodes.
 */
export function nodeQueryFields(graph: SchemaGraph, node: SchemaNode): QueryFieldTable | undefined {
  const schemas = wireSchemasOf(graph);
  return queryFieldTable(node.jsonSchema, (name) => schemas.get(name));
}
