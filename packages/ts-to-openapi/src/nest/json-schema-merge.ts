import * as ts from '@exprtlabs/codegen/ts';
import {
  CodegenDiagnosticSeverity,
  TsToOpenApiDiagnosticCode,
  TsToOpenApiError,
  diagnostic,
} from '../diagnostics.js';

export type DtoSchema = Record<string, unknown> | boolean;

export interface SchemaMergeOptions {
  readonly authoritative?: boolean;
  readonly resolveReference?: (reference: string) => DtoSchema | undefined;
  readonly sourceFile?: ts.SourceFile;
  readonly node?: ts.Node;
  readonly location?: string;
  /** How to resolve a conflict at this site, appended to every conflict message. */
  readonly hint?: string;
}

/** JSON Schema keywords whose values describe the accepted value shape. */
const STRUCTURAL_KEYS = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'items',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependentRequired',
  'dependentSchemas',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'nullable',
]);

/** Formats with a defined validation assertion in the portable schema
 * contract. Unknown format names remain JSON Schema annotations. */
const ASSERTION_FORMATS = new Set([
  'date', 'date-time', 'duration', 'email', 'hostname', 'idn-email', 'idn-hostname',
  'ipv4', 'ipv6', 'json-pointer', 'regex', 'relative-json-pointer', 'time',
  'uri', 'uri-reference', 'uri-template', 'uuid', 'password', 'byte', 'binary',
  'int32', 'int64', 'float', 'double', 'url',
]);

export function isAssertionFormat(value: unknown): value is string {
  return typeof value === 'string' && ASSERTION_FORMATS.has(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function throwSchemaDiagnostic(
  node: ts.Node,
  code: TsToOpenApiDiagnosticCode,
  message: string,
): never {
  throw new TsToOpenApiError(diagnostic(
    node.getSourceFile(),
    node,
    code,
    message,
    CodegenDiagnosticSeverity.Error,
  ));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

export function schemaReference(value: unknown): string | undefined {
  return isRecord(value) && typeof value.$ref === 'string' ? value.$ref : undefined;
}

export function resolvedSchema(
  value: DtoSchema,
  options: SchemaMergeOptions,
): DtoSchema | undefined {
  const reference = schemaReference(value);
  return reference ? options.resolveReference?.(reference) : undefined;
}

export function schemaValues(value: DtoSchema): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.enum)) return value.enum;
  if (Array.isArray(value.anyOf)) {
    const constants = value.anyOf
      .filter(isRecord)
      .map(item => item.const)
      .filter(item => item !== undefined);
    return constants.length === value.anyOf.length ? constants : undefined;
  }
  return undefined;
}

function schemaPath(options: SchemaMergeOptions, suffix: string): string {
  return options.location ? `${options.location}.${suffix}` : suffix;
}

/**
 * Return whether a schema explicitly admits JSON null. OpenAPI 3.1 and 3.2
 * represent this with a `null` type branch; older Swagger metadata commonly
 * uses `nullable: true`. References are resolved through the same component
 * table used by structural overlay checks.
 */
export function schemaAllowsNull(
  value: DtoSchema,
  options: SchemaMergeOptions,
  seen = new Set<DtoSchema>(),
): boolean {
  if (typeof value === 'boolean') return value;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    const reference = schemaReference(value);
    if (reference) {
      const resolved = resolvedSchema(value, options);
      return resolved !== undefined && schemaAllowsNull(resolved, options, seen);
    }
    if (value.nullable === true) return true;
    if (value.nullable === false) return false;
    const type = value.type;
    let result = true;
    if (type !== undefined) {
      result = type === 'null' || (Array.isArray(type) && type.includes('null'));
    }
    if (Array.isArray(value.enum)) result = result && value.enum.some(item => item === null);
    if (Object.hasOwn(value, 'const')) result = result && value.const === null;
    for (const key of ['anyOf', 'oneOf'] as const) {
      const variants = value[key];
      if (Array.isArray(variants)) {
        result = result && variants.some(item => (
          typeof item === 'boolean' || isRecord(item)
        ) && schemaAllowsNull(item as DtoSchema, options, seen));
      }
    }
    const allOf = value.allOf;
    if (Array.isArray(allOf)) {
      result = result && allOf.every(item => (
        typeof item === 'boolean' || isRecord(item)
      ) && schemaAllowsNull(item as DtoSchema, options, seen));
    }
    if (value.not !== undefined && (typeof value.not === 'boolean' || isRecord(value.not))) {
      result = result && !schemaAllowsNull(value.not as DtoSchema, options, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function withoutLegacyNullable(value: DtoSchema): DtoSchema {
  if (typeof value === 'boolean') return value;
  const result = { ...value };
  delete result.nullable;
  return result;
}

function isStructuralKeyword(key: string, value: unknown): boolean {
  return STRUCTURAL_KEYS.has(key) || (key === 'format' && isAssertionFormat(value));
}

/** The documentation keywords of a schema, without any keyword that constrains values. */
export function schemaAnnotations(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !isStructuralKeyword(key, item)));
}

function nullableWrapper(value: DtoSchema, nullable: boolean): DtoSchema {
  if (typeof value === 'boolean') {
    if (nullable) return { anyOf: [value, { type: 'null' }] };
    if (value === false) return false;
    return { allOf: [value, { not: { type: 'null' } }] };
  }
  const annotations = schemaAnnotations(value);
  const structural = Object.fromEntries(Object.entries(value).filter(([key, item]) => isStructuralKeyword(key, item) && key !== 'nullable'));
  const branch: DtoSchema = Object.keys(structural).length > 0 ? structural : true;
  if (nullable) {
    return { ...annotations, anyOf: [branch, { type: 'null' }] };
  }
  return { ...annotations, allOf: [branch, { not: { type: 'null' } }] };
}

function withoutNullVariants(value: unknown, options: SchemaMergeOptions): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(item => {
    const schema = typeof item === 'boolean' || isRecord(item) ? item as DtoSchema : undefined;
    return schema === undefined || !schemaAllowsNull(schema, options);
  });
}

/**
 * Translate Swagger's legacy `nullable` annotation into JSON Schema. The
 * canonical model schema remains untouched for authoritative IModel types;
 * this helper is used only for ordinary DTO and explicit Swagger overlays.
 */
export function normalizeNullable(
  value: DtoSchema,
  nullable: boolean,
  options: SchemaMergeOptions,
): DtoSchema {
  const base = withoutLegacyNullable(value);
  const allowsNull = schemaAllowsNull(base, options);
  if ((nullable && allowsNull) || (!nullable && !allowsNull)) return base;
  if (typeof base === 'boolean') return nullable ? nullableWrapper(base, true) : false;

  const wrappingKeys = ['$ref', 'const', 'allOf', 'not', 'if', 'then', 'else'];
  if (wrappingKeys.some(key => Object.hasOwn(base, key))) return nullableWrapper(base, nullable);

  const result: Record<string, unknown> = { ...base };
  let changed = false;
  if (Array.isArray(result.enum)) {
    const values = nullable
      ? [...result.enum, null]
      : result.enum.filter(item => item !== null);
    result.enum = [...new Set(values)];
    changed = true;
  }
  if (Array.isArray(result.type)) {
    const types = nullable
      ? [...result.type, 'null']
      : result.type.filter(item => item !== 'null');
    if (types.length === 0) return false;
    const normalizedTypes = [...new Set(types)];
    result.type = normalizedTypes.length === 1 ? normalizedTypes[0] : normalizedTypes;
    changed = true;
  } else if (typeof result.type === 'string') {
    if (result.type === 'null') return nullable ? result : false;
    if (nullable) {
      result.type = [result.type, 'null'];
      changed = true;
    }
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = result[key];
    if (!Array.isArray(variants)) continue;
    if (nullable) {
      result[key] = [...variants, { type: 'null' }];
    } else {
      const filtered = withoutNullVariants(variants, options);
      if (filtered === undefined || filtered.length === 0) return false;
      result[key] = filtered;
    }
    changed = true;
  }
  if (changed) return result;
  return nullableWrapper(base, nullable);
}

/** A schema value as it appears in a diagnostic. */
function shown(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function conflict(options: SchemaMergeOptions, detail: string): never {
  const message = options.hint ? `${detail} ${options.hint}` : detail;
  const node = options.node;
  if (node) throwSchemaDiagnostic(node, TsToOpenApiDiagnosticCode.ConflictingSchemaMetadata, message);
  throw new TsToOpenApiError({
    severity: CodegenDiagnosticSeverity.Error,
    code: TsToOpenApiDiagnosticCode.ConflictingSchemaMetadata,
    message,
  });
}

function compareSchema(
  canonical: DtoSchema,
  override: DtoSchema,
  options: SchemaMergeOptions,
  location = options.location ?? 'schema',
): void {
  if (typeof canonical === 'boolean' || typeof override === 'boolean') {
    if (canonical !== override) conflict(options, `Swagger schema at ${location} is ${shown(override)} but the TypeScript contract is ${shown(canonical)}.`);
    return;
  }
  const canonicalReference = schemaReference(canonical);
  const overrideReference = schemaReference(override);
  if (canonicalReference) {
    if (canonicalReference === overrideReference) {
      // A same-reference override may add documentation siblings.
      for (const key of Object.keys(override)) {
        if (key !== '$ref' && STRUCTURAL_KEYS.has(key)) {
          const resolved = resolvedSchema(canonical, options);
          if (!resolved) conflict(options, `Swagger schema at ${location} adds structural key ${key} beside unresolved ${canonicalReference}.`);
          compareSchema(resolved, { [key]: override[key] }, { ...options, location: schemaPath(options, key) }, schemaPath(options, key));
        }
      }
      return;
    }
    const resolved = resolvedSchema(canonical, options);
    if (!resolved) conflict(options, `Swagger schema at ${location} replaces authoritative reference ${canonicalReference}.`);
    compareSchema(resolved, override, options, location);
    return;
  }
  if (overrideReference) {
    const resolved = resolvedSchema(override, options);
    if (!resolved) conflict(options, `Swagger schema at ${location} introduces unresolved reference ${overrideReference}.`);
    compareSchema(canonical, resolved, options, location);
    return;
  }

  const canonicalRecord = canonical;
  const overrideRecord = override;
  for (const [key, value] of Object.entries(overrideRecord)) {
    // JSON Schema permits implementation-defined format annotations. Treat
    // only the formats with a known validation assertion as structural
    // contract claims; an unknown format is safe documentation metadata.
    if (key === 'format') {
      if (!isAssertionFormat(value)) continue;
      const expected = canonicalRecord.format;
      if (expected === undefined) {
        if (options.authoritative) conflict(options, `Swagger schema at ${location}.format adds a validation assertion absent from the authoritative contract.`);
      } else if (!sameValue(expected, value)) {
        conflict(options, `Swagger schema at ${location}.format is ${shown(value)} but the TypeScript contract has ${shown(expected)}.`);
      }
      continue;
    }
    if (key === 'nullable') {
      if (value !== true && value !== false) {
        conflict(options, `Swagger schema at ${location}.nullable must be a boolean.`);
      }
      if (options.authoritative) {
        const allowsNull = schemaAllowsNull(canonical, options);
        if (value === true && !allowsNull) {
          conflict(options, `Swagger schema at ${location}.nullable permits null but the authoritative TypeScript/IModel contract does not.`);
        }
        if (value === false && allowsNull) {
          conflict(options, `Swagger schema at ${location}.nullable forbids null but the authoritative TypeScript/IModel contract permits it.`);
        }
      }
      continue;
    }
    if (!STRUCTURAL_KEYS.has(key)) continue;
    const expected = canonicalRecord[key];
    if (key === 'properties') {
      if (!isRecord(value) || !isRecord(expected)) {
        conflict(options, `Swagger schema at ${location}.properties conflicts with the authoritative TypeScript fields.`);
      }
      for (const [name, propertySchema] of Object.entries(value)) {
        if (expected[name] === undefined) conflict(options, `Swagger schema at ${location}.properties.${name} is not declared by the TypeScript contract.`);
        compareSchema(expected[name] as DtoSchema, propertySchema as DtoSchema, options, `${location}.properties.${name}`);
      }
      continue;
    }
    if (key === 'required') {
      if (!Array.isArray(value) || (expected !== undefined && !Array.isArray(expected)) || (expected !== undefined && !sameValue(value, expected))) {
        conflict(options, `Swagger schema at ${location}.required conflicts with the authoritative TypeScript required fields.`);
      }
      continue;
    }
    if (expected === undefined) {
      if (options.authoritative) conflict(options, `Swagger schema at ${location}.${key} adds a constraint absent from the authoritative contract.`);
      continue;
    }
    if (isRecord(expected) && isRecord(value)) {
      compareSchema(expected, value, options, `${location}.${key}`);
    } else if (!sameValue(expected, value)) {
      // enum may be expressed as anyOf consts by the canonical descriptor.
      if (key === 'enum') {
        const expectedValues = schemaValues(canonical);
        if (expectedValues && sameValue([...expectedValues].sort(), [...(Array.isArray(value) ? value : [])].sort())) continue;
      }
      conflict(options, `Swagger schema at ${location}.${key} is ${shown(value)} but the TypeScript contract has ${shown(expected)}.`);
    }
  }
}

function mergeSchema(
  canonical: DtoSchema,
  override: DtoSchema,
  options: SchemaMergeOptions,
): DtoSchema {
  compareSchema(canonical, override, options);
  if (typeof canonical === 'boolean' || typeof override === 'boolean') return canonical;
  const canonicalReference = schemaReference(canonical);
  if (canonicalReference) {
    const result = {
      ...canonical,
      ...Object.fromEntries(Object.entries(override).filter(([key]) => !STRUCTURAL_KEYS.has(key))),
    };
    const nullable = !options.authoritative && typeof override.nullable === 'boolean'
      ? override.nullable
      : undefined;
    return nullable === undefined ? result : normalizeNullable(result, nullable, options);
  }
  const result: Record<string, unknown> = { ...canonical };
  let nullable: boolean | undefined;
  for (const [key, value] of Object.entries(override)) {
    const canonicalProperties = isRecord(canonical.properties) ? canonical.properties : undefined;
    if (key === 'properties' && isRecord(value) && canonicalProperties) {
      result.properties = Object.fromEntries(Object.keys(canonicalProperties).map(name => [
        name,
        value[name] === undefined
          ? canonicalProperties[name]
          : mergeSchema(canonicalProperties[name] as DtoSchema, value[name] as DtoSchema, { ...options, location: `${options.location ?? 'schema'}.properties.${name}` }),
      ]));
      continue;
    }
    if (key === 'nullable') {
      if (!options.authoritative && typeof value === 'boolean') nullable = value;
      continue;
    }
    if (key === 'format' && isAssertionFormat(value)) {
      // A known format is structural. Keep the canonical assertion for an
      // authoritative contract, while ordinary DTOs may add the compatible
      // explicit assertion.
      if (result[key] === undefined && !options.authoritative) result[key] = value;
      continue;
    }
    if (STRUCTURAL_KEYS.has(key)) {
      // The canonical contract remains authoritative after compatibility has
      // been checked. This keeps omitted fields and constraints intact.
      if (result[key] === undefined && !options.authoritative) result[key] = value;
      continue;
    }
    result[key] = value;
  }
  return nullable === undefined ? result : normalizeNullable(result, nullable, options);
}

/**
 * Merge explicit Swagger schema metadata without allowing it to replace a
 * TypeScript/IModel contract. Structural keys are checked recursively; the
 * canonical schema remains the emitted source of fields, requiredness, and
 * constraints.
 */
export function mergeSchemaMetadata(
  canonical: DtoSchema,
  override: DtoSchema,
  options: SchemaMergeOptions = {},
): DtoSchema {
  return mergeSchema(canonical, override, options);
}
