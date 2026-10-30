/**
 * Canonical JSON Schema assembly for generated model constraints.
 *
 * The model generator and the validator compiler
 * both consume the same constraint representation. Runtime schemas refer to
 * callback bindings by declaration identity; portable schemas omit executable
 * rules without narrowing the set of accepted values.
 */

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

import type { ConstraintSchemaValue, ModelConstraint } from '../model-registry.js';
import {
  GENERATED_MODEL_SCHEMA_REF_PREFIX,
  MODEL_CLASS_KEYWORD,
  MODEL_DATE_KEYWORD,
  MODEL_CODEC_IDS_KEY,
  MODEL_INSTANCE_KEYWORD,
  VALIDATION_KEYWORD,
} from '../schema-keywords.js';
import { canonicalSchemaKey } from './canonical-schema-key.js';
import { compareText, isRecord } from './generator-core.js';

export { assertSupportedModelFieldName } from '../model-field-names.js';
export { decodeUriFragment, escapePointerToken, unescapePointerToken } from '../json-pointer.js';
export { canonicalSchemaKey };
/** The schema descriptor types that generators read (`@exprtlabs/golem/internal/schema`). */
export type { ConstraintSchemaValue, DiscriminatorValue, ModelConstraint, ModelTypeDescriptor, ModelTypeMetadata, UnionDiscriminator } from '../model-registry.js';
export { GENERATED_MODEL_SCHEMA_REF_PREFIX, MODEL_CLASS_KEYWORD, MODEL_CODEC_IDS_KEY, MODEL_DATE_KEYWORD, MODEL_INSTANCE_KEYWORD, VALIDATION_KEYWORD };
export { validationTagSchemaDescriptor } from './validation-tags.js';

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
  /**
   * Give a discriminator of $ref branches a mapping from each tag to its branch. An OpenAPI document needs it: without
   * one, a tag names a component.
   */
  readonly discriminatorMapping?: boolean;
  /**
   * Write the declared default variant of a union as `discriminator.defaultMapping` (OpenAPI 3.2). OpenAPI 3.1 has no such
   * keyword and requires the tag, which the default lacks, so without this option a union with a default stays `anyOf`.
   */
  readonly discriminatorDefaultMapping?: boolean;
  readonly portable?: boolean;
  readonly onNonportable?: (message: string) => void;
  /** Resolve a descriptor reference without executing application code. */
  readonly resolveReference?: (name: string) => unknown | undefined;
  /** Convenience registry for callers that already have descriptor definitions. */
  readonly definitions?: Readonly<Record<string, unknown>>;
  /**
   * Interned child codec ids whose validator was not emitted. Parent schemas inline
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
    case 'allOf':
      return constraint.schemas;
    case 'ifThenElse':
      return [constraint.if, ...(constraint.then === undefined ? [] : [constraint.then]), ...(constraint.else === undefined ? [] : [constraint.else])];
    default:
      return [];
  }
}

/** The constraint with each schema value replaced by `map`: the one switch over the constraint kinds that hold schemas, beside `constraintSchemaValues`. */
export function mapConstraintSchemaValues(
  constraint: ModelConstraint,
  map: (value: ConstraintSchemaValue) => ConstraintSchemaValue,
): ModelConstraint {
  switch (constraint.kind) {
    case 'contains':
    case 'propertyNames':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'items':
    case 'unevaluatedItems':
    case 'not':
    case 'patternProperties':
      return { ...constraint, schema: map(constraint.schema) };
    case 'dependentSchemas':
      return { ...constraint, value: Object.fromEntries(Object.entries(constraint.value).map(([name, value]) => [name, map(value)])) };
    case 'oneOf':
    case 'allOf':
      return { ...constraint, schemas: constraint.schemas.map(map) };
    case 'ifThenElse':
      return {
        ...constraint,
        if: map(constraint.if),
        ...(constraint.then === undefined ? {} : { then: map(constraint.then) }),
        ...(constraint.else === undefined ? {} : { else: map(constraint.else) }),
      };
    default:
      return constraint;
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
          throw new TypeError('Validation bindings require a declaration identity.');
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
      // Constraint tags are a set: written order must not change a codec id.
      result[key] = item.map(canonicalConstraintValue).sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
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

function hasDiscriminatorTag(branch: JsonSchema, propertyName: string): boolean {
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

/**
 * A descriptor that holds a golem-mode SDK schema inline checks as a reference to that schema's codec. The tags the app puts beside the
 * SDK type on the field (`TValidation`, constraints, `TSerde`, date) stay on the reference, so the SDK's check and the app's rule both run.
 */
function sdkNodeReference(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.sdkNode !== 'string') return value;
  const { validations, constraints, serde, date } = value;
  return {
    kind: 'generated-model',
    id: value.sdkNode,
    ...(validations === undefined ? {} : { validations }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(serde === undefined ? {} : { serde }),
    ...(date === undefined ? {} : { date }),
  };
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
): { readonly propertyName: string; readonly values: readonly (readonly unknown[])[]; readonly defaultVariant?: number } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.propertyName !== 'string' || !Array.isArray(value.variants)
    || value.variants.length !== count) {
    throw new TypeError('A union discriminator needs a propertyName and tag values for every variant.');
  }
  return {
    propertyName: value.propertyName,
    values: value.variants.map((variant) => isRecord(variant) && Array.isArray(variant.values) ? variant.values : []),
    ...(typeof value.defaultVariant === 'number' ? { defaultVariant: value.defaultVariant } : {}),
  };
}

/** A string-keyed phantom member is a brand: its name starts with two underscores, such as `__brand`. */
export function isBrandPropertyName(name: string): boolean {
  return name.startsWith('__');
}

/** An object descriptor whose every property is a brand (`{ readonly __brand: 'Email' }`, `{ __brand?: never }`): a type-only mark, no data. */
export function isBrandDescriptor(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== 'object' || !isRecord(value.properties)) return false;
  const names = Object.keys(value.properties);
  return names.length > 0 && names.every(isBrandPropertyName);
}

type ResidualPlane = 'model-only' | 'wire-only';

/**
 * Binding ids in a fixed order, like constraints: the codec id ignores predicate order, so types that differ only
 * in that order must also produce the same bindings.
 */
function validationBindingIds(validations: readonly unknown[]): string[] {
  return [...new Set(validations.map((binding) => {
    if (typeof binding === 'string') return binding;
    if (isRecord(binding) && typeof binding.id === 'string') return binding.id;
    throw new TypeError('Validation bindings must have declaration identifiers.');
  }))].sort();
}

function ownValidationBindings(value: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(value.validations) || value.validations.length === 0) return undefined;
  return validationBindingIds(value.validations);
}

/** What is left to check after the full check of the other plane; `true` when nothing is. */
function residualSchema(given: unknown, plane: ResidualPlane, state: SchemaAssemblyState, options: AssemblyOptions): JsonSchema {
  if (!isRecord(given)) return true;
  const value = sdkNodeReference(given);
  const full = (representation: 'model' | 'wire'): JsonSchema =>
    descriptorSchema(value, state, { ...options, representation, keepPredicates: undefined });
  const serde = isRecord(value.serde) ? value.serde : undefined;
  if (serde) {
    // The model plane ignores the serde's wire form, but a class binding's validity predicate (`valid`) is part of its model check.
    if (plane === 'model-only') return descriptorSchema(value, state, { ...options, representation: 'model', keepPredicates: true });
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
      const additional = isRecord(value.additionalProperties) ? child(value.additionalProperties) : true;
      // A property that needs no check stays listed while another schema judges the other names, or that schema would judge it.
      const kept = Object.keys(properties).sort()
        .map((name) => [name, child(properties[name])] as const)
        .filter(([, schema]) => schema !== true || additional !== true);
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
  given: unknown,
  state: SchemaAssemblyState,
  options: AssemblyOptions,
): JsonSchema {
  if (typeof given === 'boolean') return given;
  if (!isRecord(given)) throw new TypeError('A schema descriptor must be an object or boolean.');
  const value = sdkNodeReference(given);
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
      // The wire form of a class value is its serde's wire descriptor; the model form is an instance of the class, where a runtime class exists.
      case 'class-value': {
        const ref = isRecord(value.classRef) ? value.classRef : undefined;
        const valid = isRecord(value.serde) && typeof value.serde.valid === 'string' ? value.serde.valid : undefined;
        schema = options.representation === 'model' && ref !== undefined && typeof value.typeName === 'string'
          ? { [MODEL_CLASS_KEYWORD]: { name: value.typeName, path: ref.path, ...(ref.id === undefined ? {} : { id: ref.id }), ...(valid === undefined ? {} : { valid }) } }
          : {};
        break;
      }
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
          if (table && index === table.defaultVariant && options.discriminatorMapping !== true && options.discriminatorDefaultMapping !== true) {
            // The default takes only the values whose tag selects no variant, so an open default does not also accept a tagged variant's value.
            // A model instance of another variant's class is that variant's, tag or not: the encoder selects it by class.
            const taken = table.values.flat();
            const of = modelClassId(variant);
            const byClass = among.length === 0 ? {} : { [MODEL_INSTANCE_KEYWORD]: { ...(of === undefined ? {} : { of }), among, required: false } };
            return taken.length === 0 && among.length === 0 ? branch : {
              allOf: [branch],
              ...(taken.length === 0 ? {} : { not: { required: [table.propertyName], properties: { [table.propertyName]: { enum: taken } } } }),
              ...byClass,
            };
          }
          if (!table || !values?.length || options.discriminatorMapping === true) return branch;
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
        // A document states each branch as the variant itself: the variant declares its tag, and the discriminator maps it.
        // A union without a tag table, or with a branch the discriminator cannot name, stays anyOf.
        const documented = options.discriminatorMapping === true;
        const refs = branches.map((branch) => isRecord(branch) && typeof branch.$ref === 'string' ? branch.$ref : undefined);
        // A mapping could name only the $ref branches, so a union that mixes them with inline objects keeps anyOf.
        const mixed = documented && refs.some((ref) => ref !== undefined) && refs.some((ref) => ref === undefined);
        const defaultAt = table?.defaultVariant === undefined ? -1 : present.findIndex(({ index }) => index === table.defaultVariant);
        const defaultWritable = defaultAt < 0 || (options.discriminatorDefaultMapping === true && refs[defaultAt] !== undefined);
        // A discriminator requires a required tag with non-empty string const or enum values for each branch it selects. Other tags keep anyOf.
        const tagged = table !== undefined && !mixed && defaultWritable && present.every(({ index }, position) => position === defaultAt
          || (documented
            ? table.values[index]!.length > 0 && table.values[index]!.every((item) => typeof item === 'string' && item !== '')
            : hasDiscriminatorTag(branches[position], table.propertyName)));
        const mapping = tagged && documented && refs.every((ref) => ref !== undefined)
          ? Object.fromEntries(present.flatMap(({ index }, position) => position === defaultAt ? [] : table.values[index]!.map((item) => [item, refs[position]])))
          : undefined;
        const defaultMapping = tagged && defaultAt >= 0 ? refs[defaultAt] : undefined;
        schema = tagged
          ? { discriminator: { propertyName: table.propertyName, ...(mapping ? { mapping } : {}), ...(defaultMapping ? { defaultMapping } : {}) }, oneOf: branches }
          : { anyOf: branches };
        break;
      }
      case 'intersection': {
        const variants = Array.isArray(value.variants) ? value.variants : [];
        const scalar = variants.find((variant) => isRecord(variant)
          && (variant.kind === 'string' || variant.kind === 'number' || variant.kind === 'boolean' || variant.kind === 'null'));
        schema = scalar && variants.every((variant) => variant === scalar || isBrandDescriptor(variant))
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
      const validations = validationBindingIds(value.validations);
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
    case 'enum': return [['enum', constraint.values]];
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
    case 'oneOf':
    case 'allOf': return [[constraint.kind, constraint.schemas.map((schema) => descriptorSchema(schema, state, options))]];
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
  const conflicts: JsonSchema[] = [];
  const sorted = [...(options.portable ? projectPortableConstraints(constraints, options) : constraints)].sort((left, right) => compareText(canonicalConstraintKey(left), canonicalConstraintKey(right)));
  for (const constraint of sorted) {
    for (const [keyword, value] of constraintEntries(constraint, options, state)) {
      // An allOf constraint's schemas are branches beside the direct keywords, as conflicting keywords are.
      if (keyword === 'allOf' && Array.isArray(value)) {
        conflicts.push(...value.filter((item): item is JsonSchema => typeof item === 'boolean' || isRecord(item)));
        continue;
      }
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
    if (keyword === 'type') return undefined;
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
