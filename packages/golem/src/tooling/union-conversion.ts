/**
 * Shared union conversion policy for model companions and IObject codecs.
 * Ambiguous unions fail generation; conversion must not probe alternatives.
 */

import type { DiscriminatorValue, ModelTypeDescriptor } from '../model.js';

export type ObjectTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'object' }>;
export type ArrayTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'array' }>;
export type UnionTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'union' }>;

export const OBJECT_UNION_DISCRIMINATOR_ERROR =
  'Object union conversions require a unique, required literal discriminator.';
export const AMBIGUOUS_UNION_CONVERSION_ERROR =
  'Union has ambiguous conversions. Use a discriminated object union or one serde pair for the value.';

export function objectValueExpression(expression: string): string {
  return `typeof ${expression} === 'object' && ${expression} !== null && !Array.isArray(${expression})`;
}

export function presentUnionVariants(
  descriptor: UnionTypeDescriptor,
): readonly ModelTypeDescriptor[] {
  return descriptor.variants.filter((variant) => variant.kind !== 'null' && variant.kind !== 'undefined');
}

export function isScalarishDescriptor(descriptor: ModelTypeDescriptor): boolean {
  if (['null', 'undefined', 'string', 'number', 'boolean', 'bigint', 'literal'].includes(descriptor.kind)) {
    return true;
  }
  return descriptor.kind === 'union' && descriptor.variants.every(isScalarishDescriptor);
}

/** Values of a literal or a union of literals; otherwise undefined. */
export function literalValues(descriptor: ModelTypeDescriptor | undefined): readonly DiscriminatorValue[] | undefined {
  if (descriptor?.kind === 'literal') return [descriptor.value];
  if (descriptor?.kind !== 'union' || descriptor.variants.length === 0) return undefined;
  const values: DiscriminatorValue[] = [];
  for (const variant of descriptor.variants) {
    if (variant.kind !== 'literal') return undefined;
    values.push(variant.value);
  }
  return values;
}

/** Required properties whose type is a literal or a union of literals. */
export function literalDiscriminator(
  descriptor: ObjectTypeDescriptor,
): ReadonlyMap<string, readonly DiscriminatorValue[]> {
  const values = new Map<string, readonly DiscriminatorValue[]>();
  for (const name of descriptor.required) {
    const literals = literalValues(descriptor.properties[name]);
    if (literals) values.set(name, literals);
  }
  return values;
}

/** One tag property, and each alternative's tag values in alternative order. */
export interface VariantDispatch {
  readonly property: string;
  readonly values: readonly (readonly DiscriminatorValue[])[];
}

function disjoint(sets: readonly (readonly DiscriminatorValue[])[]): boolean {
  const seen = new Set<DiscriminatorValue>();
  for (const values of sets) {
    if (values.length === 0) return false;
    for (const value of values) {
      if (seen.has(value)) return false;
      seen.add(value);
    }
  }
  return true;
}

/** A required literal tag whose values are disjoint across the alternatives. */
export function objectDiscriminator(alternatives: readonly ObjectTypeDescriptor[]): VariantDispatch | undefined {
  if (alternatives.length === 0) return undefined;
  const tags = alternatives.map(literalDiscriminator);
  for (const property of tags[0].keys()) {
    const values = tags.map((tag) => tag.get(property) ?? []);
    if (disjoint(values)) return { property, values };
  }
  return undefined;
}

/** Indices of the union variants that hold a value (not null or undefined). */
export function presentUnionIndices(descriptor: UnionTypeDescriptor): number[] {
  return descriptor.variants.flatMap((variant, index) =>
    variant.kind === 'null' || variant.kind === 'undefined' ? [] : [index]);
}

/**
 * Dispatch among the union variants at `indices`. An explicit discriminator
 * table is authoritative and must tag each of them; otherwise tags are
 * inferred from each variant's object shape, which `objectFor` resolves.
 */
export function unionDispatch(
  union: UnionTypeDescriptor,
  indices: readonly number[],
  objectFor: (variant: ModelTypeDescriptor) => ObjectTypeDescriptor | undefined,
): VariantDispatch | undefined {
  const table = union.discriminator;
  if (table) {
    if (table.variants.length !== union.variants.length) {
      throw new Error(`The ${table.propertyName} discriminator table must list tag values for every union variant.`);
    }
    const values = indices.map((index) => table.variants[index]?.values ?? []);
    if (indices.length === 0 || !disjoint(values)) {
      throw new Error(`The ${table.propertyName} discriminator table must give each variant distinct, non-empty tag values.`);
    }
    return { property: table.propertyName, values };
  }
  const objects: ObjectTypeDescriptor[] = [];
  for (const index of indices) {
    const object = objectFor(union.variants[index]);
    if (!object) return undefined;
    objects.push(object);
  }
  return objectDiscriminator(objects);
}

export function objectVariant(variant: ModelTypeDescriptor): ObjectTypeDescriptor | undefined {
  return variant.kind === 'object' ? variant : undefined;
}

/** `access` equals one of `values`. */
export function discriminatorMatch(access: string, values: readonly DiscriminatorValue[]): string {
  return `(${values.map((value) => `${access} === ${JSON.stringify(value)}`).join(' || ')})`;
}

/** One dispatched variant: its tag values, optional model class and conversion. */
export interface DispatchBranch {
  readonly values: readonly DiscriminatorValue[];
  /** Instances of this class select the branch before any tag test. */
  readonly className?: string;
  readonly convert: string;
  /** JSON output only: whether `convert` writes the tag property; undefined when unknown. */
  readonly writesTag?: boolean;
}

export interface DispatchOptions {
  readonly expression: string;
  readonly property: string;
  readonly branches: readonly DispatchBranch[];
  /** decode: wire to model. encode-value: model to wire object. encode-json: model to JSON text. */
  readonly direction: 'decode' | 'encode-value' | 'encode-json';
  /** Encode result for null or undefined. */
  readonly nullish?: string;
  /**
   * An explicit tag table lets an instance omit its tag: encoding writes the
   * variant's first value. Inferred tags are declared literals and required.
   */
  readonly canonicalTag: boolean;
  /**
   * decode of branches without a class: a local the first tag test assigns, so the tag is read once
   * and the later tests and the rejection use it. The caller declares it.
   */
  readonly tagLocal?: string;
}

/**
 * The one tagged-union dispatch shared by the emitters.
 *
 * - An instance of a branch class selects that branch first; a subclass wins
 *   over its base regardless of variant order. Its own tag must be one of the
 *   branch's values; encoding writes that tag, or with `canonicalTag` the
 *   branch's first value when the instance has none.
 * - Any other object selects the branch whose values contain its tag.
 * - An object whose tag selects no branch is rejected. Encoding writes null
 *   or undefined unchanged and rejects every other value.
 */
export function emitDispatch(options: DispatchOptions): string {
  const { expression, property, branches, direction, tagLocal } = options;
  const encode = direction !== 'decode';
  const tagRead = `(${expression} as unknown as Record<string, unknown>)[${JSON.stringify(property)}]`;
  const tag = tagLocal ?? tagRead;
  const reject = `unknownDiscriminatorValue(${JSON.stringify(property)}, ${tag}, ${encode ? "'serialize'" : "'deserialize'"})`;
  const key = JSON.stringify(property);
  const injectJson = (convert: string, tagValue: string): string =>
    `jsonWithDiscriminator(${convert}, ${JSON.stringify(key)}, ${tagValue})`;
  // Encoding always writes the selected tag, so the wire value decodes to the same variant.
  const encodeBranch = (branch: DispatchBranch, tagValue: string, tagMayBeMissing: boolean): string => {
    if (!encode) return branch.convert;
    if (direction === 'encode-value') return `withDiscriminatorValue(${branch.convert}, ${key}, ${tagValue})`;
    if (branch.writesTag === false) return injectJson(branch.convert, tagValue);
    return tagMayBeMissing ? `(${tag} === undefined ? ${injectJson(branch.convert, tagValue)} : ${branch.convert})` : branch.convert;
  };
  let converted = encode
    ? `(${expression} == null ? ${options.nullish ?? expression} : ${reject})`
    : `(${objectValueExpression(expression)} ? ${reject} : ${expression})`;
  for (let index = branches.length - 1; index >= 0; index--) {
    const branch = branches[index];
    // The first test that runs reads the tag; every path through the chain starts there.
    const guard = tagLocal && index === 0
      ? `${objectValueExpression(expression)} && (${tagLocal} = ${tagRead}, ${discriminatorMatch(tagLocal, branch.values)})`
      : `${objectValueExpression(expression)} && ${discriminatorMatch(tag, branch.values)}`;
    converted = `${guard} ? (${encodeBranch(branch, tag, false)}) : (${converted})`;
  }
  const classes = branches.flatMap((branch) => branch.className ? [branch.className] : []);
  for (let index = branches.length - 1; index >= 0; index--) {
    const branch = branches[index];
    if (!branch.className) continue;
    const self = branch.className;
    const subclasses = classes.filter((other) => other !== self)
      .map((other) => ` && !((${expression} as object) instanceof ${other} && ${other}.prototype instanceof ${self})`);
    const guard = `(${expression} as object) instanceof ${self}${subclasses.join('')}`;
    const ownTag = options.canonicalTag ? `(${tag} === undefined ? ${JSON.stringify(branch.values[0])} : ${tag})` : tag;
    const accepted = options.canonicalTag
      ? `${tag} === undefined || ${discriminatorMatch(tag, branch.values)}`
      : discriminatorMatch(tag, branch.values);
    const body = `${accepted} ? (${encodeBranch(branch, ownTag, options.canonicalTag)}) : ${reject}`;
    converted = `${guard} ? (${body}) : (${converted})`;
  }
  return `(${converted})`;
}

/** The variants of a `scalar | scalar[]` union: its one array, and the scalar variants beside it. */
export interface ScalarOrArray {
  readonly array: ArrayTypeDescriptor;
  readonly scalars: readonly ModelTypeDescriptor[];
}

/**
 * A union of one array and scalar variants (a JSON scalar or a literal union),
 * the query-style shape. Date, generated models, and untagged objects are not scalarish.
 */
export function scalarOrArray(
  present: readonly ModelTypeDescriptor[],
): ScalarOrArray | undefined {
  const arrays = present.filter((variant): variant is ArrayTypeDescriptor => variant.kind === 'array');
  if (arrays.length !== 1) return undefined;
  const scalars = present.filter((variant) => variant !== arrays[0]);
  if (!scalars.every(isScalarishDescriptor)) return undefined;
  return { array: arrays[0], scalars };
}

/**
 * The scalar variant whose own converter the scalar branch uses, or undefined
 * when no scalar variant needs a conversion. A scalar variant that needs a
 * conversion must be the only scalar variant, as in a plain union: the wire
 * value cannot tell it from its siblings, so the union is rejected.
 */
export function scalarBranchVariant(scalars: readonly ModelTypeDescriptor[]): ModelTypeDescriptor | undefined {
  const converting = scalars.filter(descriptorNeedsConversion);
  if (converting.length === 0) return undefined;
  if (scalars.length > 1) throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
  return converting[0];
}

export function emitScalarOrArrayConversion(
  expression: string,
  mappedArray: string,
  scalar: string,
): string {
  if (mappedArray === expression && scalar === expression) return expression;
  return `Array.isArray(${expression}) ? (${mappedArray}) : (${scalar})`;
}

export function descriptorNeedsConversion(descriptor: ModelTypeDescriptor): boolean {
  const tags = descriptor as ModelTypeDescriptor & {
    readonly serde?: { readonly id: string };
    readonly date?: true;
  };
  if (tags.serde || tags.date || descriptor.kind === 'date' || descriptor.kind === 'generated-model') {
    return true;
  }
  if (descriptor.kind === 'reference') return descriptor.construct === true;
  if (descriptor.kind === 'array') return descriptorNeedsConversion(descriptor.item);
  if (descriptor.kind === 'tuple') {
    return descriptor.items.some(descriptorNeedsConversion)
      || (descriptor.rest !== undefined && descriptorNeedsConversion(descriptor.rest.item));
  }
  if (descriptor.kind === 'object') {
    return Object.values(descriptor.properties).some(descriptorNeedsConversion)
      || (typeof descriptor.additionalProperties === 'object'
        && descriptorNeedsConversion(descriptor.additionalProperties));
  }
  if (descriptor.kind === 'union' || descriptor.kind === 'intersection') {
    return descriptor.variants.some(descriptorNeedsConversion);
  }
  return false;
}
