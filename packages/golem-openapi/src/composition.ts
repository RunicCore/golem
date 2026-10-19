/**
 * The one reader that decides what an allOf object schema means. The model type and the conversion descriptor (and the
 * validator plan, which reads the descriptor) read its result. The merge rules are `composeObjects` in golem; this module
 * turns schemas into object parts:
 *
 * - Field position: a `$ref` member expands to the component's flat shape, so own properties plus `allOf [$ref Base]` give
 *   one plain object.
 * - Field position: one model `$ref` with no own object keywords stays that model (`allOf [$ref Pet]` plus a description).
 *   An expansion that meets the schema it resolves (a model that wraps a reference to itself) keeps the members too.
 * - Definition position: a component that extends a generated model keeps its base; the resolver decides which names no
 *   value can hold, inherited ones included, and closes the object for `unevaluatedProperties`. The component's own
 *   keywords beside its allOf are one more part.
 * - Null follows JSON Schema AND: the object admits null when every part that declares a `type` admits it.
 * - `unevaluatedProperties` judges the names that no part lists, when no part has `additionalProperties`.
 */

import {
  composeObjects,
  descriptorSlotRule,
  isRejected,
  type ObjectExtra,
  type ObjectPart,
  type ObjectResult,
  type SlotRule,
} from '@exprtlabs/golem/generator-api';
import type { ModelConstraint, ModelTypeDescriptor } from '@exprtlabs/golem/model';

import { isJsonObject, objectEntries } from './json.js';
import { effectiveSchemaTypes } from './normalize.js';

export const COMPOSITION_CONVERSION_CONFLICT = 'OPENAPI_COMPOSITION_CONVERSION_CONFLICT';
export const COMPOSITION_UNSATISFIABLE = 'OPENAPI_COMPOSITION_UNSATISFIABLE';
export const COMPOSITION_PROPERTY_NEVER = 'OPENAPI_COMPOSITION_PROPERTY_NEVER';

/** A schema in the scope it is read in. */
export interface ScopedSchema<S> {
  readonly schema: unknown;
  readonly scope: S;
}

/** How the resolver reads schemas: the caller owns `$ref` resolution, scopes and descriptors. */
export interface CompositionReader<S> {
  /** A `$ref` member: the component it names, read in its own scope; `model` when the component is a generated model. */
  reference(schema: unknown, scope: S): { readonly name: string; readonly target: unknown; readonly scope: S; readonly model: boolean } | undefined;
  /** The scope of a schema nested in `scope`. */
  nested(schema: unknown, scope: S): S;
  /** The schema's descriptor; undefined when the schema is being resolved on this path (it refers back to itself). */
  descriptor(schema: unknown, scope: S): ModelTypeDescriptor | undefined;
}

/** A name that no value can hold, and whether a closed part (`additionalProperties: false`) rejects it. */
export interface NeverName {
  readonly name: string;
  readonly closed: boolean;
}

/** One name's child: its descriptor, and the schemas whose type it shows (none for a name that no value can hold). */
export interface SlotChild<S> {
  readonly descriptor: ModelTypeDescriptor;
  readonly sources: readonly ScopedSchema<S>[];
}

export type Composition<S> =
  | {
    readonly kind: 'object';
    readonly slots: Readonly<Record<string, SlotChild<S>>>;
    readonly required: readonly string[];
    readonly extra: ObjectExtra<SlotChild<S>>;
    readonly nullable: boolean;
    readonly constraints: readonly ModelConstraint[];
    readonly never: readonly NeverName[];
  }
  /**
   * A component that extends a generated model keeps its base: the descriptor joins its members, with the own names that
   * no value can hold as `never` and `unevaluatedProperties: false` as a constraint.
   */
  | { readonly kind: 'inherits'; readonly descriptor: ModelTypeDescriptor; readonly never: readonly NeverName[] }
  /** Not an object composition: a scalar, sequence, oneOf or constraint-only allOf; the caller keeps its own reading. */
  | { readonly kind: 'members' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** An allOf member that converts nothing: it adds constraints, or nothing at all (`{ description }`, `{}`). */
export function isConstraintOnlyPart(part: ModelTypeDescriptor): boolean {
  return part.kind === 'unknown' && part.validations === undefined && part.serde === undefined;
}

export function resolveComposition<S>(
  schema: unknown,
  scope: S,
  reader: CompositionReader<S>,
  position: 'field' | 'definition',
): Composition<S> {
  try {
    return resolveObjects(schema, scope, reader, position);
  } catch (error) {
    if (error instanceof ExpansionCycle) return { kind: 'members' };
    throw error;
  }
}

/** An expansion reached the schema that it resolves: the plain object would contain itself, so the members stay. */
class ExpansionCycle extends Error {}

function resolveObjects<S>(
  schema: unknown,
  scope: S,
  reader: CompositionReader<S>,
  position: 'field' | 'definition',
): Composition<S> {
  if (!isJsonObject(schema) || !Array.isArray(schema.allOf) || schema.allOf.length === 0) return { kind: 'members' };
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || isSequence(schema)) return { kind: 'members' };
  const nested = reader.nested(schema, scope);
  const members = schema.allOf.map((member) => ({ member, descriptor: describe(member, nested, reader) }));
  const deciding = members.filter(({ descriptor }) => !isConstraintOnlyPart(descriptor));
  if (deciding.length === 0) return { kind: 'members' };
  const constraints = members.flatMap(({ descriptor }) => isConstraintOnlyPart(descriptor) ? descriptor.constraints ?? [] : []);
  const rule = slotRule<S>();
  const ownPart = ownObjectPart(schema, scope, reader);
  const [only] = deciding;
  if (position === 'field' && ownPart === undefined && deciding.length === 1 && only && reader.reference(only.member, nested)?.model) {
    return { kind: 'members' };
  }

  if (position === 'definition' && deciding.some(({ member }) => reader.reference(member, nested)?.model)) {
    const parts: ObjectPart<SlotChild<S>>[] = ownPart ? [ownPart] : [];
    for (const { member } of deciding) {
      const part = objectPart(member, nested, reader, new Set());
      if (part === undefined) return { kind: 'members' };
      parts.push(part);
    }
    const composed = composeObjects(parts, rule);
    if (isRejected(composed)) return conflict(composed.rejected);
    const never = neverSlots(composed);
    const required = never.filter(({ name }) => composed.required.includes(name));
    if (required.length) return unsatisfiable(required);
    const closes = schema.unevaluatedProperties === false && parts.every((part) => part.extra.mode === 'open');
    const names = never.map(({ name }) => name);
    const joined = joinMembers([
      ...(ownPart ? [ownPartDescriptor(ownPart, requiredNames(schema))] : []),
      ...members.map(({ descriptor }) => withNeverProperties(descriptor, names)),
    ]);
    return {
      kind: 'inherits',
      descriptor: closes ? { ...joined, constraints: [...(joined.constraints ?? []), evaluatedNamesOnly(composed.slots)] } : joined,
      never,
    };
  }

  const parts: ObjectPart<SlotChild<S>>[] = [];
  if (ownPart) parts.push(ownPart);
  for (const { member } of deciding) {
    const part = objectPart(member, nested, reader, new Set());
    if (part === undefined) return { kind: 'members' };
    parts.push(part);
  }
  parts.push({ slots: {}, required: composedRequired(schema), extra: { mode: 'open' } });
  const composed = composeObjects(parts, rule);
  if (isRejected(composed)) return conflict(composed.rejected);
  const never = neverSlots(composed);
  const unsatisfied = never.filter(({ name }) => composed.required.includes(name));
  if (unsatisfied.length) return unsatisfiable(unsatisfied);
  const extra = composed.extra.mode === 'open' ? unevaluatedExtra(schema, nested, reader) : composed.extra;
  return {
    kind: 'object',
    slots: composed.slots,
    required: composed.required,
    extra,
    nullable: admitsNull(schema, scope, reader, new Set()),
    constraints,
    never,
  };
}

/** The names of a composition that no value can hold; the caller warns about each. */
export function neverNames<S>(composition: Composition<S>): readonly NeverName[] {
  return composition.kind === 'inherits' || composition.kind === 'object' ? composition.never : [];
}

/** Why a name holds no value, and the fix: the two-step fix for a closed member, one schema for disjoint types. */
export function neverReason(never: NeverName): string {
  return never.closed ? neverFix : disjointFix;
}

function neverSlots<S>(composed: ObjectResult<SlotChild<S>>): NeverName[] {
  return Object.entries(composed.slots)
    .filter(([, child]) => child.descriptor.kind === 'never')
    .map(([name]) => ({ name, closed: composed.closed.includes(name) }));
}

function describe<S>(schema: unknown, scope: S, reader: CompositionReader<S>): ModelTypeDescriptor {
  const descriptor = reader.descriptor(schema, scope);
  if (descriptor === undefined) throw new ExpansionCycle();
  return descriptor;
}

function slotRule<S>(): SlotRule<SlotChild<S>> {
  return {
    never: { descriptor: descriptorSlotRule.never, sources: [] },
    combine(children) {
      const merged = descriptorSlotRule.combine(children.map((child) => child.descriptor));
      if (isRejected(merged)) return merged;
      if (merged.kind === 'never') return { descriptor: merged, sources: [] };
      const key = JSON.stringify(merged);
      const exact = children.find((child) => JSON.stringify(child.descriptor) === key);
      if (exact) return { descriptor: merged, sources: exact.sources };
      const sameKind = children.filter((child) => child.descriptor.kind === merged.kind);
      return { descriptor: merged, sources: (sameKind.length === 1 ? sameKind : children).flatMap((child) => child.sources) };
    },
  };
}

function conflict(reason: string): Composition<never> {
  return {
    kind: 'rejected',
    code: COMPOSITION_CONVERSION_CONFLICT,
    message: `The allOf members convert one property differently (${reason}). Give the property one schema.`,
  };
}

function unsatisfiable(names: readonly NeverName[]): Composition<never> {
  return {
    kind: 'rejected',
    code: COMPOSITION_UNSATISFIABLE,
    message: `No object satisfies this allOf: ${names.map((never) => `the required property ${JSON.stringify(never.name)} ${neverReason(never)}`).join(' ')}`,
  };
}

/** The two-step fix for a name that a member's `additionalProperties: false` rejects. */
const neverFix = 'cannot hold a value, because a member\'s additionalProperties: false rejects it. '
  + 'Remove additionalProperties: false from the base, then add unevaluatedProperties: false to each derived component.';

/** The fix for a name whose declarations and judging additionalProperties schemas share no value. */
const disjointFix = 'has no value that every member accepts: its declarations and the additionalProperties schemas of the members '
  + 'that do not list it have no common type. Give it one type in every member.';

/** A schema's own object keywords as one part; undefined when it has none. */
function ownObjectPart<S>(schema: Readonly<Record<string, unknown>>, scope: S, reader: CompositionReader<S>): ObjectPart<SlotChild<S>> | undefined {
  if (schema.properties === undefined && schema.additionalProperties === undefined && schema.required === undefined) return undefined;
  const nested = reader.nested(schema, scope);
  const slots: Record<string, SlotChild<S>> = Object.create(null);
  for (const [name, child] of objectEntries(schema.properties)) slots[name] = leaf(child, nested, reader);
  const additional = schema.additionalProperties;
  const extra: ObjectExtra<SlotChild<S>> = additional === false
    ? { mode: 'closed' }
    : isJsonObject(additional) ? { mode: 'values', child: leaf(additional, nested, reader) } : { mode: 'open' };
  return { slots, required: requiredNames(schema), extra };
}

/** A member as one object part, with `$ref` members expanded; undefined when the member is not an object. */
function objectPart<S>(schema: unknown, scope: S, reader: CompositionReader<S>, visiting: Set<unknown>): ObjectPart<SlotChild<S>> | undefined {
  if (!isJsonObject(schema) || visiting.has(schema)) return undefined;
  const reference = reader.reference(schema, scope);
  if (reference) {
    visiting.add(schema);
    const part = objectPart(reference.target, reference.scope, reader, visiting);
    visiting.delete(schema);
    return part;
  }
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || isSequence(schema)) return undefined;
  const nested = reader.nested(schema, scope);
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  const parts: ObjectPart<SlotChild<S>>[] = [];
  const own = ownObjectPart(schema, scope, reader);
  if (own) parts.push(own);
  for (const member of members) {
    if (isConstraintOnlyPart(describe(member, nested, reader))) {
      parts.push({ slots: {}, required: requiredNames(member), extra: { mode: 'open' } });
      continue;
    }
    const part = objectPart(member, nested, reader, visiting);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  const types = effectiveSchemaTypes(schema).filter((type) => type !== 'null');
  if (parts.length === 0) return types.length === 1 && types[0] === 'object' ? { slots: {}, required: [], extra: { mode: 'open' } } : undefined;
  if (types.length > 0 && !types.includes('object')) return undefined;
  if (parts.length === 1) return parts[0];
  const composed = composeObjects(parts, slotRule<S>());
  return isRejected(composed) ? undefined : { slots: composed.slots, required: composed.required, extra: composed.extra };
}

function leaf<S>(schema: unknown, scope: S, reader: CompositionReader<S>): SlotChild<S> {
  return { descriptor: describe(schema, scope, reader), sources: [{ schema, scope }] };
}

/** The own part as an object descriptor, so the component's descriptor holds its own names beside the allOf. */
function ownPartDescriptor<S>(part: ObjectPart<SlotChild<S>>, required: readonly string[]): ModelTypeDescriptor {
  const { extra } = part;
  return {
    kind: 'object',
    properties: Object.fromEntries(Object.entries(part.slots).map(([name, child]) => [name, child.descriptor])),
    required,
    additionalProperties: extra.mode === 'values' ? extra.child.descriptor : extra.mode === 'open',
  };
}

/** `unevaluatedProperties` of the node: the names that no part lists, when no part judges them by `additionalProperties`. */
function unevaluatedExtra<S>(schema: Readonly<Record<string, unknown>>, scope: S, reader: CompositionReader<S>): ObjectExtra<SlotChild<S>> {
  const unevaluated = schema.unevaluatedProperties;
  if (unevaluated === false) return { mode: 'closed' };
  if (isJsonObject(unevaluated)) return { mode: 'values', child: leaf(unevaluated, scope, reader) };
  return { mode: 'open' };
}

/** JSON Schema AND: null passes when every part that declares a `type` admits it, and at least one part declares one. */
function admitsNull<S>(schema: unknown, scope: S, reader: CompositionReader<S>, visiting: Set<unknown>): boolean {
  const verdicts = nullVerdicts(schema, scope, reader, visiting);
  return verdicts.length > 0 && verdicts.every(Boolean);
}

function nullVerdicts<S>(schema: unknown, scope: S, reader: CompositionReader<S>, visiting: Set<unknown>): boolean[] {
  if (!isJsonObject(schema) || visiting.has(schema)) return [];
  const reference = reader.reference(schema, scope);
  if (reference) {
    visiting.add(schema);
    const verdicts = nullVerdicts(reference.target, reference.scope, reader, visiting);
    visiting.delete(schema);
    return verdicts;
  }
  const own = schema.type === undefined ? [] : [effectiveSchemaTypes(schema).includes('null')];
  const nested = reader.nested(schema, scope);
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  return [...own, ...members.flatMap((member) => nullVerdicts(member, nested, reader, visiting))];
}

/**
 * Rule 2: constraint-only members join the one deciding part; several deciding parts stay an intersection. A component
 * that extends a model keeps this shape, and so does an allOf that is not an object composition.
 */
export function joinMembers(parts: readonly ModelTypeDescriptor[]): ModelTypeDescriptor {
  const constraints: ModelConstraint[] = [];
  const typed: ModelTypeDescriptor[] = [];
  for (const part of parts) {
    if (isConstraintOnlyPart(part)) constraints.push(...(part.constraints ?? []));
    else typed.push(part);
  }
  const [only] = typed;
  if (typed.length === 1 && only) return constraints.length ? { ...only, constraints: [...(only.constraints ?? []), ...constraints] } : only;
  if (typed.length === 0 && constraints.length) return { kind: 'unknown', constraints };
  return { kind: 'intersection', variants: [...parts] };
}

/** Rule 5: the required names of a schema, its own and those that its allOf members list. */
export function composedRequired(schema: unknown): string[] {
  const members = isJsonObject(schema) && Array.isArray(schema.allOf) ? schema.allOf : [];
  return [...new Set([...requiredNames(schema), ...members.flatMap(requiredNames)])];
}

/** The schema's own keywords, with the required names of its allOf members: what it converts as when no member decides. */
export function ownKeywords(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { allOf: _members, ...own } = schema;
  const required = composedRequired(schema);
  return required.length ? { ...own, required } : own;
}

/**
 * `unevaluatedProperties: false` of a component whose parts are all open: the evaluated names are exactly the names that
 * the parts list, so the constraint is `propertyNames` over them. The descriptor's members are objects with
 * `additionalProperties: true`, which in JSON Schema evaluates every name, so the keyword itself would close nothing.
 */
function evaluatedNamesOnly<C>(slots: Readonly<Record<string, C>>): ModelConstraint {
  const names = Object.keys(slots).sort().map((value): ModelTypeDescriptor => ({ kind: 'literal', value }));
  const [only] = names;
  return { kind: 'propertyNames', schema: names.length === 1 && only ? only : names.length === 0 ? false : { kind: 'union', variants: names } };
}

function withNeverProperties(descriptor: ModelTypeDescriptor, never: readonly string[]): ModelTypeDescriptor {
  if (descriptor.kind !== 'object' || !never.some((name) => Object.hasOwn(descriptor.properties, name))) return descriptor;
  const properties = Object.fromEntries(Object.entries(descriptor.properties)
    .map(([name, property]) => [name, never.includes(name) ? descriptorSlotRule.never : property]));
  return { ...descriptor, properties };
}

function requiredNames(schema: unknown): string[] {
  return isJsonObject(schema) && Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
}

function isSequence(schema: Readonly<Record<string, unknown>>): boolean {
  const declared = effectiveSchemaTypes(schema).filter((type) => type !== 'null');
  if (declared.length === 0) {
    if (schema.properties || schema.additionalProperties !== undefined) return false;
    return Array.isArray(schema.prefixItems) || Boolean(schema.items);
  }
  return declared.every((type) => type === 'array');
}
