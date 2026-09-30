/**
 * Canonical JSON Schema assembly for generated model constraints.
 *
 * The model generator, the runtime Ajv adapter, and the standalone compiler
 * all consume the same constraint representation. Runtime schemas refer to
 * callback bindings by declaration identity; portable schemas omit executable
 * rules without narrowing the set of accepted values.
 */

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

import type { ConstraintSchemaValue, ModelConstraint } from '../model.js';
import {
  GENERATED_MODEL_SCHEMA_REF_PREFIX,
  MODEL_DATE_KEYWORD,
  MODEL_INSTANCE_KEYWORD,
  VALIDATION_KEYWORD,
} from '../schema-keywords.js';

export { assertSupportedModelFieldName } from '../model-field-names.js';
export { escapePointerToken, unescapePointerToken } from '../json-pointer.js';
export type { ConstraintSchemaValue, ModelConstraint } from '../model.js';
export { GENERATED_MODEL_SCHEMA_REF_PREFIX, MODEL_DATE_KEYWORD, MODEL_INSTANCE_KEYWORD, VALIDATION_KEYWORD };
export { validationTagKey, validationTagSchemaDescriptor, type ValidationTagGroup } from './validation-tags.js';

/** Structural inputs used when a nested schema contains a named reference. */
export interface SchemaDescriptorOptions {
  /**
   * `model-only` / `wire-only` derive what is left to check after the full check of
   * the other plane: after decoding (parse) and after encoding (stringify).
   */
  readonly representation?: 'model' | 'wire' | 'model-only' | 'wire-only';
  /** Referenced models (codec ids, names or generated-model ids) that have each residual schema. */
  readonly residualReferences?: { readonly modelOnly: ReadonlySet<string>; readonly wireOnly: ReadonlySet<string> };
  /** Emit application callback bindings for generated runtime tag schemas. */
  readonly executableBindings?: boolean;
  /** Use component references when assembling an OpenAPI document. */
  readonly referencePrefix?: string;
  readonly portable?: boolean;
  readonly onNonportable?: (message: string) => void;
  /** Resolve a descriptor reference without executing application code. */
  readonly resolveReference?: (name: string) => unknown | undefined;
  /** Convenience registry for callers that already have descriptor definitions. */
  readonly definitions?: Readonly<Record<string, unknown>>;
  /**
   * Interned child codec ids whose Ajv was not emitted. Parent schemas inline
   * an open object instead of `$ref` so they still compile.
   */
  readonly opaqueReferenceIds?: ReadonlySet<string>;
  /**
   * Results of `hasExecutableValidation` per referenced descriptor, shared by
   * the walks of one generation job so each named model is examined once.
   */
  readonly executableMemo?: ExecutableValidationMemo;
}

/** Per-job cache of executable-validation reachability by referenced descriptor. */
export interface ExecutableValidationMemo {
  readonly results: WeakMap<object, boolean>;
  /** References being examined; meeting one again cuts a cycle. */
  readonly active: Set<object>;
  /** Cycle cuts so far; a result computed across a cut is not cached unless true. */
  cuts: number;
}

export function createExecutableValidationMemo(): ExecutableValidationMemo {
  return { results: new WeakMap(), active: new Set(), cuts: 0 };
}

export function constraintSchemaValues(constraint: ModelConstraint): readonly unknown[] {
  switch (constraint.kind) {
    case 'contains':
    case 'propertyNames':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'items':
    case 'unevaluatedItems':
    case 'not':
    case 'patternProperties':
      return [constraint.schema];
    case 'dependentSchemas':
      return Object.values(constraint.value);
    case 'oneOf':
      return constraint.schemas;
    case 'ifThenElse':
      return [constraint.if, ...(constraint.then === undefined ? [] : [constraint.then]), ...(constraint.else === undefined ? [] : [constraint.else])];
    default:
      return [];
  }
}

/** Inspect descriptor metadata only; never traverse compiler nodes or execute rules. */
export function hasExecutableValidation(
  value: unknown,
  options: SchemaDescriptorOptions = {},
  visited = new Set<object>(),
): boolean {
  // Reachability: each descriptor is examined once per call. Shared references
  // (a model used by several fields) would otherwise be walked once per path,
  // which is exponential in the depth of a chain of models.
  if (!isRecord(value) || visited.has(value)) return false;
  visited.add(value);
  const visit = (nested: unknown): boolean => hasExecutableValidation(nested, options, visited);
  if (Array.isArray(value.validations) && value.validations.length > 0) return true;
  if (isRecord(value.serde) && visit(value.serde.wireDescriptor ?? value.serde.wire)) return true;
  if (Array.isArray(value.constraints) && value.constraints.some(item =>
    isRecord(item) && typeof item.kind === 'string'
    && constraintSchemaValues(item as ModelConstraint).some(visit))) return true;
  switch (value.kind) {
    case 'reference': {
      if (typeof value.name !== 'string') return false;
      const target = options.resolveReference?.(value.name) ?? options.definitions?.[value.name];
      const memo = options.executableMemo;
      if (!memo || !isRecord(target)) return visit(target);
      const cached = memo.results.get(target);
      if (cached !== undefined) return cached;
      // An unfinished or uncached model seen again: its answer is not final here.
      if (memo.active.has(target) || visited.has(target)) {
        memo.cuts += 1;
        return false;
      }
      memo.active.add(target);
      const cuts = memo.cuts;
      const found = visit(target);
      memo.active.delete(target);
      if (found || memo.cuts === cuts) memo.results.set(target, found);
      return found;
    }
    case 'array': return visit(value.item);
    case 'tuple': return (Array.isArray(value.items) && value.items.some(visit))
      || (isRecord(value.rest) && visit(value.rest.item));
    case 'union':
    case 'intersection': return Array.isArray(value.variants) && value.variants.some(visit);
    case 'object': return (isRecord(value.properties) && Object.values(value.properties).some(visit))
      || visit(value.additionalProperties);
    default: return false;
  }
}

/** Return whether a schema-valued assertion depends on an executable rule. */
export function constraintHasExecutableValidation(
  constraint: ModelConstraint,
  options: SchemaDescriptorOptions = {},
): boolean {
  return constraintSchemaValues(constraint).some(schema => hasExecutableValidation(schema, options));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

/** Stable key used when deduplicating equivalent generated tag schemas. */
export function canonicalSchemaKey(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalDescriptorValue(value: unknown): unknown {
  if (typeof value === 'boolean' || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const descriptor = value as Record<string, unknown>;
  if (typeof descriptor.kind !== 'string') return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(descriptor)) {
    // Readonly belongs to the generated TypeScript surface. It does not alter
    // JSON validation, encoding, or runtime codec identity.
    if (key === 'isReadonly') continue;
    // Analyzer-only metadata can contain TypeScript nodes and checker graphs.
    // Strip it only at a descriptor boundary; user object property names and
    // literal/schema data remain untouched.
    if (key === 'date') {
      result[key] = true;
      continue;
    }
    if (key === 'serde') {
      // Keep the binding id so TSerde objects do not intern as identity types.
      // Do not walk serialize/deserialize functions or wireDescriptor graphs.
      if (isRecord(item) && typeof item.id === 'string') result[key] = { id: item.id };
      continue;
    }
    if (key === 'validations') {
      // Validation bindings contain checker declarations and types.  Their
      // declaration identity is part of a constraint's semantics, while the
      // executable/compiler objects must never enter a structural key.
      result[key] = Array.isArray(item)
        ? item.map((binding) => {
          if (typeof binding === 'string') return binding;
          if (isRecord(binding) && typeof binding.id === 'string') return binding.id;
          return '[validation]';
        }).sort()
        : item;
      continue;
    }
    if (key === 'properties' && isRecord(item)) {
      result[key] = Object.fromEntries(Object.entries(item).map(([name, property]) => [name, canonicalDescriptorValue(property)]));
    } else if (key === 'additionalProperties' || key === 'item') {
      result[key] = typeof item === 'object' && item !== null ? canonicalDescriptorValue(item) : item;
    } else if (key === 'items' || key === 'variants') {
      result[key] = Array.isArray(item) ? item.map(canonicalDescriptorValue) : item;
    } else if (key === 'rest' && isRecord(item)) {
      result[key] = { ...item, ...(item.item === undefined ? {} : { item: canonicalDescriptorValue(item.item) }) };
    } else if (key === 'constraints' && Array.isArray(item)) {
      result[key] = item.map(canonicalConstraintValue);
    } else if (key === 'typeImport' && isRecord(item)) {
      // A class-value import's `module` is an absolute path; codec ids must not depend on the checkout directory.
      result[key] = { exportName: item.exportName, ...(item.specifier === undefined ? {} : { specifier: item.specifier }) };
    } else {
      result[key] = item;
    }
  }
  return result;
}

function canonicalSchemaValue(value: unknown): unknown {
  return isRecord(value) ? canonicalDescriptorValue(value) : value;
}

/** Stable intern key for model descriptors. Keeps serde ids; skips checker graphs. */
export function canonicalDescriptorKey(value: unknown): string {
  return JSON.stringify(canonicalDescriptorValue(value));
}

function canonicalConstraintValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const constraint: Record<string, unknown> = { ...value };
  if (constraint.schema !== undefined) constraint.schema = canonicalSchemaValue(constraint.schema);
  if (constraint.kind === 'dependentSchemas' && isRecord(constraint.value)) {
    constraint.value = Object.fromEntries(Object.entries(constraint.value).map(([name, item]) => [name, canonicalSchemaValue(item)]));
  }
  if (Array.isArray(constraint.schemas)) constraint.schemas = constraint.schemas.map(canonicalSchemaValue);
  if (constraint.if !== undefined) constraint.if = canonicalSchemaValue(constraint.if);
  if (constraint.then !== undefined) constraint.then = canonicalSchemaValue(constraint.then);
  if (constraint.else !== undefined) constraint.else = canonicalSchemaValue(constraint.else);
  return constraint;
}

/** Stable constraint identity that ignores analyzer metadata only in descriptors. */
export function canonicalConstraintKey(value: unknown): string {
  return canonicalSchemaKey(canonicalConstraintValue(value));
}

interface SchemaAssemblyState {
  readonly active: Set<object>;
  readonly references: Set<string>;
}

type AssemblyOptions = SchemaDescriptorOptions & {
  /** Keep executable predicates. False on the model tree when emitting wire JSON Schema. */
  readonly keepPredicates?: boolean;
};

function keepExecutablePredicates(options: AssemblyOptions): boolean {
  return options.keepPredicates ?? options.representation !== 'wire';
}

function objectUnionDiscriminator(variants: readonly unknown[]): string | undefined {
  if (variants.length < 2 || !variants.every((variant) => isRecord(variant) && variant.kind === 'object')) {
    return undefined;
  }
  const objects = variants as ReadonlyArray<Record<string, unknown>>;
  const requiredLiteralNames = objects.map((object) => {
    const properties = isRecord(object.properties) ? object.properties : {};
    const required = new Set(Array.isArray(object.required) ? object.required : []);
    return Object.entries(properties)
      .filter(([name, descriptor]) => required.has(name) && isRecord(descriptor) && descriptor.kind === 'literal')
      .map(([name]) => name);
  });
  for (const name of requiredLiteralNames[0] ?? []) {
    if (!requiredLiteralNames.every((names) => names.includes(name))) continue;
    const values = objects.map((object) => {
      const properties = isRecord(object.properties) ? object.properties : {};
      const descriptor = properties[name];
      return isRecord(descriptor) ? descriptor.value : undefined;
    });
    if (values.every((value) => value !== undefined) && new Set(values).size === values.length) return name;
  }
  return undefined;
}

function hasAjvDiscriminatorTag(branch: JsonSchema, propertyName: string): boolean {
  if (!isRecord(branch) || !isRecord(branch.properties)) return false;
  const tag = branch.properties[propertyName];
  if (!Array.isArray(branch.required) || !branch.required.includes(propertyName) || !isRecord(tag)) return false;
  const values = 'const' in tag ? [tag.const] : Array.isArray(tag.enum) ? tag.enum : [];
  return values.length > 0 && values.every((item) => typeof item === 'string' && item !== '');
}

/** The registered codec id of a model class variant, as its schema references it. */
function modelClassId(variant: unknown): string | undefined {
  if (!isRecord(variant)) return undefined;
  if (variant.kind === 'reference' && typeof variant.name === 'string') return variant.name;
  if (variant.kind !== 'generated-model' || typeof variant.id !== 'string') return undefined;
  return generatedModelShortName(variant.id);
}

/** The codec short name a generated-model id resolves to. */
export function generatedModelShortName(id: string): string {
  const segment = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return segment.replace(/[^A-Za-z0-9_]/g, '_');
}

/** An explicit union discriminator table aligned with `count` variants. */
function discriminatorTable(
  value: unknown,
  count: number,
): { readonly propertyName: string; readonly values: readonly (readonly unknown[])[] } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.propertyName !== 'string' || !Array.isArray(value.variants)
    || value.variants.length !== count) {
    throw new TypeError('A union discriminator needs a propertyName and tag values for every variant.');
  }
  return {
    propertyName: value.propertyName,
    values: value.variants.map((variant) => isRecord(variant) && Array.isArray(variant.values) ? variant.values : []),
  };
}

function isTypeOnlyBrand(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== 'object') return false;
  const properties = isRecord(value.properties) ? value.properties : {};
  const required = Array.isArray(value.required) ? value.required : [];
  return required.length === 0
    && value.additionalProperties === false
    && Object.entries(properties).every(([name, descriptor]) =>
      name.startsWith('__')
      && isRecord(descriptor)
      && (descriptor.kind === 'undefined' || descriptor.kind === 'never'));
}

type ResidualPlane = 'model-only' | 'wire-only';

function ownValidationBindings(value: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(value.validations) || value.validations.length === 0) return undefined;
  return value.validations.map((binding) => {
    if (typeof binding === 'string') return binding;
    if (isRecord(binding) && typeof binding.id === 'string') return binding.id;
    throw new TypeError('Validation bindings must have declaration identifiers.');
  });
}

/** What is left to check after the full check of the other plane; `true` when nothing is. */
function residualSchema(value: unknown, plane: ResidualPlane, state: SchemaAssemblyState, options: AssemblyOptions): JsonSchema {
  if (!isRecord(value)) return true;
  const full = (representation: 'model' | 'wire'): JsonSchema =>
    descriptorSchema(value, state, { ...options, representation, keepPredicates: undefined });
  const serde = isRecord(value.serde) ? value.serde : undefined;
  if (serde) {
    if (plane === 'model-only') {
      const { serde: _serde, ...decoded } = value;
      return descriptorSchema(decoded, state, { ...options, representation: 'model', keepPredicates: true });
    }
    return descriptorSchema(serde.wireDescriptor ?? serde.wire, state, { ...options, representation: 'wire', keepPredicates: true });
  }
  // The wire schema strips executable rules from constraints (the TValidation inside
  // Contains, Not, OneOf, IfThenElse, ...) and drops the unevaluated* keywords beside them,
  // so after decoding such a descriptor runs from its full model schema.
  if (plane === 'model-only' && Array.isArray(value.constraints)) {
    const constraints = value.constraints as readonly ModelConstraint[];
    if (constraints.some((constraint) => constraintHasExecutableValidation(constraint, options))
      || projectPortableConstraints(constraints, options, value).length !== constraints.length) {
      return full('model');
    }
  }
  const rules = plane === 'model-only' && options.executableBindings && !options.portable ? ownValidationBindings(value) : undefined;
  const wrap = (schema: JsonSchema): JsonSchema => rules ? { [VALIDATION_KEYWORD]: { schema, bindings: rules } } : schema;
  const nothing = (): JsonSchema => rules ? wrap(true) : true;
  const child = (item: unknown): JsonSchema => residualSchema(item, plane, state, options);
  const has = plane === 'model-only' ? options.residualReferences?.modelOnly : options.residualReferences?.wireOnly;
  switch (value.kind) {
    case 'date':
      return plane === 'model-only' ? full('model') : { type: 'string', format: 'date-time' };
    // A class instance or bigint has no JSON shape; only its TSerde wire value and its predicates are checked.
    case 'class-value':
      return nothing();
    case 'object': {
      const properties = isRecord(value.properties) ? value.properties : {};
      const kept = Object.keys(properties).sort()
        .map((name) => [name, child(properties[name])] as const)
        .filter(([, schema]) => schema !== true);
      const additional = isRecord(value.additionalProperties) ? child(value.additionalProperties) : true;
      if (kept.length === 0 && additional === true) return nothing();
      return wrap({
        ...(kept.length ? { properties: Object.fromEntries(kept) } : {}),
        ...(additional === true ? {} : { additionalProperties: additional }),
      });
    }
    case 'array': {
      const items = child(value.item);
      return items === true ? nothing() : wrap({ items });
    }
    case 'tuple': {
      const items = Array.isArray(value.items) ? value.items.map(child) : [];
      const rest = isRecord(value.rest) ? child(value.rest.item) : true;
      if (items.every((item) => item === true) && rest === true) return nothing();
      return full(plane === 'model-only' ? 'model' : 'wire');
    }
    case 'intersection': {
      const parts = (Array.isArray(value.variants) ? value.variants : []).map(child).filter((part) => part !== true);
      if (parts.length === 0) return nothing();
      return wrap(parts.length === 1 ? parts[0] : { allOf: parts });
    }
    case 'union': {
      // An absent optional field has nothing to check; null needs no residual check.
      const variants = (Array.isArray(value.variants) ? value.variants : [])
        .filter((variant) => !(isRecord(variant) && variant.kind === 'undefined'));
      const residuals = variants.map(child);
      if (residuals.every((residual) => residual === true)) return nothing();
      const nonNull = variants.flatMap((variant, index) => isRecord(variant) && variant.kind === 'null' ? [] : [residuals[index]]);
      if (nonNull.length === 1) {
        return wrap(nonNull.length === variants.length ? nonNull[0] : { anyOf: [{ type: 'null' }, nonNull[0]] });
      }
      return full(plane === 'model-only' ? 'model' : 'wire');
    }
    case 'reference': {
      const name = typeof value.name === 'string' ? value.name : '';
      if (options.opaqueReferenceIds?.has(name) || !has?.has(name)) return nothing();
      const escaped = name.replaceAll('~', '~0').replaceAll('/', '~1');
      return wrap({ $ref: `${options.referencePrefix ?? '#/$defs/'}${escaped}#${plane}` });
    }
    case 'generated-model': {
      const id = typeof value.id === 'string' ? value.id : '';
      const short = generatedModelShortName(id);
      if (options.opaqueReferenceIds?.has(short) || options.opaqueReferenceIds?.has(id)) return true;
      if (!has?.has(short) && !has?.has(id)) return nothing();
      return wrap({ $ref: `${GENERATED_MODEL_SCHEMA_REF_PREFIX}${short}#${plane}` });
    }
    default:
      return nothing();
  }
}

function descriptorSchema(
  value: unknown,
  state: SchemaAssemblyState,
  options: AssemblyOptions,
): JsonSchema {
  if (typeof value === 'boolean') return value;
  if (!isRecord(value)) throw new TypeError('A schema descriptor must be an object or boolean.');
  if (state.active.has(value)) throw new TypeError('Cyclic model schema metadata.');
  state.active.add(value);
  try {
    // A custom serde's wire descriptor is the representation validated by an
    // emitted JSON schema.  Validation bindings are intentionally ignored.
    const serde = isRecord(value.serde) ? value.serde : undefined;
    const wire = serde && options.representation === 'wire' ? serde.wireDescriptor ?? serde.wire : undefined;
    if (options.portable && Array.isArray(value.validations) && value.validations.length) options.onNonportable?.('Custom executable validation remains in the application and is not included in OpenAPI.');
    if (wire !== undefined) {
      return descriptorSchema(wire, state, { ...options, representation: 'wire', keepPredicates: true });
    }
    const keepPredicates = keepExecutablePredicates(options);

    const kind = value.kind;
    let schema: JsonSchema;
    switch (kind) {
      case 'any':
      case 'unknown':
        schema = true;
        break;
      case 'reference': {
        const name = typeof value.name === 'string' ? value.name : undefined;
        if (!name) throw new TypeError('A schema reference requires a name.');
        if (options.opaqueReferenceIds?.has(name)) {
          schema = { type: 'object', additionalProperties: true };
          break;
        }
        const resolved = options.resolveReference?.(name) ?? options.definitions?.[name];
        if (resolved === undefined) throw new TypeError(`Unresolved schema reference: ${name}.`);
        state.references.add(name);
        const escaped = name.replaceAll('~', '~0').replaceAll('/', '~1');
        schema = { $ref: `${options.referencePrefix ?? '#/$defs/'}${escaped}` };
        break;
      }
      case 'generated-model': {
        const name = typeof value.id === 'string' ? value.id : undefined;
        if (!name) throw new TypeError('A generated-model schema requires an id.');
        const short = generatedModelShortName(name);
        if (options.opaqueReferenceIds?.has(short) || options.opaqueReferenceIds?.has(name)) {
          schema = { type: 'object', additionalProperties: true };
          break;
        }
        schema = { $ref: `${GENERATED_MODEL_SCHEMA_REF_PREFIX}${short}` };
        break;
      }
      case 'never': schema = false; break;
      case 'string': schema = { type: 'string' }; break;
      case 'number': schema = { type: 'number' }; break;
      case 'boolean': schema = { type: 'boolean' }; break;
      case 'bigint': throw new TypeError('bigint has no JSON representation; declare a TSerde wire codec.');
      case 'null': schema = { type: 'null' }; break;
      case 'undefined': schema = false; break;
      case 'date': schema = options.representation === 'model'
        ? { [MODEL_DATE_KEYWORD]: true }
        : { type: 'string', format: 'date-time' }; break;
      case 'class-value': schema = {}; break;
      case 'literal': schema = { const: value.value }; break;
      case 'array': schema = { type: 'array', items: descriptorSchema(value.item, state, options) }; break;
      case 'tuple': {
        const items = Array.isArray(value.items) ? value.items : [];
        const rest = isRecord(value.rest) ? value.rest.item : undefined;
        if (isRecord(value.rest) && typeof value.rest.index === 'number' && value.rest.index !== items.length) {
          const prefix = items.slice(0, value.rest.index);
          const suffix = items.slice(value.rest.index);
          const restSchema = descriptorSchema(value.rest.item, state, options);
          const suffixSchemas = suffix.map((item) => descriptorSchema(item, state, options));
          schema = {
            type: 'array',
            minItems: prefix.length + suffix.length,
            ...(prefix.length > 0
              ? { prefixItems: prefix.map((item) => descriptorSchema(item, state, options)) }
              : {}),
            items: suffixSchemas.length === 0 ? restSchema : { anyOf: [restSchema, ...suffixSchemas] },
          };
          break;
        }
        schema = {
          type: 'array',
          minItems: typeof value.optionalFrom === 'number' ? value.optionalFrom : items.length,
          prefixItems: items.map((item) => descriptorSchema(item, state, options)),
          ...(rest === undefined ? { items: false, maxItems: items.length } : { items: descriptorSchema(rest, state, options) }),
        };
        break;
      }
      case 'object': {
        const properties = isRecord(value.properties) ? value.properties : {};
        const required = Array.isArray(value.required) ? value.required : [];
        const additional = value.additionalProperties;
        schema = {
          type: 'object',
          properties: Object.fromEntries(
            Object.keys(properties).sort().map((name) => [name, descriptorSchema(properties[name], state, options)]),
          ),
          ...(required.length ? { required: [...required].sort() } : {}),
          additionalProperties: typeof additional === 'object' && additional !== null
            ? descriptorSchema(additional, state, options)
            : additional !== undefined ? additional : true,
        };
        break;
      }
      case 'union': {
        const all = Array.isArray(value.variants) ? value.variants : [];
        const table = discriminatorTable(value.discriminator, all.length);
        const present = all.flatMap((variant, index) =>
          isRecord(variant) && variant.kind === 'undefined' ? [] : [{ variant, index }]);
        const variants = present.map(({ variant }) => variant);
        // Model plane: the variant classes whose instances the encoder selects by class.
        const among = options.representation === 'wire' ? [] : variants.flatMap((variant) => {
          const id = modelClassId(variant);
          return id === undefined ? [] : [id];
        });
        const branches = present.map(({ variant, index }) => {
          const branch = descriptorSchema(variant, state, options);
          const values = table?.values[index];
          if (!table || !values?.length) return branch;
          // An explicit tag table narrows the tag here; the variant keeps its declared type.
          const tagged = {
            properties: { [table.propertyName]: values.length === 1 ? { const: values[0] } : { enum: [...values] } },
            required: [table.propertyName],
          };
          if (among.length === 0) return { ...tagged, allOf: [branch] };
          const of = modelClassId(variant);
          // A tagged value must not be an instance of another variant's class; a
          // model instance may omit the tag, which its encoder then writes.
          if (of === undefined) return { ...tagged, allOf: [branch], [MODEL_INSTANCE_KEYWORD]: { among, required: false } };
          return {
            allOf: [branch],
            anyOf: [
              { ...tagged, [MODEL_INSTANCE_KEYWORD]: { of, among, required: false } },
              { not: { required: [table.propertyName] }, [MODEL_INSTANCE_KEYWORD]: { of, among, required: true } },
            ],
          };
        });
        const propertyName = table?.propertyName ?? objectUnionDiscriminator(variants);
        // Ajv's discriminator requires a required tag with non-empty string
        // const or enum values directly under each branch. Other tags keep anyOf.
        schema = propertyName !== undefined
          && branches.every((branch) => hasAjvDiscriminatorTag(branch, propertyName))
          ? { discriminator: { propertyName }, oneOf: branches }
          : { anyOf: branches };
        break;
      }
      case 'intersection': {
        const variants = Array.isArray(value.variants) ? value.variants : [];
        const scalar = variants.find((variant) => isRecord(variant)
          && (variant.kind === 'string' || variant.kind === 'number' || variant.kind === 'boolean' || variant.kind === 'null'));
        schema = scalar && variants.every((variant) => variant === scalar || isTypeOnlyBrand(variant))
          ? descriptorSchema(scalar, state, options)
          : { allOf: variants.map((variant) => descriptorSchema(variant, state, options)) };
        break;
      }
      default:
        throw new TypeError(`Unsupported schema descriptor kind: ${String(kind)}.`);
    }
    const constraints = Array.isArray(value.constraints)
      ? value.constraints.filter((item): item is ModelConstraint => isRecord(item) && typeof item.kind === 'string')
      : [];
    if (constraints.length > 0) {
      schema = mergeSchemas(schema, assembleConstraintSchemaInternal(
        options.portable || !keepPredicates
          ? projectPortableConstraints(constraints, options, value)
          : constraints,
        options,
        state,
      ));
    }
    if (
      options.executableBindings
      && !options.portable
      && keepPredicates
      && Array.isArray(value.validations)
      && value.validations.length > 0
    ) {
      const validations = value.validations.map((binding) => {
        if (typeof binding === 'string') return binding;
        if (isRecord(binding) && typeof binding.id === 'string') return binding.id;
        throw new TypeError('Validation bindings must have declaration identifiers.');
      });
      schema = {
        [VALIDATION_KEYWORD]: {
          schema,
          bindings: validations,
        },
      };
    }
    return schema;
  } finally {
    state.active.delete(value);
  }
}

function withDefinitions(schema: JsonSchema, state: SchemaAssemblyState, options: AssemblyOptions): JsonSchema {
  if (options.referencePrefix || state.references.size === 0) return schema;
  const definitions: Record<string, JsonSchema> = Object.create(null);
  for (const name of state.references) {
    const value = options.resolveReference?.(name) ?? options.definitions?.[name];
    if (value === undefined) throw new TypeError(`Unresolved schema reference: ${name}.`);
    definitions[name] = descriptorSchema(value, state, options);
  }
  return typeof schema === 'boolean' ? { allOf: [schema], $defs: definitions } : { ...schema, $defs: definitions };
}

/** Convert model metadata to JSON Schema without evaluating callbacks. */
export function schemaForDescriptor(value: unknown, options: SchemaDescriptorOptions = {}): JsonSchema {
  const state: SchemaAssemblyState = { active: new Set(), references: new Set() };
  if (options.representation === 'model-only' || options.representation === 'wire-only') {
    // Residual schemas reference other models' residual schemas by id; no $defs are inlined.
    return residualSchema(value, options.representation, state, options);
  }
  const assembly: AssemblyOptions = {
    ...options,
    keepPredicates: options.representation !== 'wire',
  };
  return withDefinitions(descriptorSchema(value, state, assembly), state, assembly);
}

function constraintEntries(
  constraint: ModelConstraint,
  options: AssemblyOptions,
  state: SchemaAssemblyState,
): ReadonlyArray<readonly [string, unknown]> {
  switch (constraint.kind) {
    case 'integer': return [['type', 'integer']];
    case 'uniqueItems': return [['uniqueItems', true]];
    case 'minimum': return [['minimum', constraint.value]];
    case 'maximum': return [['maximum', constraint.value]];
    case 'exclusiveMinimum': return [['exclusiveMinimum', constraint.value]];
    case 'exclusiveMaximum': return [['exclusiveMaximum', constraint.value]];
    case 'multipleOf': return [['multipleOf', constraint.value]];
    case 'minLength': return [['minLength', constraint.value]];
    case 'maxLength': return [['maxLength', constraint.value]];
    case 'minItems': return [['minItems', constraint.value]];
    case 'maxItems': return [['maxItems', constraint.value]];
    case 'minProperties': return [['minProperties', constraint.value]];
    case 'maxProperties': return [['maxProperties', constraint.value]];
    case 'minContains': return [['minContains', constraint.value]];
    case 'maxContains': return [['maxContains', constraint.value]];
    case 'pattern': return [['pattern', constraint.value]];
    case 'format': return [['format', constraint.value]];
    case 'contains': return [['contains', descriptorSchema(constraint.schema, state, options)]];
    case 'propertyNames': return [['propertyNames', descriptorSchema(constraint.schema, state, options)]];
    case 'additionalProperties': return [['additionalProperties', descriptorSchema(constraint.schema, state, options)]];
    case 'unevaluatedProperties': return [['unevaluatedProperties', descriptorSchema(constraint.schema, state, options)]];
    case 'items': return [['items', descriptorSchema(constraint.schema, state, options)]];
    case 'unevaluatedItems': return [['unevaluatedItems', descriptorSchema(constraint.schema, state, options)]];
    case 'not': return [['not', descriptorSchema(constraint.schema, state, options)]];
    case 'patternProperties': return [['patternProperties', { [constraint.pattern]: descriptorSchema(constraint.schema, state, options) }]];
    case 'dependentRequired': return [['dependentRequired', Object.fromEntries(
      Object.keys(constraint.value).sort().map((name) => [name, [...constraint.value[name]].sort()]),
    )]];
    case 'dependentSchemas': return [['dependentSchemas', Object.fromEntries(
      Object.keys(constraint.value).sort().map((name) => [name, descriptorSchema(constraint.value[name], state, options)]),
    )]];
    case 'oneOf': return [['oneOf', constraint.schemas.map((schema) => descriptorSchema(schema, state, options))]];
    case 'ifThenElse': return [
      ['if', descriptorSchema(constraint.if, state, options)],
      ...(constraint.then === undefined ? [] : [['then', descriptorSchema(constraint.then, state, options)] as const]),
      ...(constraint.else === undefined ? [] : [['else', descriptorSchema(constraint.else, state, options)] as const]),
    ];
  }
}

function mergeMapKeyword(
  target: Record<string, unknown>,
  keyword: string,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  const existing = target[keyword];
  if (existing !== undefined && !isRecord(existing)) return false;
  const merged: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  for (const name of Object.keys(value).sort()) {
    if (merged[name] !== undefined && canonicalSchemaKey(merged[name]) !== canonicalSchemaKey(value[name])) return false;
    merged[name] = value[name];
  }
  target[keyword] = merged;
  return true;
}

const nonportableCompositionKinds = new Set<ModelConstraint['kind']>([
  'not',
  'oneOf',
  'ifThenElse',
]);

/**
 * Removing a predicate must broaden a wire contract, never strengthen it.
 * Non-monotone operators cannot retain their meaning after predicate erasure.
 */
export function projectPortableConstraints(
  constraints: readonly ModelConstraint[],
  options: SchemaDescriptorOptions = {},
  descriptor?: unknown,
): readonly ModelConstraint[] {
  const containsPredicate = constraints.some(constraint =>
    constraint.kind === 'contains' && constraintHasExecutableValidation(constraint, options));
  const affected = hasExecutableValidation(descriptor, options)
    || constraints.some(constraint => constraintHasExecutableValidation(constraint, options));
  return constraints.filter(constraint => {
    const omit = (nonportableCompositionKinds.has(constraint.kind)
        && constraintHasExecutableValidation(constraint, options))
      || (constraint.kind === 'maxContains' && containsPredicate)
      // Erasing a conditional/composition can remove evaluated annotations.
      || (affected && (constraint.kind === 'unevaluatedProperties' || constraint.kind === 'unevaluatedItems'));
    if (omit) options.onNonportable?.('A predicate-dependent constraint remains in the application because removing its custom rule would change the accepted values.');
    return !omit;
  });
}

/**
 * Assemble constraints while preserving JSON Schema sibling semantics.
 * In particular, `contains`, `minContains`, and `maxContains` must share one
 * schema object; putting them in separate `allOf` branches changes meaning.
 */
function assembleConstraintSchemaInternal(
  constraints: readonly ModelConstraint[],
  options: AssemblyOptions,
  state: SchemaAssemblyState,
): Readonly<Record<string, unknown>> {
  const direct: Record<string, unknown> = {};
  const conflicts: Readonly<Record<string, unknown>>[] = [];
  const sorted = [...(options.portable ? projectPortableConstraints(constraints, options) : constraints)].sort((left, right) => canonicalConstraintKey(left).localeCompare(canonicalConstraintKey(right)));
  for (const constraint of sorted) {
    for (const [keyword, value] of constraintEntries(constraint, options, state)) {
      if (keyword === 'patternProperties' || keyword === 'dependentRequired' || keyword === 'dependentSchemas') {
        if (mergeMapKeyword(direct, keyword, value)) continue;
      }
      if (direct[keyword] === undefined) {
        direct[keyword] = value;
      } else if (canonicalSchemaKey(direct[keyword]) !== canonicalSchemaKey(value)) {
        conflicts.push({ [keyword]: value });
      }
    }
  }
  if (conflicts.length === 0) return direct;
  return {
    ...(Object.keys(direct).length ? { allOf: [direct, ...conflicts] } : { allOf: conflicts }),
  };
}

export function assembleConstraintSchema(
  constraints: readonly ModelConstraint[],
  options: SchemaDescriptorOptions = {},
): Readonly<Record<string, unknown>> {
  const state: SchemaAssemblyState = { active: new Set(), references: new Set() };
  return withDefinitions(assembleConstraintSchemaInternal(constraints, options, state), state, options) as Readonly<Record<string, unknown>>;
}

const schemaValuedKeywords = new Set([
  'contains',
  'propertyNames',
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'unevaluatedItems',
]);

const lowerBoundKeywords = new Set(['minItems', 'minProperties', 'minContains']);
const upperBoundKeywords = new Set(['maxItems', 'maxProperties', 'maxContains']);

function mergeSchemaValues(left: unknown, right: unknown): unknown {
  if (canonicalSchemaKey(left) === canonicalSchemaKey(right)) return left;
  if (left === false || right === false) return false;
  if (left === true) return right;
  if (right === true) return left;
  return { allOf: [left, right] };
}

/**
 * Merge a structural object/array schema with tag keywords in the same
 * validation context.  `additionalProperties` and `unevaluatedProperties`
 * are contextual: moving either keyword into a separate `allOf` branch would
 * make it lose the sibling `properties` annotations and reject valid fields.
 */
function mergeContextualSchema(
  base: Readonly<Record<string, unknown>>,
  constraints: Readonly<Record<string, unknown>>,
): JsonSchema | undefined {
  const baseType = base.type;
  if (baseType !== 'object' && baseType !== 'array') return undefined;
  if (Object.hasOwn(constraints, 'allOf')) return undefined;
  const result: Record<string, unknown> = { ...base };
  for (const [keyword, value] of Object.entries(constraints)) {
    const existing = result[keyword];
    if (existing === undefined) {
      result[keyword] = value;
      continue;
    }
    if (canonicalSchemaKey(existing) === canonicalSchemaKey(value)) continue;
    if (keyword === 'type') {
      if (existing === 'number' && value === 'integer') {
        result[keyword] = value;
        continue;
      }
      return undefined;
    }
    if (lowerBoundKeywords.has(keyword)
      && typeof existing === 'number' && typeof value === 'number') {
      result[keyword] = Math.max(existing, value);
      continue;
    }
    if (upperBoundKeywords.has(keyword)
      && typeof existing === 'number' && typeof value === 'number') {
      result[keyword] = Math.min(existing, value);
      continue;
    }
    if (schemaValuedKeywords.has(keyword)) {
      result[keyword] = mergeSchemaValues(existing, value);
      continue;
    }
    return undefined;
  }
  return result;
}

function mergeSchemas(base: JsonSchema, constraints: JsonSchema): JsonSchema {
  if (base === false || constraints === false) return false;
  if (base === true || Object.keys(base).length === 0) return constraints;
  if (constraints === true) return base;
  if (isRecord(base) && isRecord(constraints)
    && Object.keys(constraints).every((keyword) => keyword === VALIDATION_KEYWORD)) {
    return { ...base, ...constraints };
  }
  const constraintBranches = constraints.allOf;
  if (Array.isArray(constraintBranches)) {
    // A conflicting constraint assembly uses allOf.  Copy the structural
    // sibling context into every branch so object keywords such as
    // additionalProperties still see the base properties annotation.
    return {
      allOf: constraintBranches.map((branch) => {
        if (branch === true || branch === false) return branch;
        if (!isRecord(branch)) return { allOf: [base, branch] };
        return mergeContextualSchema(base, branch) ?? { allOf: [base, branch] };
      }),
    };
  }
  const contextual = mergeContextualSchema(base, constraints);
  if (contextual !== undefined) return contextual;
  return { allOf: [base, constraints] };
}
