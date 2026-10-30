/**
 * The query fields of a model that a query string decodes: `NestModelInterceptor` turns `?limit=10` into the number 10 for
 * a field the model declares as a number. The table is read from the wire schema at build time, so no codec carries a schema
 * at run time.
 */

import type { QueryFieldShape, QueryFieldTable } from '../object-codec.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX, VALIDATION_KEYWORD } from '../schema-keywords.js';
import { compareText } from './generator-core.js';
import { codecShortName, type SchemaGraph, type SchemaNode } from './schema-graph.js';
import type { JsonSchema } from './schema.js';

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
  /** The characters that a value of the field can hold; null when it can hold any. Read by the generators, never by a decode. */
  characters: Set<string> | null;
  /** Whether the schema admits an object. */
  object: boolean;
}

const SCALARS: readonly QueryScalar[] = ['string', 'number', 'integer', 'boolean'];

function schemaRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as SchemaRecord : undefined;
}

function newShape(): FieldShape {
  return { types: new Set(), literals: [], characters: new Set(), object: false };
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
      for (const segment of reference.slice(2).split('/')) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
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

/** The characters that each format writes; a value of the format cannot hold any other. */
const FORMAT_CHARACTERS: Readonly<Record<string, string>> = {
  uuid: '0123456789abcdefABCDEF-',
  date: '0123456789-',
  'date-time': '0123456789-:TtZz.+',
  time: '0123456789:.Zz+-',
  ipv4: '0123456789.',
  byte: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
};

/** Adds the characters that a value of `record` can hold to the shape: those of its `enum` or `const`, else those of its types; any character when a string has no rule. */
function addCharacters(shape: FieldShape, record: SchemaRecord, types: readonly unknown[]): void {
  const values = Array.isArray(record.enum) ? record.enum : 'const' in record ? [record.const] : undefined;
  const add = (text: string | null): void => {
    if (text === null) shape.characters = null;
    else if (shape.characters !== null) for (const character of text) shape.characters.add(character);
  };
  if (values !== undefined) {
    for (const value of values) add(String(value));
    return;
  }
  for (const type of types) {
    if (type === 'string') add(typeof record.format === 'string' && Object.hasOwn(FORMAT_CHARACTERS, record.format) ? FORMAT_CHARACTERS[record.format]! : null);
    else if (type === 'integer') add('0123456789-');
    else if (type === 'number') add('0123456789-+.eE');
    else if (type === 'boolean') add('truefals');
    else if (type === 'null') add('null');
  }
}

function collectShape(schema: unknown, shape: FieldShape, scope: Scope): void {
  if (schema === true) {
    shape.types.add('string');
    shape.characters = null;
    return;
  }
  const record = schemaRecord(schema);
  if (!record) return;
  const types = typeof record.type === 'string' ? [record.type] : Array.isArray(record.type) ? record.type : [];
  for (const type of types) if (typeof type === 'string') shape.types.add(type);
  if ('const' in record) shape.literals.push(record.const);
  if (Array.isArray(record.enum)) shape.literals.push(...record.enum);
  if (types.includes('object')) shape.object = true;
  addCharacters(shape, record, types);
  // An `items` keyword stands for an array also when the schema names no type.
  if (types.includes('array') || record.items !== undefined) {
    shape.item ??= newShape();
    collectShape(record.items, shape.item, scope);
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
  return !shape.types.has('string') || decodesScalar(shape.item);
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

/** A field as the generators read it: the shape that a decode uses, and what its values can hold. */
export interface FieldReading {
  readonly shape: QueryFieldShape;
  /** The characters a value can hold; undefined when it can hold any. */
  readonly characters: ReadonlySet<string> | undefined;
  /** Whether the schema admits an object. */
  readonly object: boolean;
  readonly item?: FieldReading;
}

function readingOf(shape: FieldShape): FieldReading {
  return { shape: tableShape(shape), characters: shape.characters ?? undefined, object: shape.object, ...(shape.item ? { item: readingOf(shape.item) } : {}) };
}

/**
 * Every field of a wire schema, also the fields that stay text, as the generators read it: `queryFieldTable` keeps only the fields that a query string decodes.
 * The walk enters `allOf`, `oneOf`, `anyOf` and references the same way.
 */
export function queryFieldShapes(wireSchema: JsonSchema, resolve: QueryReferenceResolver): Readonly<Record<string, FieldReading>> {
  const fields = new Map<string, FieldShape>();
  collectFields(wireSchema, fields, { resolve, root: wireSchema, reading: new Set() });
  return Object.fromEntries([...fields].sort(([left], [right]) => compareText(left, right)).map(([name, shape]) => [name, readingOf(shape)]));
}

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
