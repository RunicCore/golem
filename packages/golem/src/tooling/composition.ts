/**
 * The one merge of object parts (an allOf of objects, or a TypeScript intersection of object descriptors). Rules:
 *
 * 1. A name that several parts declare is one slot. Its children are its declarers, then the value schema of each part that
 *    does not list the name (strict JSON Schema: a part judges every name it does not list by its `additionalProperties`).
 * 2. A part with `additionalProperties: false` that does not list a name closes it: the slot has no valid value (`never`).
 * 3. The slot rule picks one child for the children of a name, as JSON Schema AND: equal children are one; null stays only
 *    when every child admits it; a union keeps the variants that the other children admit; objects compose by these rules;
 *    one conversion decides and the other children's constraints join it (they constrain the wire value); a scalar
 *    intersection reduces (`string` and `'cat'` give `'cat'`); disjoint types give `never`; and children that convert
 *    differently are rejected.
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
  return typeof value === 'object' && value !== null && typeof (value as { readonly rejected?: unknown }).rejected === 'string';
}

export function composeObjects<C>(parts: readonly ObjectPart<C>[], slot: SlotRule<C>): ObjectResult<C> | Rejected {
  const required = [...new Set(parts.flatMap((part) => part.required))];
  const declared = [...new Set(parts.flatMap((part) => Object.keys(part.slots)))];
  const names = [...declared, ...required.filter((name) => !declared.includes(name))];
  const slots: Record<string, C> = Object.create(null);
  const closed: string[] = [];
  for (const name of names) {
    const declarers = parts.flatMap((part) => Object.hasOwn(part.slots, name) ? [part.slots[name] as C] : []);
    const judges = parts.filter((part) => !Object.hasOwn(part.slots, name));
    if (judges.some((part) => part.extra.mode === 'closed')) {
      slots[name] = slot.never;
      closed.push(name);
      continue;
    }
    const children = [...declarers, ...judges.flatMap((part) => part.extra.mode === 'values' ? [part.extra.child] : [])];
    if (children.length === 0) continue;
    const child = children.length === 1 ? children[0] as C : slot.combine(children);
    if (isRejected(child)) return { rejected: `property ${JSON.stringify(name)}: ${child.rejected}` };
    slots[name] = child;
  }
  const values = parts.flatMap((part) => part.extra.mode === 'values' ? [part.extra.child] : []);
  let extra: ObjectExtra<C> = { mode: 'open' };
  if (parts.some((part) => part.extra.mode === 'closed')) extra = { mode: 'closed' };
  else if (values.length) {
    const child = values.length === 1 ? values[0] as C : slot.combine(values);
    if (isRejected(child)) return { rejected: `additional properties: ${child.rejected}` };
    extra = { mode: 'values', child };
  }
  return { slots, required, extra, closed };
}

const NEVER: ModelTypeDescriptor = { kind: 'never' };

/** The slot rule of descriptors: the codec, the model path and the OpenAPI resolver pick a property's descriptor with it. */
export const descriptorSlotRule: SlotRule<ModelTypeDescriptor> = {
  never: NEVER,
  combine: combineDescriptors,
};

function combineDescriptors(children: readonly ModelTypeDescriptor[]): ModelTypeDescriptor | Rejected {
  const distinct = distinctDescriptors(children.filter((child) => !isAnyValue(child)));
  if (distinct.length === 0) return children[0] ?? { kind: 'unknown' };
  if (distinct.length === 1) return distinct[0] as ModelTypeDescriptor;
  if (distinct.some((child) => child.kind === 'never')) return NEVER;
  if (distinct.some(isNullableUnion)) return combineNullable(distinct);
  const narrowed = narrowUnions(distinct);
  if (narrowed) return combineDescriptors(narrowed);
  if (distinct.every((child) => child.kind === 'object')) return composeObjectDescriptors(distinct) ?? NEVER;
  const converting = distinct.filter(descriptorNeedsConversion);
  const [decider] = converting;
  if (decider) {
    const conversion = conversionKey(decider);
    if (converting.some((child) => conversionKey(child) !== conversion)) return { rejected: 'two parts convert it differently' };
    const others = distinct.filter((child) => !converting.includes(child));
    const wire = scalarWireKind(decider);
    if (wire !== undefined && others.some((child) => child.kind !== 'unknown' && scalarWireKind(child) !== wire)) return NEVER;
    // The other children constrain the wire value that the decider converts: their constraints join it.
    const constraining = wire === undefined ? others.filter((child) => child.kind === 'unknown') : others;
    return withConstraints(decider, [...converting, ...constraining].flatMap((child) => child.constraints ?? []));
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
function combineNullable(children: readonly ModelTypeDescriptor[]): ModelTypeDescriptor | Rejected {
  const nullable = children.every(admitsNull);
  if (!nullable && children.some((child) => child.kind === 'null')) return NEVER;
  const values = children.flatMap((child) => child.kind === 'null' ? [] : [withoutNull(child)]);
  const value = values.length === 0 ? NULL : values.length === 1 ? values[0] as ModelTypeDescriptor : combineDescriptors(values);
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
function conversionKey(descriptor: ModelTypeDescriptor): string {
  const { constraints: _constraints, validations: _validations, ...conversion } = descriptor;
  return JSON.stringify(conversion);
}

/** The one object that an intersection of object descriptors converts as; undefined when a variant is not an object. */
export function composeObjectDescriptors(variants: readonly ModelTypeDescriptor[]): ObjectTypeDescriptor | Rejected | undefined {
  const objects = variants.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
  if (objects.length === 0 || objects.length !== variants.length) return undefined;
  const composed = composeObjects(objects.map(descriptorPart), descriptorSlotRule);
  if (isRejected(composed)) return composed;
  return {
    kind: 'object',
    properties: composed.slots,
    required: composed.required,
    additionalProperties: composed.extra.mode === 'values' ? composed.extra.child : composed.extra.mode === 'open',
  };
}

/** `composeObjectDescriptors` for an emitter: a rejected composition stops generation. */
export function requireComposedObject(variants: readonly ModelTypeDescriptor[]): ObjectTypeDescriptor | undefined {
  const composed = composeObjectDescriptors(variants);
  if (isRejected(composed)) throw new Error(`Intersection cannot be converted: ${composed.rejected}. Use one serde pair for the intersected value.`);
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

function withConstraints(descriptor: ModelTypeDescriptor, constraints: readonly ModelConstraint[]): ModelTypeDescriptor {
  const unique = distinctConstraints(constraints);
  return unique.length ? { ...descriptor, constraints: unique } : descriptor;
}

function distinctConstraints(constraints: readonly ModelConstraint[]): ModelConstraint[] {
  const seen = new Map<string, ModelConstraint>();
  for (const constraint of constraints) seen.set(JSON.stringify(constraint), constraint);
  return [...seen.values()];
}
