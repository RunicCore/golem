/**
 * The one reader that decides what an allOf object schema means. The model type and the conversion descriptor (and the
 * validator plan, which reads the descriptor) read its result. The merge rules are `composeObjects` in golem; this module
 * turns schemas into object parts:
 *
 * - Field position: a `$ref` member expands to the component's flat shape, so own properties plus `allOf [$ref Base]` give
 *   one plain object.
 * - Field position: one model `$ref` with no own object keywords stays that model (`allOf [$ref Pet]` plus a description);
 *   `unevaluatedProperties: false` beside it closes the model's names.
 *   An expansion that meets the schema it resolves (a model that wraps a reference to itself) keeps the members too.
 * - Definition position: a component that extends a generated model keeps its base; the resolver decides which names no
 *   value can hold, inherited ones included, and closes the object for `unevaluatedProperties`. The component's own
 *   keywords beside its allOf are one more part.
 * - Null follows JSON Schema AND: the object admits null when every part that declares a `type` admits it.
 * - `unevaluatedProperties` judges the names that no part lists, when no part has `additionalProperties`.
 */

import {
  composeObjects,
  conversionKey,
  descriptorNeedsConversion,
  descriptorSlotRule,
  isRejected,
  type ObjectExtra,
  type ObjectPart,
  type ObjectResult,
  type SlotRule,
} from '@exprtlabs/golem/internal/emitter';
import type { ModelConstraint, ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';

import { asRecord, isJsonObject, objectEntries } from './json.js';
import { effectiveSchemaTypes } from './normalize.js';

export const COMPOSITION_CONVERSION_CONFLICT = 'OPENAPI_COMPOSITION_CONVERSION_CONFLICT';
export const COMPOSITION_UNSATISFIABLE = 'OPENAPI_COMPOSITION_UNSATISFIABLE';
export const COMPOSITION_PROPERTY_NEVER = 'OPENAPI_COMPOSITION_PROPERTY_NEVER';

/** A schema in the scope it is read in. */
interface ScopedSchema<S> {
  readonly schema: unknown;
  readonly scope: S;
}

/** How the resolver reads schemas: the caller owns `$ref` resolution, scopes and descriptors. */
export interface CompositionReader<S> {
  /** A `$ref` member: the component it names, read in its own scope; `model` when the component is a generated model. */
  reference(schema: unknown, scope: S): { readonly name: string; readonly referenced: unknown; readonly scope: S; readonly model: boolean } | undefined;
  /** The scope of a schema nested in `scope`. */
  nested(schema: unknown, scope: S): S;
  /** The schema's descriptor; undefined when the schema is being resolved on this path (it refers back to itself). */
  descriptor(schema: unknown, scope: S): ModelTypeDescriptor | undefined;
  /** The generated models that the model `id` extends, so a derived model narrows each base in one slot. */
  basesOf(id: string): readonly string[];
}

/**
 * A name that no value can hold, and whether a closed part (`additionalProperties: false`) rejects it. `closer` names that
 * part when it is the schema's own (its own keywords or an inline allOf member); a `$ref` base leaves it undefined.
 */
interface NeverName {
  readonly name: string;
  readonly closed: boolean;
  readonly closer?: string;
}

/** One name's child: its descriptor, and the schemas whose type it shows (none for a name that no value can hold). */
interface SlotChild<S> {
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
    /** Some part says `additionalProperties: true` itself, as a plain object does: the object then writes its extra keys. */
    readonly declaredOpen: boolean;
    readonly constraints: readonly ModelConstraint[];
    readonly never: readonly NeverName[];
  }
  /**
   * A component that extends a generated model keeps its base: the descriptor joins its members, with the own names that
   * no value can hold as `never` and `unevaluatedProperties: false` as a constraint. A field that is one model reference
   * with `unevaluatedProperties: false` keeps that model the same way.
   */
  | { readonly kind: 'inherits'; readonly descriptor: ModelTypeDescriptor; readonly never: readonly NeverName[] }
  /**
   * An allOf with a union member (`allOf [X, { oneOf: [A, B] }]`) is a union of objects: `X AND A` or `X AND B`, each
   * resolved as an object composition. The caller builds a union of the merged objects.
   */
  | {
    readonly kind: 'variants';
    readonly variants: readonly ObjectComposition<S>[];
    /** The union member and its variant schemas, read in `scope`: the caller builds the discriminator table from them. */
    readonly union: Readonly<Record<string, unknown>>;
    readonly items: readonly unknown[];
    readonly scope: S;
    readonly never: readonly NeverName[];
  }
  /** Not an object composition: a scalar, sequence, oneOf or constraint-only allOf; the caller keeps its own reading. */
  | { readonly kind: 'members' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

type ObjectComposition<S> = Extract<Composition<S>, { readonly kind: 'object' }>;

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
    const disjoint = disjointMemberTypes(schema, scope, reader);
    if (disjoint) return unsatisfiableTypes(disjoint);
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
  originalMembers?: readonly number[],
): Composition<S> {
  if (!isJsonObject(schema) || !Array.isArray(schema.allOf) || schema.allOf.length === 0) return { kind: 'members' };
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || isSequenceSchema(schema)) return { kind: 'members' };
  const nested = reader.nested(schema, scope);
  const members = schema.allOf.map((member) => ({ member, descriptor: describe(member, nested, reader) }));
  const deciding = members.filter(({ descriptor }) => !isConstraintOnlyPart(descriptor));
  if (deciding.length === 0) return { kind: 'members' };
  const constraints = members.flatMap(({ descriptor }) => isConstraintOnlyPart(descriptor) ? descriptor.constraints ?? [] : []);
  if (position === 'field') {
    const distributed = distributeUnion(schema, scope, nested, reader, originalMembers);
    if (distributed) return distributed;
  }
  const rule = slotRule(reader);
  const ownPart = ownObjectPart(schema, scope, reader);
  const [only] = deciding;
  if (position === 'field' && ownPart === undefined && deciding.length === 1 && only && reader.reference(only.member, nested)?.model) {
    return loneReference(schema, only.member, members.map(({ descriptor }) => descriptor), nested, reader);
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
    const never = neverSlots(composed, parts, partNames(schema, ownPart, deciding, nested, reader, originalMembers));
    const required = never.filter(({ name }) => composed.required.includes(name));
    if (required.length) return unsatisfiable(required);
    const closes = schema.unevaluatedProperties === false && parts.every((part) => part.extra.mode === 'open');
    const names = never.map(({ name }) => name);
    const joined = joinMembers([
      ...(ownPart ? [ownPartDescriptor(ownPart, requiredNames(schema), schema.additionalProperties === true)] : []),
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
  const never = neverSlots(composed, parts, partNames(schema, ownPart, deciding, nested, reader, originalMembers));
  const unsatisfied = never.filter(({ name }) => composed.required.includes(name));
  if (unsatisfied.length) return unsatisfiable(unsatisfied);
  const extra = composed.extra.mode === 'open' ? unevaluatedExtra(schema, nested, reader) : composed.extra;
  return {
    kind: 'object',
    slots: composed.slots,
    required: composed.required,
    extra,
    nullable: admitsNull(schema, scope, reader, new Set()),
    declaredOpen: declaresOpen(schema, nested, reader, new Set()),
    constraints,
    never,
  };
}

/**
 * The schema's one inline union member, spread over its variants: each variant replaces the union in the allOf and the result
 * resolves as an object. A rejected variant stops generation; a variant that is no object leaves the schema to its members.
 */
function distributeUnion<S>(
  schema: Readonly<Record<string, unknown>>,
  scope: S,
  nested: S,
  reader: CompositionReader<S>,
  originalMembers?: readonly number[],
): Composition<S> | undefined {
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  const inline = members.flatMap((member, index) =>
    isJsonObject(member) && !reader.reference(member, nested) && (Array.isArray(member.oneOf) || Array.isArray(member.anyOf)) ? [index] : []);
  // Branches that only add constraints (`required`, "at least one of") are no variant: the union of such branches beside a union
  // of objects adds no object to the product. The validator holds the rule, and the type keeps the names that every branch requires.
  const deciding = (at: number): number => {
    const member = asRecord(members[at]);
    const inside = reader.nested(member, nested);
    return (unionVariants(member) ?? []).filter((variant) => !isConstraintOnlyPart(describe(variant, inside, reader))).length;
  };
  const spread = inline.filter((at) => deciding(at) > 0);
  const unions = spread.length ? spread : inline;
  const folded = spread.length ? inline.filter((at) => deciding(at) === 0) : [];
  const [index, another] = unions;
  const union = index === undefined ? undefined : members[index];
  if (index === undefined || !isJsonObject(union)) return undefined;
  // A generated model beside a union that this cannot spread would be built as the model alone: the value would lose the
  // variant's names and the type would not compile. That shape stops generation instead.
  const unspread = members.some((member) => reader.reference(member, nested)?.model)
    ? conflict('a model beside a union that is not one union of objects; give the base and each variant plain object schemas')
    : undefined;
  // Two unions beside a model stop generation (above); two unions with no model spread over the product of their variants.
  if (another !== undefined && unspread !== undefined) return unspread;
  // A union is wide when it has several variants that convert differently.
  const wide = unions.filter((at) => deciding(at) > 1);
  const variants = unionVariants(union) ?? [];
  // The member's other keywords (properties, required, constraints) stay a part of every variant.
  const { oneOf: _oneOf, anyOf: _anyOf, discriminator: _discriminator, ...beside } = union;
  const rest = Object.keys(beside).length ? [beside] : [];
  const objects: ObjectComposition<S>[] = [];
  for (const variant of variants) {
    // The rebuilt allOf has shifted positions; its messages name each member by the position in the schema's own allOf,
    // also when this allOf is itself a rebuilt one.
    const rebuilt = members.flatMap((member, at) => (at === index ? [...rest, variant] : folded.includes(at) ? [constraintsOf(asRecord(member))] : [member])
      .map((replacement) => ({ member: replacement, at: originalMembers?.[at] ?? at })));
    const composed = resolveObjects({ ...schema, allOf: rebuilt.map(({ member }) => member) }, scope, reader, 'field', rebuilt.map(({ at }) => at));
    if (composed.kind === 'rejected') return composed;
    if (composed.kind === 'variants') objects.push(...composed.variants);
    else if (composed.kind !== 'object') return unspread;
    else objects.push(composed);
  }
  // The folded unions still judge the value: each one is a constraint of every object, as it is a keyword of the schema.
  const folding = folded.flatMap((at) => unionConstraint(asRecord(members[at]), reader.nested(asRecord(members[at]), nested), reader));
  const judged = folding.length ? objects.map((object) => ({ ...object, constraints: [...object.constraints, ...folding] })) : objects;
  const never = new Map(judged.flatMap((object) => object.never).map((name) => [name.name, name]));
  if (judged.length <= 1) return judged[0];
  // The merged objects of a product are told apart by the tag of the one union that has several variants. Two such unions leave
  // no single tag, and the codec would have no way to pick a variant.
  if (wide.length > 1 && judged.some(convertsSomething)) {
    return conflict('two unions with several object variants each; give the value one union, or one of the two a single variant');
  }
  // Objects that convert nothing are the wire value as it is: the members stay as they are, and the validator judges each union.
  if (wide.length > 1) return undefined;
  // The discriminator table of one union indexes that union's own variants, not the merged objects of a product, so a product has none.
  const product = another !== undefined;
  return { kind: 'variants', variants: judged, union: product ? {} : union, items: product ? [] : variants, scope: reader.nested(union, nested), never: [...never.values()] };
}

/** What a union of constraint-only branches adds to every value: the members' siblings, and the names that every branch requires. */
function constraintsOf(union: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { oneOf: _oneOf, anyOf: _anyOf, discriminator: _discriminator, ...beside } = union;
  const [first = [], ...others] = (unionVariants(union) ?? []).map(requiredNames);
  const required = first.filter((name) => others.every((names) => names.includes(name)));
  return required.length ? { ...beside, required } : beside;
}

/**
 * A union of constraint-only branches as a constraint: `oneOf` keeps its keyword, and `anyOf` is an allOf of the one union, which
 * accepts a value that any branch accepts. A union with one branch is its `required` names, which `constraintsOf` already adds.
 */
function unionConstraint<S>(union: Readonly<Record<string, unknown>>, scope: S, reader: CompositionReader<S>): ModelConstraint[] {
  const branches = (unionVariants(union) ?? []).map((branch): ModelTypeDescriptor => {
    const { constraints } = describe(branch, scope, reader);
    const required = requiredNames(branch);
    return required.length
      ? { kind: 'object', properties: {}, required, additionalProperties: true, ...(constraints ? { constraints } : {}) }
      : { kind: 'unknown', ...(constraints ? { constraints } : {}) };
  });
  if (branches.length < 2) return [];
  return [Array.isArray(union.oneOf) ? { kind: 'oneOf', schemas: branches } : { kind: 'allOf', schemas: [{ kind: 'union', variants: branches }] }];
}

/** Whether a value of the object changes when the codec converts it. */
function convertsSomething<S>(object: ObjectComposition<S>): boolean {
  return Object.values(object.slots).some((child) => descriptorNeedsConversion(child.descriptor));
}

/**
 * One model reference at field position stays the model. With `unevaluatedProperties: false` and an open model, the names
 * that the model lists are the only evaluated names, so they become a `propertyNames` constraint on the model.
 */
function loneReference<S>(
  schema: Readonly<Record<string, unknown>>,
  member: unknown,
  descriptors: readonly ModelTypeDescriptor[],
  scope: S,
  reader: CompositionReader<S>,
): Composition<S> {
  if (schema.unevaluatedProperties !== false) return { kind: 'members' };
  const part = objectPart(member, scope, reader, new Set());
  if (part === undefined || part.extra.mode !== 'open') return { kind: 'members' };
  const joined = joinMembers(descriptors);
  return { kind: 'inherits', descriptor: { ...joined, constraints: [...(joined.constraints ?? []), evaluatedNamesOnly(part.slots)] }, never: [] };
}

/** The names of a composition that no value can hold; the caller warns about each. */
export function neverNames<S>(composition: Composition<S>): readonly NeverName[] {
  return composition.kind === 'inherits' || composition.kind === 'object' || composition.kind === 'variants' ? composition.never : [];
}

/** Why a name holds no value, and the fix: the two-step fix for a closed member, one schema for disjoint types. */
export function neverReason(never: NeverName): string {
  if (!never.closed) return disjointFix;
  return never.closer === undefined ? neverFix
    : `cannot hold a value, because ${never.closer} sets additionalProperties: false. `
      + 'Replace it with unevaluatedProperties: false beside the allOf.';
}

/** The schema's own parts by name, in the order of `parts`; a `$ref` member is undefined. */
function partNames<S>(
  schema: Readonly<Record<string, unknown>>,
  ownPart: ObjectPart<SlotChild<S>> | undefined,
  deciding: readonly { readonly member: unknown }[],
  scope: S,
  reader: CompositionReader<S>,
  originalMembers?: readonly number[],
): (string | undefined)[] {
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  return [
    ...(ownPart ? ['the schema itself'] : []),
    ...deciding.map(({ member }) => reader.reference(member, scope) ? undefined : `allOf member ${originalMembers?.[members.indexOf(member)] ?? members.indexOf(member)}`),
  ];
}

function neverSlots<S>(composed: ObjectResult<SlotChild<S>>, parts: readonly ObjectPart<SlotChild<S>>[], names: readonly (string | undefined)[]): NeverName[] {
  return Object.entries(composed.slots)
    .filter(([, child]) => child.descriptor.kind === 'never')
    .map(([name]) => {
      if (!composed.closed.includes(name)) return { name, closed: false };
      const closer = names[parts.findIndex((part) => part.extra.mode === 'closed' && !Object.hasOwn(part.slots, name))];
      return closer === undefined ? { name, closed: true } : { name, closed: true, closer };
    });
}

function describe<S>(schema: unknown, scope: S, reader: CompositionReader<S>): ModelTypeDescriptor {
  const descriptor = reader.descriptor(schema, scope);
  if (descriptor === undefined) throw new ExpansionCycle();
  return descriptor;
}

/**
 * The slot rule of schema children: the descriptors combine by the golem rule, and the type shows the schemas of the child
 * that decides. A union child that the rule narrows to one variant shows that variant's schema.
 */
function slotRule<S>(reader: CompositionReader<S>): SlotRule<SlotChild<S>> {
  const rule = descriptorSlotRule(reader);
  return {
    never: { descriptor: rule.never, sources: [] },
    combine(children) {
      const merged = rule.combine(children.map((child) => child.descriptor));
      if (isRejected(merged)) return merged;
      if (merged.kind === 'never') return { descriptor: merged, sources: [] };
      const candidates = children.map((child) => narrowedVariant(child, merged, reader));
      const key = JSON.stringify(merged);
      const exact = candidates.find((child) => JSON.stringify(child.descriptor) === key);
      if (exact) return { descriptor: merged, sources: exact.sources };
      const sameKind = candidates.filter((child) => child.descriptor.kind === merged.kind);
      return { descriptor: merged, sources: (sameKind.length === 1 ? sameKind : candidates).flatMap((child) => child.sources) };
    },
  };
}

/**
 * A oneOf or anyOf child as the one variant that converts as `merged` (the checks that the merge joined aside); the child
 * itself when none or several do.
 */
function narrowedVariant<S>(child: SlotChild<S>, merged: ModelTypeDescriptor, reader: CompositionReader<S>): SlotChild<S> {
  const [source, other] = child.sources;
  if (child.descriptor.kind !== 'union' || source === undefined || other !== undefined || !isJsonObject(source.schema)) return child;
  const items = unionVariants(source.schema) ?? [];
  const key = conversionKey(merged);
  const scope = reader.nested(source.schema, source.scope);
  const matches = items.flatMap((item) => {
    const descriptor = reader.descriptor(item, scope);
    return descriptor !== undefined && conversionKey(descriptor) === key ? [{ descriptor, sources: [{ schema: item, scope }] }] : [];
  });
  const [match, again] = matches;
  return match !== undefined && again === undefined ? match : child;
}

function conflict(reason: string): Composition<never> {
  return { kind: 'rejected', code: COMPOSITION_CONVERSION_CONFLICT, message: conflictMessage(reason) };
}

/** The message of `OPENAPI_COMPOSITION_CONVERSION_CONFLICT`, from the resolver or from the codec emitter. */
export function conflictMessage(reason: string): string {
  return `The allOf members convert one value in two ways (${reason}). Give that value one schema in every member.`;
}

function unsatisfiable(names: readonly NeverName[]): Composition<never> {
  return {
    kind: 'rejected',
    code: COMPOSITION_UNSATISFIABLE,
    message: `No object satisfies this allOf: ${names.map((never) => `the required property ${JSON.stringify(never.name)} ${neverReason(never)}`).join(' ')}`,
  };
}

/** An allOf member that declares a JSON `type`, with its index in the allOf. */
interface TypedMember {
  readonly index: number;
  readonly types: readonly string[];
}

/**
 * JSON Schema AND over `type`: the declared types of the allOf members, `$ref` members read through their component. Returns
 * the typed members when no JSON value has a type that all of them admit; undefined otherwise. A member that declares no
 * `type` (properties only, `oneOf`, `const`) makes no claim here.
 */
function disjointMemberTypes<S>(schema: unknown, scope: S, reader: CompositionReader<S>): readonly TypedMember[] | undefined {
  if (!isJsonObject(schema) || !Array.isArray(schema.allOf)) return undefined;
  const nested = reader.nested(schema, scope);
  const typed = schema.allOf.flatMap((member, index): TypedMember[] => {
    const types = declaredTypes(member, nested, reader, new Set());
    return types.length ? [{ index, types }] : [];
  });
  let common: readonly string[] | undefined;
  for (const { types } of typed) {
    common = common === undefined ? types : commonTypes(common, types);
    if (common.length === 0) return typed;
  }
  return undefined;
}

/** The `type` list that a member declares itself, or through the `$ref` it names; empty when it declares none. */
function declaredTypes<S>(schema: unknown, scope: S, reader: CompositionReader<S>, visiting: Set<unknown>): readonly string[] {
  if (!isJsonObject(schema) || visiting.has(schema)) return [];
  const own = effectiveSchemaTypes(schema);
  if (own.length) return own;
  const reference = reader.reference(schema, scope);
  if (!reference) return [];
  visiting.add(schema);
  const types = declaredTypes(reference.referenced, reference.scope, reader, visiting);
  visiting.delete(schema);
  return types;
}

/** The JSON types that both lists admit: an integer is a number, so the two give `integer`. */
function commonTypes(left: readonly string[], right: readonly string[]): string[] {
  const shared = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (a === b) shared.add(a);
      else if ((a === 'integer' && b === 'number') || (a === 'number' && b === 'integer')) shared.add('integer');
    }
  }
  return [...shared];
}

function unsatisfiableTypes(members: readonly TypedMember[]): Composition<never> {
  const declared = members.map(({ index, types }) => `allOf member ${index} admits only ${types.join(' or ')}`).join(', ');
  return {
    kind: 'rejected',
    code: COMPOSITION_UNSATISFIABLE,
    message: `No value satisfies this allOf: its members declare types with no common value (${declared}). `
      + 'Give the members a type that they share, or remove the member that does not fit.',
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
    const part = objectPart(reference.referenced, reference.scope, reader, visiting);
    visiting.delete(schema);
    return part;
  }
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || isSequenceSchema(schema)) return undefined;
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
  const composed = composeObjects(parts, slotRule(reader));
  return isRejected(composed) ? undefined : { slots: composed.slots, required: composed.required, extra: composed.extra };
}

function leaf<S>(schema: unknown, scope: S, reader: CompositionReader<S>): SlotChild<S> {
  return { descriptor: describe(schema, scope, reader), sources: [{ schema, scope }] };
}

/** The own part as an object descriptor, so the component's descriptor holds its own names beside the allOf. */
function ownPartDescriptor<S>(part: ObjectPart<SlotChild<S>>, required: readonly string[], declaredOpen: boolean): ModelTypeDescriptor {
  const { extra } = part;
  return {
    kind: 'object',
    properties: Object.fromEntries(Object.entries(part.slots).map(([name, child]) => [name, child.descriptor])),
    required,
    additionalProperties: extra.mode === 'values' ? extra.child.descriptor : extra.mode === 'open',
    ...(extra.mode === 'open' && declaredOpen ? { additionalPropertiesDeclared: true as const } : {}),
  };
}

/** `unevaluatedProperties` of the node: the names that no part lists, when no part judges them by `additionalProperties`. */
function unevaluatedExtra<S>(schema: Readonly<Record<string, unknown>>, scope: S, reader: CompositionReader<S>): ObjectExtra<SlotChild<S>> {
  const unevaluated = schema.unevaluatedProperties;
  if (unevaluated === false) return { mode: 'closed' };
  if (isJsonObject(unevaluated)) return { mode: 'values', child: leaf(unevaluated, scope, reader) };
  return { mode: 'open' };
}

/** Whether the schema, or an allOf member or a `$ref` it reaches, sets `additionalProperties: true` itself. */
function declaresOpen<S>(schema: unknown, scope: S, reader: CompositionReader<S>, visiting: Set<unknown>): boolean {
  if (!isJsonObject(schema) || visiting.has(schema)) return false;
  if (schema.additionalProperties === true) return true;
  const reference = reader.reference(schema, scope);
  if (reference) {
    visiting.add(schema);
    const declared = declaresOpen(reference.referenced, reference.scope, reader, visiting);
    visiting.delete(schema);
    return declared;
  }
  const nested = reader.nested(schema, scope);
  return (Array.isArray(schema.allOf) ? schema.allOf : []).some((member) => declaresOpen(member, nested, reader, visiting));
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
    const verdicts = nullVerdicts(reference.referenced, reference.scope, reader, visiting);
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
function composedRequired(schema: unknown): string[] {
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
    .map(([name, property]) => [name, never.includes(name) ? NEVER : property]));
  return { ...descriptor, properties };
}

const NEVER: ModelTypeDescriptor = descriptorSlotRule().never;

function requiredNames(schema: unknown): string[] {
  return isJsonObject(schema) && Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * The variants of a schema's union keyword. A schema never holds both `oneOf` and `anyOf` here: generation rewrites such a schema
 * into an allOf of the two before any reader sees it (`normalizeSchemaUnions`).
 */
export function unionVariants(schema: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  return Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
}

/** An array or tuple schema: `type: array` (null beside it allowed), or `items` or `prefixItems` with no object keywords. */
export function isSequenceSchema(schema: Readonly<Record<string, unknown>>): boolean {
  const declared = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (declared.length === 0) {
    if (schema.properties || schema.additionalProperties !== undefined) return false;
    return Array.isArray(schema.prefixItems) || Boolean(schema.items);
  }
  return declared.includes('array') && declared.every((type) => type === 'array' || type === 'null');
}
