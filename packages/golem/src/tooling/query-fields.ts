/**
 * The query fields of a model that a query string decodes: `NestModelInterceptor` turns `?limit=10` into the number 10 for
 * a field the model declares as a number. The table is read from the wire schema at build time, so no codec carries a schema
 * at run time.
 */

import type { QueryFieldShape, QueryFieldTable } from '../object-codec.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX, VALIDATION_KEYWORD } from '../schema-keywords.js';
import { compareText } from './generator-api.js';
import type { JsonSchema } from './schema.js';

type SchemaRecord = Readonly<Record<string, unknown>>;
type QueryScalar = QueryFieldShape['types'][number];

/** The schema a placeholder `$ref` names, by the model name it carries; undefined when the build holds none. */
export type QueryReferenceResolver = (name: string) => JsonSchema | undefined;

/** What a field's schema admits, reduced to what a query string can carry. */
interface FieldShape {
  readonly types: Set<string>;
  readonly literals: unknown[];
  /** The `$ref` targets already read into this shape, so a reference cycle ends. */
  readonly references: Set<unknown>;
  item?: FieldShape;
}

const SCALARS: readonly QueryScalar[] = ['string', 'number', 'integer', 'boolean'];

function schemaRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as SchemaRecord : undefined;
}

function newShape(): FieldShape {
  return { types: new Set(), literals: [], references: new Set() };
}

/** The model name a placeholder `$ref` carries, without its plane. */
function referencedName(reference: string): string | undefined {
  if (!reference.startsWith(GENERATED_MODEL_SCHEMA_REF_PREFIX)) return undefined;
  const name = reference.slice(GENERATED_MODEL_SCHEMA_REF_PREFIX.length);
  const hash = name.indexOf('#');
  return hash < 0 ? name : name.slice(0, hash);
}

function collectShape(schema: unknown, shape: FieldShape, resolve: QueryReferenceResolver): void {
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
  if (types.includes('array')) {
    shape.item ??= newShape();
    collectShape(record.items, shape.item, resolve);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = record[keyword];
    if (Array.isArray(branches)) for (const branch of branches) collectShape(branch, shape, resolve);
  }
  collectShape(schemaRecord(record[VALIDATION_KEYWORD])?.schema, shape, resolve);
  const name = typeof record.$ref === 'string' ? referencedName(record.$ref) : undefined;
  const target = name === undefined ? undefined : resolve(name);
  // A target met twice, or a reference cycle, adds nothing more.
  if (target !== undefined && !shape.references.has(target)) {
    shape.references.add(target);
    collectShape(target, shape, resolve);
  }
}

function collectFields(schema: unknown, fields: Map<string, FieldShape>, resolve: QueryReferenceResolver, seen = new Set<unknown>()): void {
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
      collectShape(property, shape, resolve);
    }
  }
  const name = typeof record.$ref === 'string' ? referencedName(record.$ref) : undefined;
  if (name !== undefined) collectFields(resolve(name), fields, resolve, seen);
  if (Array.isArray(record.allOf)) for (const branch of record.allOf) collectFields(branch, fields, resolve, seen);
  collectFields(schemaRecord(record[VALIDATION_KEYWORD])?.schema, fields, resolve, seen);
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
    : shape.literals.filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
  return {
    types,
    ...(literals.length > 0 ? { literals } : {}),
    ...(shape.item ? { item: tableShape(shape.item) } : {}),
  };
}

/**
 * The fields of a model's wire schema that a query string decodes, or undefined when it has none. `resolve` names the
 * schema of a model that the wire schema refers to, such as the base of a model or a named alias of literals.
 */
export function queryFieldTable(wireSchema: JsonSchema, resolve: QueryReferenceResolver): QueryFieldTable | undefined {
  const fields = new Map<string, FieldShape>();
  collectFields(wireSchema, fields, resolve);
  const decoded = [...fields].filter(([, shape]) => decodesField(shape));
  return decoded.length === 0
    ? undefined
    : Object.fromEntries(decoded.sort(([left], [right]) => compareText(left, right)).map(([name, shape]) => [name, tableShape(shape)]));
}
