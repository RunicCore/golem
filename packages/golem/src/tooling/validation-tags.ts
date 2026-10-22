/**
 * Build-time identity and structural shell of generated tag validators. The
 * model generator uses the key to share one compiled validator per tag.
 */
import type { ModelConstraint, ModelTypeDescriptor } from '../model.js';
import { compareText } from './generator-api.js';
import { canonicalSchemaKey } from './canonical-schema-key.js';

export interface ValidationTagGroup {
  readonly constraints: readonly ModelConstraint[];
  readonly validations: readonly string[];
}

interface ValidationTagKeyOptions {
  readonly definitions?: Readonly<Record<string, ModelTypeDescriptor>>;
  readonly representation?: 'model' | 'wire';
}

/**
 * Return the JSON-safe structural shell used by a generated tag validator.
 * Nested field types are intentionally unconstrained here: the structural
 * visitor validates them at their own descriptor, while object property names
 * and array/object context remain available to sibling JSON Schema keywords.
 */
function tagSchemaShell(
  descriptor: ModelTypeDescriptor,
  definitions: Readonly<Record<string, ModelTypeDescriptor>> | undefined,
  activeReferences: ReadonlySet<string> = new Set(),
): ModelTypeDescriptor {
  switch (descriptor.kind) {
    case 'reference': {
      const referenced = definitions?.[descriptor.name];
      if (referenced && !activeReferences.has(descriptor.name)) {
        return tagSchemaShell(referenced, definitions, new Set([...activeReferences, descriptor.name]));
      }
      return { kind: 'any' };
    }
    case 'object':
      return {
        kind: 'object',
        properties: Object.fromEntries(Object.keys(descriptor.properties).sort().map((name) => [name, { kind: 'any' as const }])),
        required: [],
        additionalProperties: descriptor.additionalProperties === false ? false : true,
      };
    case 'array':
    case 'tuple':
      return { kind: 'array', item: { kind: 'any' } };
    case 'union':
    case 'intersection': {
      const members = descriptor.variants.map((variant) => tagSchemaShell(variant, definitions, activeReferences));
      if (members.some((member) => member.kind === 'object')) {
        const properties: Record<string, ModelTypeDescriptor> = Object.create(null);
        let additionalProperties = true;
        for (const member of members) {
          if (member.kind !== 'object') continue;
          Object.keys(member.properties).forEach((name) => { properties[name] = { kind: 'any' }; });
          if (member.additionalProperties === false) additionalProperties = false;
        }
        return { kind: 'object', properties, required: [], additionalProperties };
      }
      if (members.some((member) => member.kind === 'array')) return { kind: 'array', item: { kind: 'any' } };
      return { kind: 'any' };
    }
    default:
      return { kind: 'any' };
  }
}

export function validationTagSchemaDescriptor(
  descriptor: ModelTypeDescriptor,
  constraints: readonly ModelConstraint[],
  options: ValidationTagKeyOptions = {},
): ModelTypeDescriptor {
  const shell = tagSchemaShell(descriptor, options.definitions);
  return constraints.length ? { ...shell, constraints } : shell;
}

interface TagKeyContext {
  readonly definitions: ValidationTagKeyOptions['definitions'];
  readonly active: Set<string>;
}

/**
 * Internal descriptor metadata is useful while analyzing a model but is not
 * part of a tag validator's structural identity.  In particular, Date
 * descriptors carry an analyzer-only `date` marker and serde descriptors
 * carry executable binding metadata.  Generated model descriptors have
 * already projected those details away by the time a validator runs. Nested
 * predicate identities remain part of the key because they change semantics.
 */
function tagKeySchema(value: unknown, context: TagKeyContext): unknown {
  if (typeof value === 'boolean') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const descriptor = value as Record<string, unknown>;
  if (typeof descriptor.kind !== 'string') return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(descriptor)) {
    // These fields are analyzer/runtime metadata on a descriptor.  They are
    // not JSON Schema data and are projected away before runtime lookup.
    if (key === 'date' || key === 'serde') continue;
    if (key === 'validations' && Array.isArray(item)) {
      result[key] = item.map(binding => {
        if (typeof binding === 'string') return binding;
        if (binding !== null && typeof binding === 'object' && 'id' in binding && typeof binding.id === 'string') return binding.id;
        throw new TypeError('Validation bindings require a declaration identity.');
      }).sort();
      continue;
    }
    if (key === 'properties' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      result[key] = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, property]) => [name, tagKeySchema(property, context)]),
      );
    } else if (key === 'additionalProperties' || key === 'item') {
      result[key] = typeof item === 'object' && item !== null ? tagKeySchema(item, context) : item;
    } else if (key === 'items' || key === 'variants') {
      result[key] = Array.isArray(item) ? item.map(value => tagKeySchema(value, context)) : item;
    } else if (key === 'rest' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const rest = item as Record<string, unknown>;
      result[key] = { ...rest, ...(rest.item === undefined ? {} : { item: tagKeySchema(rest.item, context) }) };
    } else if (key === 'constraints' && Array.isArray(item)) {
      result[key] = item.map(value => tagKeyConstraint(value, context));
    } else {
      result[key] = item;
    }
  }
  if (descriptor.kind === 'reference' && typeof descriptor.name === 'string'
    && context.definitions?.[descriptor.name] && !context.active.has(descriptor.name)) {
    context.active.add(descriptor.name);
    try { result.referenceDefinition = tagKeySchema(context.definitions[descriptor.name], context); }
    finally { context.active.delete(descriptor.name); }
  }
  return result;
}

function tagKeySchemaValue(value: unknown, context: TagKeyContext): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? tagKeySchema(value, context)
    : value;
}

function tagKeyConstraint(value: unknown, context: TagKeyContext): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const constraint = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...constraint };
  const schema = constraint.schema;
  if (schema !== undefined) result.schema = tagKeySchemaValue(schema, context);
  if (constraint.value !== null && typeof constraint.value === 'object' && !Array.isArray(constraint.value)) {
    // `value` is a dependent-schema map only for this constraint family.  A
    // numeric bound or user literal is kept exactly as supplied.
    if (constraint.kind === 'dependentSchemas') {
      result.value = Object.fromEntries(
        Object.entries(constraint.value as Record<string, unknown>).map(([name, item]) => [name, tagKeySchemaValue(item, context)]),
      );
    }
  }
  if (Array.isArray(constraint.schemas)) result.schemas = constraint.schemas.map(value => tagKeySchemaValue(value, context));
  if (constraint.if !== undefined) result.if = tagKeySchemaValue(constraint.if, context);
  if (constraint.then !== undefined) result.then = tagKeySchemaValue(constraint.then, context);
  if (constraint.else !== undefined) result.else = tagKeySchemaValue(constraint.else, context);
  return result;
}

const tagKeys = new WeakMap<ModelTypeDescriptor, {
  group: ValidationTagGroup;
  definitions: ValidationTagKeyOptions['definitions'];
  representation: ValidationTagKeyOptions['representation'];
  key: string;
}[]>();

export function validationTagKey(
  descriptor: ModelTypeDescriptor,
  group: ValidationTagGroup,
  options: ValidationTagKeyOptions = {},
): string {
  // Generated descriptors are immutable contracts. Cache only their lookup
  // preparation; input values and validation results are never cached.
  const cached = tagKeys.get(descriptor);
  const found = cached?.find(entry => entry.group === group
    && entry.definitions === options.definitions && entry.representation === options.representation);
  if (found) return found.key;
  const context: TagKeyContext = { definitions: options.definitions, active: new Set() };
  const constraints = group.constraints.map(constraint => tagKeyConstraint(constraint, context))
    .sort((left, right) => compareText(canonicalSchemaKey(left), canonicalSchemaKey(right)));
  const key = canonicalSchemaKey({
    ...(options.representation === undefined ? {} : { representation: options.representation }),
    descriptor: tagKeySchema(tagSchemaShell(descriptor, options.definitions), context),
    constraints,
    validations: [...group.validations].sort(),
  });
  const entry = { group, definitions: options.definitions, representation: options.representation, key };
  if (cached) cached.push(entry);
  else tagKeys.set(descriptor, [entry]);
  return key;
}
