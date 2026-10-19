/**
 * The one merge of object parts (an allOf of objects, or a TypeScript intersection of object descriptors). Rules:
 *
 * 1. A name that several parts declare is one slot. Its children are its declarers, then the value schema of each part that
 *    does not list the name (strict JSON Schema: a part judges every name it does not list by its `additionalProperties`).
 * 2. A part with `additionalProperties: false` that does not list a name closes it: the slot has no valid value (`never`).
 * 3. The slot rule picks one child for the children of a name, as JSON Schema AND: equal children are one; null stays only
 *    when every child admits it; a union keeps the variants that the other children admit; objects compose by these rules;
 *    a model whose base chain holds another child's model narrows it (a covariant override; arrays of them alike); one
 *    conversion decides and the other children constrain the wire value that it converts: a scalar decider takes their
 *    constraints, and an object or array decider also takes each other child as a whole-value check; a scalar
 *    intersection reduces (`string` and `'cat'` give `'cat'`); disjoint JSON types give `never`; and children
 *    that convert differently are rejected.
 * 4. The required names are the union of the parts' lists. A name that only a list mentions is judged by the value schemas.
 * 5. The names that no part lists take every part's value schema; one closed part closes them.
 */

import type { ModelConstraint, ModelTypeDescriptor } from '../model.js';
import { descriptorNeedsConversion, type ObjectTypeDescriptor } from './union-conversion.js';

/** A composition that no value can satisfy, or whose parts convert one name differently. */
export interface Rejected {
  readonly rejected: string;
}

export type ObjectExtra<C> =
  | { readonly mode: 'open' }
  | { readonly mode: 'closed' }
  | { readonly mode: 'values'; readonly child: C };

export interface ObjectPart<C> {
  readonly slots: Readonly<Record<string, C>>;
  readonly required: readonly string[];
  readonly extra: ObjectExtra<C>;
}

export interface ObjectResult<C> {
  readonly slots: Readonly<Record<string, C>>;
  readonly required: readonly string[];
  readonly extra: ObjectExtra<C>;
  /** The names that a closed part rejects (rule 2); other `never` slots have children with no common value. */
  readonly closed: readonly string[];
}

export interface SlotRule<C> {
  /** One child for the children that judge one name, declarers first. */
  combine(children: readonly C[]): C | Rejected;
  /** The child of a name that no value can hold. */
  readonly never: C;
}

export function isRejected(value: unknown): value is Rejected {
  return typeof value === 'object' && value !== null && 'rejected' in value && typeof value.rejected === 'string';
}

export function composeObjects<C>(parts: readonly ObjectPart<C>[], slot: SlotRule<C>): ObjectResult<C> | Rejected {
  const required = [...new Set(parts.flatMap((part) => part.required))];
  const declared = [...new Set(parts.flatMap((part) => Object.keys(part.slots)))];
  const names = [...declared, ...required.filter((name) => !declared.includes(name))];
  const slots: Record<string, C> = Object.create(null);
  const closed: string[] = [];
  for (const name of names) {
    const declarers = parts.flatMap((part) => {
      const own = part.slots[name];
      return Object.hasOwn(part.slots, name) && own !== undefined ? [own] : [];
    });
    const judges = parts.filter((part) => !Object.hasOwn(part.slots, name));
    if (judges.some((part) => part.extra.mode === 'closed')) {
      slots[name] = slot.never;
      closed.push(name);
      continue;
    }
    const children = [...declarers, ...judges.flatMap((part) => part.extra.mode === 'values' ? [part.extra.child] : [])];
    const [first, second] = children;
    if (first === undefined) continue;
    const child = second === undefined ? first : slot.combine(children);
    if (isRejected(child)) return { rejected: `property ${JSON.stringify(name)}: ${child.rejected}` };
    slots[name] = child;
  }
  const values = parts.flatMap((part) => part.extra.mode === 'values' ? [part.extra.child] : []);
  const [value, nextValue] = values;
  let extra: ObjectExtra<C> = { mode: 'open' };
  if (parts.some((part) => part.extra.mode === 'closed')) extra = { mode: 'closed' };
  else if (value !== undefined) {
    const child = nextValue === undefined ? value : slot.combine(values);
    if (isRejected(child)) return { rejected: `additional properties: ${child.rejected}` };
    extra = { mode: 'values', child };
  }
  return { slots, required, extra, closed };
}

const NEVER: ModelTypeDescriptor = { kind: 'never' };

/**
 * The base of each model, so a derived model narrows its base in one slot (a covariant override). A model is named by the
 * `id` of a generated-model descriptor or the `name` of a reference descriptor, as the caller's descriptors name it.
 */
export interface ModelBases {
  baseOf(id: string): string | undefined;
}

const NO_BASES: ModelBases = { baseOf: () => undefined };

/**
 * The slot rule of descriptors: the codec, the model path and the OpenAPI resolver pick a property's descriptor with it.
 * `models` names the base of each generated model; without it, two different models in one slot convert differently.
 */
export function descriptorSlotRule(models: ModelBases = NO_BASES): SlotRule<ModelTypeDescriptor> {
  return { never: NEVER, combine: (children) => combineDescriptors(children, models) };
}

function combineDescriptors(children: readonly ModelTypeDescriptor[], models: ModelBases): ModelTypeDescriptor | Rejected {
  const distinct = distinctDescriptors(children.filter((child) => !isAnyValue(child)));
  const [first, second] = distinct;
  if (first === undefined) return children[0] ?? { kind: 'unknown' };
  if (second === undefined) return first;
  if (distinct.some((child) => child.kind === 'never')) return NEVER;
  if (distinct.some(isNullableUnion)) return combineNullable(distinct, models);
  const narrowed = narrowUnions(distinct) ?? mostDerivedModels(distinct, models);
  if (narrowed) return combineDescriptors(narrowed, models);
  if (distinct.every((child) => child.kind === 'object')) return composeObjectDescriptors(distinct, models) ?? NEVER;
  const converting = distinct.filter(descriptorNeedsConversion);
  const [decider] = converting;
  if (decider) {
    const conversion = conversionKey(decider);
    if (converting.some((child) => conversionKey(child) !== conversion)) return { rejected: 'two parts convert it differently' };
    const others = distinct.filter((child) => !converting.includes(child));
    const wire = scalarWireKind(decider);
    if (wire !== undefined) {
      if (others.some((child) => child.kind !== 'unknown' && scalarWireKind(child) !== wire)) return NEVER;
      // The other children constrain the wire value that the decider converts: their constraints join it.
      return withConstraints(decider, [...converting, ...others].flatMap((child) => child.constraints ?? []));
    }
    const json = jsonType(decider);
    if (others.some((child) => {
      const type = jsonType(child);
      return json !== undefined && type !== undefined && type !== json;
    })) return NEVER;
    // An object or array decider converts the value; each other child still checks its wire value as a whole.
    return withConstraints(decider, [
      ...[...converting, ...others.filter((child) => child.kind === 'unknown')].flatMap((child) => child.constraints ?? []),
      ...others.filter((child) => child.kind !== 'unknown').map(wholeValueCheck),
    ]);
  }
  const kinds = distinct.map(scalarWireKind);
  if (kinds.every((kind) => kind !== undefined)) {
    if (new Set(kinds).size > 1) return NEVER;
    const literals = distinct.filter((child) => child.kind === 'literal');
    if (new Set(literals.map((literal) => literal.value)).size > 1) return NEVER;
    const [base] = literals.length ? literals : distinct;
    const constraints = distinct.flatMap((child) => child.constraints ?? []);
    return base ? withConstraints(base, constraints) : NEVER;
  }
  return { kind: 'intersection', variants: distinct };
}

/** Null stays when every child admits it; the other variants combine without it. */
function combineNullable(children: readonly ModelTypeDescriptor[], models: ModelBases): ModelTypeDescriptor | Rejected {
  const nullable = children.every(admitsNull);
  if (!nullable && children.some((child) => child.kind === 'null')) return NEVER;
  const values = children.flatMap((child) => child.kind === 'null' ? [] : [withoutNull(child)]);
  const [first, second] = values;
  const value = first === undefined ? NULL : second === undefined ? first : combineDescriptors(values, models);
  if (isRejected(value) || !nullable || value.kind === 'null') return value;
  return value.kind === 'never' ? NULL : { kind: 'union', variants: [value, NULL] };
}

/**
 * A union keeps the variants that every other child admits (`oneOf [M, string]` and `M` give `M`); undefined when no union
 * loses a variant. Narrowing only removes variants: a union with no admitted variant stays whole for the rules after it.
 */
function narrowUnions(children: readonly ModelTypeDescriptor[]): ModelTypeDescriptor[] | undefined {
  const others = children.filter((child) => !isPlainUnion(child));
  if (others.length === 0) return undefined;
  let narrowed = false;
  const result = children.map((child) => {
    if (!isPlainUnion(child)) return child;
    const kept = child.variants.filter((variant) => others.every((other) => admits(other, variant)));
    if (kept.length === child.variants.length || kept.length === 0) return child;
    narrowed = true;
    const [only] = kept;
    return kept.length === 1 && only ? only : { ...child, variants: kept };
  });
  return narrowed ? result : undefined;
}

/** Whether `child` admits some values of `variant`: the same conversion, the same scalar wire type, or both objects. */
function admits(child: ModelTypeDescriptor, variant: ModelTypeDescriptor): boolean {
  if (child.kind === 'unknown' || conversionKey(child) === conversionKey(variant)) return true;
  if (isObjectLike(child) && isObjectLike(variant)) return true;
  const wire = scalarWireKind(variant);
  return wire !== undefined && scalarWireKind(child) === wire;
}

/**
 * A covariant override: a child whose model's base chain holds another child's model narrows it, so the most derived model
 * decides (`Pet` and `Cat`, where `Cat` extends `Pet`, give `Cat`); arrays of such models alike. The narrowed child's
 * constraints join the child that narrows it. Undefined when no child narrows another.
 */
function mostDerivedModels(children: readonly ModelTypeDescriptor[], models: ModelBases): ModelTypeDescriptor[] | undefined {
  const bases = children.filter((child) => children.some((other) => narrowsModel(other, child, models)));
  if (bases.length === 0) return undefined;
  return children.flatMap((child) => bases.includes(child) ? [] : [withConstraints(child, [
    ...(child.constraints ?? []),
    ...bases.filter((base) => narrowsModel(child, base, models)).flatMap((base) => base.constraints ?? []),
  ])]);
}

function narrowsModel(derived: ModelTypeDescriptor, base: ModelTypeDescriptor, models: ModelBases): boolean {
  if (derived.kind === 'array' && base.kind === 'array') return narrowsModel(derived.item, base.item, models);
  const derivedId = modelName(derived);
  const baseId = modelName(base);
  if (derivedId === undefined || baseId === undefined) return false;
  const seen = new Set<string>();
  for (let id = models.baseOf(derivedId); id !== undefined && !seen.has(id); id = models.baseOf(id)) {
    if (id === baseId) return true;
    seen.add(id);
  }
  return false;
}

/** The name of a model descriptor: a generated model's id or a reference's name. */
export function modelName(descriptor: ModelTypeDescriptor): string | undefined {
  return descriptor.kind === 'generated-model' ? descriptor.id : descriptor.kind === 'reference' ? descriptor.name : undefined;
}

const NULL: ModelTypeDescriptor = { kind: 'null' };

/** An object on the wire: an object descriptor or a generated model. */
function isObjectLike(descriptor: ModelTypeDescriptor): boolean {
  return descriptor.kind === 'object' || descriptor.kind === 'generated-model';
}

function isPlainUnion(descriptor: ModelTypeDescriptor): descriptor is Extract<ModelTypeDescriptor, { readonly kind: 'union' }> {
  return descriptor.kind === 'union' && descriptor.discriminator === undefined;
}

function isNullableUnion(descriptor: ModelTypeDescriptor): boolean {
  return isPlainUnion(descriptor) && descriptor.variants.some((variant) => variant.kind === 'null');
}

function admitsNull(descriptor: ModelTypeDescriptor): boolean {
  return descriptor.kind === 'null' || descriptor.kind === 'unknown' || isNullableUnion(descriptor);
}

function withoutNull(descriptor: ModelTypeDescriptor): ModelTypeDescriptor {
  if (!isPlainUnion(descriptor) || !isNullableUnion(descriptor)) return descriptor;
  const variants = descriptor.variants.filter((variant) => variant.kind !== 'null');
  const [only] = variants;
  return variants.length === 1 && only ? only : { ...descriptor, variants };
}

/** A descriptor's conversion: the descriptor without its own constraints and validations, which only check values. */
export function conversionKey(descriptor: ModelTypeDescriptor): string {
  const { constraints: _constraints, validations: _validations, ...conversion } = descriptor;
  return JSON.stringify(conversion);
}

/** The one object that an intersection of object descriptors converts as; undefined when a variant is not an object. */
function composeObjectDescriptors(
  variants: readonly ModelTypeDescriptor[],
  models: ModelBases = NO_BASES,
): ObjectTypeDescriptor | Rejected | undefined {
  const objects = variants.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
  if (objects.length === 0 || objects.length !== variants.length) return undefined;
  const composed = composeObjects(objects.map(descriptorPart), descriptorSlotRule(models));
  if (isRejected(composed)) return composed;
  return {
    kind: 'object',
    properties: composed.slots,
    required: composed.required,
    additionalProperties: composed.extra.mode === 'values' ? composed.extra.child : composed.extra.mode === 'open',
  };
}

/** An intersection whose parts convert one name differently: generation stops, and a generator may add its own code. */
export class CompositionConflictError extends Error {
  constructor(readonly reason: string) {
    super(`Intersection cannot be converted: ${reason}. Use one serde pair for the intersected value.`);
  }
}

/** `composeObjectDescriptors` for an emitter: a rejected composition stops generation. */
export function requireComposedObject(
  variants: readonly ModelTypeDescriptor[],
  models: ModelBases = NO_BASES,
): ObjectTypeDescriptor | undefined {
  const composed = composeObjectDescriptors(variants, models);
  if (isRejected(composed)) throw new CompositionConflictError(composed.rejected);
  return composed;
}

function descriptorPart(object: ObjectTypeDescriptor): ObjectPart<ModelTypeDescriptor> {
  const additional = object.additionalProperties;
  return {
    slots: object.properties,
    required: object.required,
    extra: typeof additional === 'object' ? { mode: 'values', child: additional } : additional ? { mode: 'open' } : { mode: 'closed' },
  };
}

/** `unknown` with no tag, constraint or serde: any value, so it constrains nothing. */
function isAnyValue(descriptor: ModelTypeDescriptor): boolean {
  return descriptor.kind === 'unknown' && descriptor.constraints === undefined && descriptor.validations === undefined
    && descriptor.serde === undefined;
}

function distinctDescriptors(children: readonly ModelTypeDescriptor[]): ModelTypeDescriptor[] {
  const seen = new Map<string, ModelTypeDescriptor>();
  for (const child of children) {
    const key = JSON.stringify(child);
    if (!seen.has(key)) seen.set(key, child);
  }
  return [...seen.values()];
}

/** The JSON type of a scalar descriptor's wire value; undefined for other descriptors. */
function scalarWireKind(descriptor: ModelTypeDescriptor): string | undefined {
  // OpenAPI temporal values carry their wire form under another key; they are strings on the wire.
  if (descriptor.serde) return descriptor.serde.wire === undefined ? 'string' : scalarWireKind(descriptor.serde.wire);
  switch (descriptor.kind) {
    case 'string':
    case 'date':
      return 'string';
    case 'number':
    case 'boolean':
    case 'null':
      return descriptor.kind;
    case 'literal':
      return typeof descriptor.value;
    default:
      return undefined;
  }
}

/** The JSON type of a descriptor's wire value; undefined when it is not one type (unknown, a union, an intersection). */
function jsonType(descriptor: ModelTypeDescriptor): string | undefined {
  const scalar = scalarWireKind(descriptor);
  if (scalar !== undefined || descriptor.serde) return scalar;
  switch (descriptor.kind) {
    case 'object':
    case 'generated-model':
    case 'reference':
      return 'object';
    case 'array':
    case 'tuple':
      return 'array';
    default:
      return undefined;
  }
}

/** A child as one constraint that its whole schema must hold. */
function wholeValueCheck(child: ModelTypeDescriptor): ModelConstraint {
  return { kind: 'allOf', schemas: [child] };
}

function withConstraints(descriptor: ModelTypeDescriptor, constraints: readonly ModelConstraint[]): ModelTypeDescriptor {
  const unique = distinctConstraints(constraints);
  return unique.length ? { ...descriptor, constraints: unique } : descriptor;
}

function distinctConstraints(constraints: readonly ModelConstraint[]): ModelConstraint[] {
  const seen = new Map<string, ModelConstraint>();
  for (const constraint of constraints) seen.set(JSON.stringify(constraint), constraint);
  return [...seen.values()];
}
