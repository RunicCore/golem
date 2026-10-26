/**
 * Shared union conversion policy for model companions and IObject codecs.
 * Ambiguous unions fail generation; conversion must not probe alternatives.
 */

import type { DiscriminatorValue, ModelTypeDescriptor } from '../model.js';
import { MODEL_FIELDS_KEY } from '../schema-keywords.js';
import { code, identifier, join, literal, sameCode, type Code } from './code.js';
import { rt } from './rt.js';
import {
  emitArrayItems,
  emitTupleItems,
  type SequenceItems,
  type TupleConversionDescriptor,
} from './sequence-conversion.js';

export type ObjectTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'object' }>;
type ArrayTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'array' }>;
export type UnionTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'union' }>;

/** An object union that needs conversion has no unique, required literal tag: generation stops, and a generator adds its code, location and fix. */
export class ObjectUnionDiscriminatorError extends Error {
  constructor(variants: readonly ModelTypeDescriptor[]) {
    super(`Object union conversions require a unique, required literal discriminator. The variants are ${variants.map(describeVariant).join(' | ')}.`);
  }
}

function describeVariant(variant: ModelTypeDescriptor): string {
  if (variant.kind === 'object') return `{ ${Object.keys(variant.properties).join(', ')} }`;
  if (variant.kind === 'reference') return variant.name;
  return variant.kind === 'generated-model' ? variant.id : variant.kind;
}

/** A union with no object tag needs a conversion that the wire value cannot select: generation stops, and a generator adds its code, location and fix. */
export class AmbiguousUnionConversionError extends Error {
  constructor(variants: readonly ModelTypeDescriptor[]) {
    super(`Union has ambiguous conversions. Use a discriminated object union or one serde pair for the value. The variants are ${variants.map(describeVariant).join(' | ')}.`);
  }
}

/**
 * The test of the JSON view, as code: `key` is an own enumerable property of `object`. Every generated read of a field
 * (`presentValueCode`, the `isPresent` helper of the validators) builds on this one fragment.
 */
export function ownEnumerableCode(object: Code, key: Code): Code {
  return code`Object.prototype.propertyIsEnumerable.call(${object}, ${key})`;
}

/**
 * The JSON view of a field as code, the rule of `presentValue` (presence.ts): `object` and `key` are expressions, and `read`
 * reads the field from `object`. `presentValue` is the same rule as runtime code: it runs in the library, not in a generated
 * file, so it cannot be built from a Code fragment.
 */
export function presentValueCode(object: Code, key: Code, read: Code): Code {
  return code`${ownEnumerableCode(object, key)} ? ${read} : undefined`;
}

/**
 * One `Object.keys` pass that gives each `[key, local]` pair its value in a `let` local, or `undefined` when the key is
 * absent, so each field is read once (the presence rows of scripts/benchmark/validator-toggles.ts). `declare` writes the
 * declaration of a local, for example with a type annotation. `otherwise` is the statement for a key that is not in
 * `captures`; it reads that key as `__golemKey`, so the same pass sees the other keys.
 */
export function presentKeysCode(
  object: Code,
  captures: readonly (readonly [key: string, local: Code])[],
  options: { readonly declare?: (local: Code) => Code; readonly otherwise?: Code } = {},
): Code {
  const { declare = (local: Code) => local, otherwise } = options;
  const cases = join(captures.map(([key, local]) => code`case ${literal(key)}: ${local} = ${object}[${literal(key)}]; break;`), code` `);
  const other = otherwise === undefined ? code`` : code` default: ${otherwise}`;
  return code`let ${join(captures.map(([, local]) => declare(local)), code`, `)}; for (const __golemKey of Object.keys(${object})) switch (__golemKey) { ${cases}${other} }`;
}

/**
 * The names that the own model of a golem model instance declares, or `undefined` when the value holds no program state: the
 * declaration of the `instanceFields` function and its key, as code. The nearest prototype that owns a field entry decides,
 * also when the entry is `null` (a model that allows additional keys has no program state). A plain value, or a model of an
 * older runtime, has no entry. An own key outside the names is program state, never an unknown key. The runtime function
 * `instanceFields` (presence.ts) walks the same way, and a test holds the two to the same answers.
 */
export function instanceFieldsCode(): Code {
  return join([
    code`const fieldsKey = /*#__PURE__*/ Symbol.for(${literal(MODEL_FIELDS_KEY)});`,
    code`function instanceFields(value) {`,
    code`  let prototype = Object.getPrototypeOf(value);`,
    code`  if (prototype === Object.prototype) return undefined;`,
    code`  for (; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {`,
    code`    if (Object.prototype.hasOwnProperty.call(prototype, fieldsKey)) return prototype[fieldsKey] ?? undefined;`,
    code`  }`,
    code`  return undefined;`,
    code`}`,
  ], code`\n`);
}

export function objectValueExpression(expression: Code): Code {
  return code`typeof ${expression} === 'object' && ${expression} !== null && !Array.isArray(${expression})`;
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

function disjoint(sets: readonly (readonly DiscriminatorValue[])[], byText = false): boolean {
  const seen = new Set<DiscriminatorValue | string>();
  for (const values of sets) {
    if (values.length === 0) return false;
    for (const value of values) {
      const key = byText ? String(value) : value;
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

/**
 * The first property of the first alternative that every alternative requires with literal values, when no value is shared. `tags` holds
 * each alternative's required literal properties and their values; the model generator reads them from descriptors, the rewrite scan from types.
 * With `byText`, values that print the same (`1` and `'1'`) are one value: a query string carries a tag as text.
 */
export function sharedTag(tags: readonly ReadonlyMap<string, readonly DiscriminatorValue[]>[], options: { readonly byText?: boolean } = {}): VariantDispatch | undefined {
  if (tags.length === 0) return undefined;
  for (const property of tags[0].keys()) {
    const values = tags.map((tag) => tag.get(property) ?? []);
    if (disjoint(values, options.byText === true)) return { property, values };
  }
  return undefined;
}

/** A required literal tag whose values are disjoint across the alternatives. */
export function objectDiscriminator(alternatives: readonly ObjectTypeDescriptor[]): VariantDispatch | undefined {
  return sharedTag(alternatives.map(literalDiscriminator));
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
export function discriminatorMatch(read: Code, values: readonly DiscriminatorValue[]): Code {
  return code`(${join(values.map((value) => code`${read} === ${literal(value)}`), code` || `)})`;
}

/** One dispatched variant: its tag values, optional model class and conversion. */
interface DispatchBranch {
  readonly values: readonly DiscriminatorValue[];
  /** Instances of this class select the branch before any tag test. */
  readonly className?: Code;
  readonly convert: Code;
  /** JSON output only: whether `convert` writes the tag property; undefined when unknown. */
  readonly writesTag?: boolean;
}

export interface DispatchOptions {
  readonly expression: Code;
  readonly property: string;
  readonly branches: readonly DispatchBranch[];
  /** decode: wire to model. encode-value: model to wire object. encode-json: model to JSON text. */
  readonly direction: 'decode' | 'encode-value' | 'encode-json';
  /** Encode result for null or undefined. */
  readonly nullish?: Code;
  /**
   * An explicit tag table lets an instance omit its tag: encoding writes the
   * variant's first value. Inferred tags are declared literals and required.
   */
  readonly canonicalTag: boolean;
  /**
   * decode of branches without a class: a local the first tag test assigns, so the tag is read once
   * and the later tests and the rejection use it. The caller declares it.
   */
  readonly tagLocal?: Code;
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
export function emitDispatch(options: DispatchOptions): Code {
  const { expression, property, branches, direction, tagLocal } = options;
  const value = expression;
  const encode = direction !== 'decode';
  const propertyRead = code`(${value} as unknown as Record<string, unknown>)[${literal(property)}]`;
  // Decoding reads the tag by the JSON view, so an inherited or non-enumerable tag selects no branch.
  const tagRead = encode
    ? propertyRead
    : code`(${presentValueCode(value, literal(property), propertyRead)})`;
  const tag = tagLocal ?? tagRead;
  const reject = code`${rt.conversion.unknownDiscriminatorValue}(${literal(property)}, ${tag}, ${encode ? code`'serialize'` : code`'deserialize'`})`;
  const key = literal(property);
  const injectJson = (convert: Code, tagValue: Code): Code =>
    code`${rt.conversion.jsonWithDiscriminator}(${convert}, ${literal(JSON.stringify(property))}, ${tagValue})`;
  // Encoding always writes the selected tag, so the wire value decodes to the same variant.
  const encodeBranch = (branch: DispatchBranch, tagValue: Code, tagMayBeMissing: boolean): Code => {
    const { convert } = branch;
    if (!encode) return convert;
    if (direction === 'encode-value') return code`${rt.conversion.withDiscriminatorValue}(${convert}, ${key}, ${tagValue})`;
    if (branch.writesTag === false) return injectJson(convert, tagValue);
    return tagMayBeMissing ? code`(${tag} === undefined ? ${injectJson(convert, tagValue)} : ${convert})` : convert;
  };
  let converted = encode
    ? code`(${value} == null ? ${options.nullish === undefined ? value : options.nullish} : ${reject})`
    : code`(${objectValueExpression(expression)} ? ${reject} : ${value})`;
  for (let index = branches.length - 1; index >= 0; index--) {
    const branch = branches[index];
    // The first test that runs reads the tag; every path through the chain starts there.
    const guard = tagLocal && index === 0
      ? code`${objectValueExpression(expression)} && (${tag} = ${tagRead}, ${discriminatorMatch(tag, branch.values)})`
      : code`${objectValueExpression(expression)} && ${discriminatorMatch(tag, branch.values)}`;
    converted = code`${guard} ? (${encodeBranch(branch, tag, false)}) : (${converted})`;
  }
  const classes = branches.flatMap((branch) => branch.className ? [branch.className] : []);
  for (let index = branches.length - 1; index >= 0; index--) {
    const branch = branches[index];
    if (!branch.className) continue;
    const self = branch.className;
    const subclasses = classes.filter((other) => !sameCode(other, self))
      .map((other) => code` && !((${value} as object) instanceof ${other} && ${other}.prototype instanceof ${self})`);
    const guard = code`(${value} as object) instanceof ${self}${join(subclasses)}`;
    const ownTag = options.canonicalTag ? code`(${tag} === undefined ? ${literal(branch.values[0])} : ${tag})` : tag;
    const accepted = options.canonicalTag
      ? code`${tag} === undefined || ${discriminatorMatch(tag, branch.values)}`
      : discriminatorMatch(tag, branch.values);
    const body = code`${accepted} ? (${encodeBranch(branch, ownTag, options.canonicalTag)}) : ${reject}`;
    converted = code`${guard} ? (${body}) : (${converted})`;
  }
  return code`(${converted})`;
}

/** The variants of a `scalar | scalar[]` or `scalar | [T, ...]` union: its one sequence, and the scalar variants beside it. */
interface ScalarOrArray {
  readonly sequence: ArrayTypeDescriptor | TupleConversionDescriptor;
  readonly scalars: readonly ModelTypeDescriptor[];
}

/**
 * A union of one array or tuple and scalar variants (a JSON scalar or a literal union), the query-style shape, or one
 * Date: the wire value tells a string from an array. Generated models and untagged objects are not scalarish.
 */
export function scalarOrArray(
  present: readonly ModelTypeDescriptor[],
): ScalarOrArray | undefined {
  const sequences = present.filter(
    (variant): variant is ArrayTypeDescriptor | TupleConversionDescriptor =>
      variant.kind === 'array' || variant.kind === 'tuple',
  );
  if (sequences.length !== 1) return undefined;
  const scalars = present.filter((variant) => variant !== sequences[0]);
  if (!scalars.every(isScalarishDescriptor) && !(scalars.length === 1 && scalars[0].kind === 'date')) return undefined;
  return { sequence: sequences[0], scalars };
}

/** The variants of a `scalar | T[] | object` union: its one sequence, its one object or model, and the scalar variants beside them. */
interface ScalarArrayObject extends ScalarOrArray {
  readonly object: ModelTypeDescriptor;
}

/**
 * A union of scalar variants, one array or tuple, and one object or model: the shape of a JSON value. The value tells
 * the three apart without a tag: `Array.isArray`, then a non-null object, then a scalar.
 */
export function scalarArrayObject(
  present: readonly ModelTypeDescriptor[],
): ScalarArrayObject | undefined {
  const objects = present.filter((variant) =>
    variant.kind === 'object' || variant.kind === 'reference' || variant.kind === 'generated-model');
  if (objects.length !== 1) return undefined;
  const pair = scalarOrArray(present.filter((variant) => variant !== objects[0]));
  return pair ? { ...pair, object: objects[0] } : undefined;
}

/**
 * The sequence branch of a scalar-or-array union, converted by item and with no guard: the union tests
 * `Array.isArray` once. A tuple converts each position as it does outside the union.
 */
export function emitSequenceBranch(
  sequence: ScalarOrArray['sequence'],
  expression: Code,
  items: SequenceItems,
): Code {
  return sequence.kind === 'array'
    ? emitArrayItems(sequence.item, expression, items)
    : emitTupleItems(sequence, expression, items);
}

/**
 * The scalar variant whose own converter the scalar branch uses, or undefined
 * when no scalar variant needs a conversion. A scalar variant that needs a
 * conversion must be the only scalar variant, as in a plain union: the wire
 * value cannot tell it from its siblings, so the union is rejected.
 */
export function scalarBranchVariant(scalars: readonly ModelTypeDescriptor[]): ModelTypeDescriptor | undefined {
  const converting = scalars.filter((scalar) => descriptorNeedsConversion(scalar));
  if (converting.length === 0) return undefined;
  if (scalars.length > 1) throw new AmbiguousUnionConversionError(scalars);
  return converting[0];
}

export function emitScalarOrArrayConversion(
  value: Code,
  mappedArray: Code,
  scalar: Code,
): Code {
  if (sameCode(mappedArray, value) && sameCode(scalar, value)) return value;
  return code`Array.isArray(${value}) ? (${mappedArray}) : (${scalar})`;
}

/** Which walker asks for the conversion. `stringify` writes JSON text; the others write a value. */
export type UnionDirection = 'decode' | 'encode' | 'stringify' | 'nested';

type GeneratedModelTypeDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'generated-model' }>;

/** A union of one generated model and tagged objects, or scalars: the model takes the objects whose tag does not match. */
export interface GeneratedWithObjects {
  /** The conversion of the model; undefined when this walker emits no class for it. */
  readonly text: (generated: GeneratedModelTypeDescriptor) => Code | undefined;
  /** The tag tests of the object variants. */
  readonly tagMatch: (objects: readonly ObjectTypeDescriptor[]) => Code[];
  /** The conversion of the object variants whose tag matches. */
  readonly objects: (objects: readonly ObjectTypeDescriptor[]) => Code;
  /** With no tagged object, the model takes every object whatever the other variants are. */
  readonly takesEveryObject?: boolean;
}

/**
 * What a walker gives the shared union emitter: its conversions, and the steps that only its direction has. A walker that
 * has not moved to Code returns strings and takes the emitted pieces as strings.
 */
export interface UnionConversion {
  /** The conversion of one variant, written against the union's expression. */
  readonly convert: (variant: ModelTypeDescriptor) => Code;
  /** The item conversion of the array or tuple of a scalar-or-array union. */
  readonly items: SequenceItems;
  /** Joins the converted sequence and scalar; defaults to the value form. */
  readonly joinSequence?: (mapped: Code, scalar: Code) => Code;
  /** Dispatch by tag (and class); undefined when the variants carry no tag to dispatch on. */
  readonly tagged: () => Code | undefined;
  /**
   * Wraps the conversion of an inline array, tuple or object branch, so a value that holds itself is found at its first
   * repeat. A branch that is a named node guards itself, and the union guards nothing at its entry: it hands the same value on.
   */
  readonly guard?: (variant: ModelTypeDescriptor, converted: Code) => Code;
  /** A step before the generated-model one, which returns the whole conversion or undefined. */
  readonly beforeGenerated?: (present: readonly ModelTypeDescriptor[]) => Code | undefined;
  readonly generated?: GeneratedWithObjects;
  /** A step after the generated-model one, which returns the whole conversion or undefined. */
  readonly afterGenerated?: (present: readonly ModelTypeDescriptor[]) => Code | undefined;
}

/** The variant kinds that sit beside one object or model in a value conversion and need no conversion. */
const PLAIN_VARIANT_KINDS = ['string', 'number', 'boolean', 'bigint', 'literal'];

/**
 * The one conversion of a union, shared by the stringify, decode and encode walkers and the model walker. The order is
 * fixed: a nullable single variant, a scalar-or-array pair, tagged dispatch, a generated model beside tagged objects,
 * one object or model beside plain variants, and the ambiguity error. Each walker gives its conversions and its own
 * steps through `UnionConversion`. A stringify walker needs no work for a valid value beyond the tests it emits here.
 */
export function emitUnionConversion(
  descriptor: UnionTypeDescriptor,
  expression: Code,
  direction: UnionDirection,
  conversion: UnionConversion,
): Code {
  const json = direction === 'stringify';
  const value = expression;
  const { convert } = conversion;
  // A branch that converts nothing stays the value itself, so it has nothing to guard.
  const guarded = (variant: ModelTypeDescriptor, converted: Code): Code =>
    sameCode(converted, value) || !conversion.guard ? converted : conversion.guard(variant, converted);
  const plain = json ? code`${rt.serde.stringifyJsonScalar}(${value} as never)` : value;
  const present = presentUnionVariants(descriptor);
  if (present.length === 1 && present.length !== descriptor.variants.length) {
    const converted = convert(present[0]);
    if (json) return code`(${value} == null ? 'null' : (${converted}))`;
    return sameCode(converted, value) ? value : code`${value} == null ? ${value} : (${converted})`;
  }
  const nullable = present.length !== descriptor.variants.length;
  // A Date converts no null or undefined, so the nullish variants of the union stop at a guard before its conversion.
  const scalarBranch = (scalars: readonly ModelTypeDescriptor[]): Code => {
    const variant = scalarBranchVariant(scalars) ?? (json && scalars.length === 1 ? scalars[0] : undefined);
    if (!variant) return plain;
    const converted = convert(variant);
    if (!nullable || variant.kind !== 'date') return converted;
    return json ? code`(${value} == null ? 'null' : (${converted}))` : code`(${value} == null ? ${value} : (${converted}))`;
  };
  const pair = scalarOrArray(present);
  if (pair) {
    const { sequence, scalars } = pair;
    const scalar = scalarBranch(scalars);
    const mapped = guarded(sequence, emitSequenceBranch(sequence, expression, conversion.items));
    return joined(conversion, mapped, scalar) ?? emitScalarOrArrayConversion(expression, mapped, scalar);
  }
  const jsonValue = scalarArrayObject(present);
  if (jsonValue) {
    const { sequence, scalars, object } = jsonValue;
    const scalar = scalarBranch(scalars);
    const converted = guarded(object, convert(object));
    const mapped = guarded(sequence, emitSequenceBranch(sequence, expression, conversion.items));
    const rest = sameCode(converted, plain) && sameCode(scalar, plain)
      ? plain
      : json
        ? code`(${objectValueExpression(expression)} ? ${converted} : ${scalar})`
        : code`${objectValueExpression(expression)} ? (${converted}) : ${scalar}`;
    return joined(conversion, mapped, rest) ?? emitScalarOrArrayConversion(expression, mapped, rest);
  }
  const tagged = conversion.tagged();
  if (tagged !== undefined) return tagged;
  const before = conversion.beforeGenerated?.(present);
  if (before !== undefined) return before;
  const withObjects = conversion.generated && generatedWithObjects(present, expression, plain, conversion.generated);
  if (withObjects) return withObjects;
  const after = conversion.afterGenerated?.(present);
  if (after !== undefined) return after;
  // A stringify walker converts the one object or model before it compares all conversions; the others compare first.
  const unchanged = (): Code | undefined => {
    const conversions = present.map(convert);
    return conversions.every((converted) => sameCode(converted, plain)) ? plain : undefined;
  };
  if (!json) {
    const same = unchanged();
    if (same !== undefined) return same;
  }
  const objectsOrModels = present.filter((variant) =>
    variant.kind === 'object' || variant.kind === 'reference' || variant.kind === 'generated-model');
  if (
    objectsOrModels.length === 1
    && present.every((variant) => variant === objectsOrModels[0]
      || (json ? isScalarishDescriptor(variant) : PLAIN_VARIANT_KINDS.includes(variant.kind)))
  ) {
    const converted = convert(objectsOrModels[0]);
    return json
      ? code`(${objectValueExpression(expression)} ? ${converted} : ${plain})`
      : code`${objectValueExpression(expression)} ? (${converted}) : ${value}`;
  }
  if (json) {
    const same = unchanged();
    if (same !== undefined) return same;
  }
  if (direction === 'decode' || direction === 'encode') {
    if (!descriptorNeedsConversion(descriptor)) return value;
  }
  if (objectsOrModels.length > 1) throw new ObjectUnionDiscriminatorError(present);
  throw new AmbiguousUnionConversionError(present);
}

/** The walker's own join of the sequence and the scalar, when it gives one. */
function joined(conversion: UnionConversion, mapped: Code, scalar: Code): Code | undefined {
  const result = conversion.joinSequence?.(mapped, scalar);
  return result === undefined ? undefined : result;
}

function generatedWithObjects(
  present: readonly ModelTypeDescriptor[],
  expression: Code,
  plain: Code,
  options: GeneratedWithObjects,
): Code | undefined {
  const generated = present.filter((variant): variant is GeneratedModelTypeDescriptor => variant.kind === 'generated-model');
  if (generated.length !== 1) return undefined;
  const generatedCode = options.text(generated[0]);
  if (generatedCode === undefined) return undefined;
  const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
  if (objects.length > 0 && !objectDiscriminator(objects)) throw new ObjectUnionDiscriminatorError(objects);
  const tagged = options.tagMatch(objects);
  if (tagged.length) {
    return code`(${objectValueExpression(expression)} && !(${join(tagged, code` || `)}) ? ${generatedCode} : ${options.objects(objects)})`;
  }
  if (options.takesEveryObject || present.every((variant) => variant === generated[0] || isScalarishDescriptor(variant))) {
    return code`(${objectValueExpression(expression)} ? ${generatedCode} : ${plain})`;
  }
  return undefined;
}

/** The descriptor a projection reference names, for the identity test to follow. */
export type ProjectionBodyLookup = (name: string) => ModelTypeDescriptor | undefined;

/**
 * Whether a value of `descriptor` changes when it is converted. A reference needs conversion when the codec constructs a
 * class for it. With `lookup`, a reference to a projection is followed to its body, once per name, so a recursive alias that
 * reaches no date, serde value or model needs none. A projected object copies its declared keys, so it always converts.
 */
export function descriptorNeedsConversion(
  descriptor: ModelTypeDescriptor,
  lookup?: ProjectionBodyLookup,
  visited: Set<string> = new Set(),
): boolean {
  const tags = descriptor as ModelTypeDescriptor & {
    readonly serde?: { readonly id: string };
    readonly date?: true;
  };
  if (tags.serde || tags.date || descriptor.kind === 'date' || descriptor.kind === 'generated-model') {
    return true;
  }
  const needs = (held: ModelTypeDescriptor): boolean => descriptorNeedsConversion(held, lookup, visited);
  if (descriptor.kind === 'reference') {
    if (descriptor.construct === true) return true;
    if (!lookup || !descriptor.projection || visited.has(descriptor.name)) return false;
    visited.add(descriptor.name);
    const body = lookup(descriptor.name);
    return body !== undefined && ((body.kind === 'object' && body.projection === true) || needs(body));
  }
  if (descriptor.kind === 'array') return needs(descriptor.item);
  if (descriptor.kind === 'tuple') {
    return descriptor.items.some(needs)
      || (descriptor.rest !== undefined && needs(descriptor.rest.item));
  }
  if (descriptor.kind === 'object') {
    return Object.values(descriptor.properties).some(needs)
      || (typeof descriptor.additionalProperties === 'object' && needs(descriptor.additionalProperties));
  }
  if (descriptor.kind === 'union' || descriptor.kind === 'intersection') {
    return descriptor.variants.some(needs);
  }
  return false;
}
