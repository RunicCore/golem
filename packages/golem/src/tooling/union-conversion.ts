/**
 * Shared union conversion policy for model companions and IObject codecs.
 * Ambiguous unions fail generation; conversion must not probe alternatives.
 */

import type { DiscriminatorValue, ModelTypeDescriptor } from '../model.js';
import { MODEL_FIELDS_KEY } from '../schema-keywords.js';
import { createHash } from 'node:crypto';
import { bindInput, code, helperName, identifier, inputOf, inputSlot, join, literal, localCode, readShape, render, sameCode, selfPlacedHelper, type Code, type Helper, type InputSlot } from './code.js';
import { rt } from './rt.js';
import type { RichDescriptor } from './type-analysis/graph.js';
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

/** The key that `presentKeysCode` reads in each turn of its pass. */
export const PRESENT_KEY = localCode('key');

/**
 * One `Object.keys` pass that gives each `[key, local]` pair its value in a `let` local, or `undefined` when the key is
 * absent, so each field is read once (the presence rows of scripts/benchmark/validator-toggles.ts). `declare` writes the
 * declaration of a local, for example with a type annotation. `otherwise` is the statement for a key that is not in
 * `captures`; it reads that key as `PRESENT_KEY`, so the same pass sees the other keys.
 */
export function presentKeysCode(
  object: Code,
  captures: readonly (readonly [key: string, local: Code])[],
  options: { readonly declare?: (local: Code) => Code; readonly otherwise?: Code } = {},
): Code {
  const { declare = (local: Code) => local, otherwise } = options;
  const cases = join(captures.map(([key, local]) => code`case ${literal(key)}: ${local} = ${object}[${literal(key)}]; break;`), code` `);
  const other = otherwise === undefined ? code`` : code` default: ${otherwise}`;
  return code`let ${join(captures.map(([, local]) => declare(local)), code`, `)}; for (const ${PRESENT_KEY} of Object.keys(${object})) switch (${PRESENT_KEY}) { ${cases}${other} }`;
}

/**
 * The test that `key` is one of `names` (or, for `keyIsNotListed`, none of them), as comparisons: the generated code builds
 * no list each time it runs. `names` is not empty.
 */
export function keyIsListed(key: Code, names: readonly string[]): Code {
  return join(names.map((name) => code`${key} === ${literal(name)}`), code` || `);
}

export function keyIsNotListed(key: Code, names: readonly string[]): Code {
  return join(names.map((name) => code`${key} !== ${literal(name)}`), code` && `);
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
    code`    if (Object.hasOwn(prototype, fieldsKey)) return prototype[fieldsKey] ?? undefined;`,
    code`  }`,
    code`  return undefined;`,
    code`}`,
  ], code`\n`);
}

/**
 * A non-null, non-array object. `excludingDate`: a Date beside the objects is a scalar variant, so it is no object here.
 * `'instance'`: so is the instance of a TSerde class, such as a URL. Its class is a type that generated code cannot name,
 * so the value is told from a variant object: a model instance and a plain object stay objects.
 */
export function objectValueExpression(expression: Code, excludingDate: boolean | 'instance' = false): Code {
  if (excludingDate === 'instance') return code`${rt.conversion.isVariantObject}(${expression})`;
  const object = code`typeof ${expression} === 'object' && ${expression} !== null && !Array.isArray(${expression})`;
  return excludingDate ? code`${object} && !(${expression} instanceof Date)` : object;
}

function presentUnionVariants(
  descriptor: UnionTypeDescriptor,
): readonly ModelTypeDescriptor[] {
  return descriptor.variants.filter((variant) => variant.kind !== 'null' && variant.kind !== 'undefined');
}

/** A JSON scalar or a union of them. It does not accept `never` or an intersection, which `isScalarDescriptor` of the stringify emitter does. */
export function isScalarishDescriptor(descriptor: ModelTypeDescriptor): boolean {
  if (['null', 'undefined', 'string', 'number', 'boolean', 'bigint', 'literal'].includes(descriptor.kind)) {
    return true;
  }
  return descriptor.kind === 'union' && descriptor.variants.every(isScalarishDescriptor);
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

/** Indices of the union variants that hold a value (not null or undefined). */
function presentUnionIndices(descriptor: UnionTypeDescriptor): number[] {
  return descriptor.variants.flatMap((variant, index) =>
    variant.kind === 'null' || variant.kind === 'undefined' ? [] : [index]);
}

/**
 * The explicit tag table that dispatches the variants at `indices`. The default variant has no tag value to dispatch on, so a
 * union that includes it has no table here: `emitUnionConversion` dispatches the variants that have tag values, and the default converts what the table does not reach.
 */
export function declaredTable(union: UnionTypeDescriptor, indices: readonly number[]): UnionTypeDescriptor['discriminator'] {
  const table = union.discriminator;
  return table && (table.defaultVariant === undefined || !indices.includes(table.defaultVariant)) ? table : undefined;
}

/**
 * Dispatch among the union variants at `indices` by the declared tag table, which must tag each of them. A union with no
 * table has no dispatch: golem never finds a tag in the variants.
 */
export function unionDispatch(
  union: UnionTypeDescriptor,
  indices: readonly number[],
): VariantDispatch | undefined {
  const table = declaredTable(union, indices);
  if (!table) return undefined;
  if (table.variants.length !== union.variants.length) {
    throw new Error(`The ${table.propertyName} discriminator table must list tag values for every union variant.`);
  }
  const values = indices.map((index) => table.variants[index]?.values ?? []);
  if (indices.length === 0 || !disjoint(values)) {
    throw new Error(`The ${table.propertyName} discriminator table must give each variant distinct, non-empty tag values.`);
  }
  return { property: table.propertyName, values };
}

/** `access` equals one of `values`. */
function discriminatorMatch(read: Code, values: readonly DiscriminatorValue[]): Code {
  return code`(${join(values.map((value) => code`${read} === ${literal(value)}`), code` || `)})`;
}

/** One dispatched variant: its tag values, optional model class and conversion. */
interface DispatchBranch {
  readonly values: readonly DiscriminatorValue[];
  /** Instances of this class select the branch before any tag test. */
  readonly className?: Code;
  readonly convert: Code;
  /**
   * JSON output only: whether `convert` writes the tag property from the value (`true`) or not at all (`false`); undefined when unknown.
   * `'always'`: it writes the tag as a constant, so an instance that holds no tag is written with it and nothing is injected.
   */
  readonly writesTag?: boolean | 'always';
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
   * decode of branches without a class: a local the first tag test assigns, so the tag is read once
   * and the later tests and the rejection use it. The caller declares it.
   */
  readonly tagLocal?: Code;
  /** The conversion of a value that is no object (a scalar, null or the like), when the union has variants outside the tag table. */
  readonly rest?: Code;
  /** `rest` holds a Date variant (`true`) or the variant of a TSerde class (`'instance'`): an instance of it is that variant, not an object for the tag test. */
  readonly restIsInstance?: boolean | 'instance';
  /** The conversion of an object whose tag selects no branch: the declared default. With none, such an object is rejected. */
  readonly fallback?: Code;
  /** The class of the instances `fallback` converts. An instance of it is no instance of a branch class it extends. */
  readonly fallbackClass?: Code;
  /**
   * The caller's promise that the branches, `rest` and `fallback` read nothing of the function around the dispatch except
   * `expression`, so the file can hold the dispatch as a function of its own (see `selectedDispatch`).
   */
  readonly standalone?: true;
}

/**
 * The one tagged-union dispatch shared by the emitters.
 *
 * - An instance of a branch class selects that branch first; a subclass wins
 *   over its base regardless of variant order. Its own tag must be one of the
 *   branch's values; encoding writes that tag, or the branch's first value
 *   when the instance has none (the declared table lets an instance omit its tag).
 * - Any other object selects the branch whose values contain its tag.
 * - An object whose tag selects no branch takes `fallback`, or is rejected. A value that is no object takes `rest`;
 *   with none, decoding leaves it, and encoding writes null or undefined unchanged and rejects every other value.
 */
export function emitDispatch(options: DispatchOptions): Code {
  const selected = options.tagLocal === undefined ? selectedDispatch(options) : undefined;
  return selected ?? inlineDispatch(options);
}

/** The local of a union function that holds the branch index, and its parameter. */
const BRANCH_INDEX = localCode('index');
const UNION_PARAMETER = localCode('union');

/**
 * The variable that a dispatch kept in its writer assigns the branch index to. Its tests read it at once, before any branch
 * runs, so a branch that holds another selected dispatch may assign it again.
 */
const SELECTED_INDEX = selfPlacedHelper('__golemVariant', () => code`let __golemVariant = 0;`);

/** The slot of a Code that is one input part. */
function onlyInputSlot(expression: Code): InputSlot | undefined {
  const [only, ...more] = expression.parts;
  return only?.kind === 'input' && more.length === 0 ? only.slot : undefined;
}

/**
 * Emit a union against an input part, so a dispatch can lift the code that reads the union's value out of the function around
 * it (`selectedDispatch`): the value is a part it can bind elsewhere. An expression that is an input part already (the cast
 * root of a decoder, a field slot) is that part, and other code compares the union's value with it. Any other expression gets
 * a part of its own with the same shape, so the code written against it is the code written against `expression`.
 */
export function withUnionInput(expression: Code, emit: (value: Code) => Code): Code {
  if (onlyInputSlot(expression)) return emit(expression);
  const slot = inputSlot('union value', readShape(expression));
  const emitted = emit(inputOf(slot));
  return onlyInputSlot(emitted) === slot ? expression : bindInput(emitted, slot, expression);
}

/** A class Code the selector can repeat in its own definition: a name that no slot decides. */
function isPlainName(name: Code): boolean {
  return name.parts.every((part) => part.kind === 'text' || part.kind === 'runtime' || part.kind === 'imported');
}

/**
 * The selector of a dispatch: a function of the file that returns the index of the branch a value takes, `-1` for a value
 * that is no object, and the index after the last branch for the declared default. It throws for a tag that selects no
 * branch (or no default) or contradicts the class of an instance. One selector stands for every writer of the union, so the
 * class guards and the tag tests exist once. Its id comes from its text, so the files of two TypeScript versions agree.
 */
function variantSelector(options: DispatchOptions): Helper {
  const { property, branches, rest, fallback, fallbackClass, restIsInstance } = options;
  const encode = options.direction !== 'decode';
  const input = localCode('value');
  const tag = localCode('tag');
  const key = literal(property);
  const propertyRead = code`(${input} as unknown as Record<string, unknown>)[${key}]`;
  const rejecting = (shown: Code): Code => code`${rt.conversion.unknownDiscriminatorValue}(${key}, ${shown}, ${encode ? code`'serialize'` : code`'deserialize'`})`;
  const classes = [...branches.flatMap((branch) => branch.className ? [branch.className] : []), ...(fallback && fallbackClass ? [fallbackClass] : [])];
  const statements: Code[] = [
    encode && rest === undefined
      ? code`if (!(${objectValueExpression(input)})) return ${input} == null ? -1 : ${rejecting(propertyRead)};`
      : code`if (!(${objectValueExpression(input, restIsInstance)})) return -1;`,
    // Decoding reads the tag by the JSON view, so an inherited or non-enumerable tag selects no branch.
    code`const ${tag} = ${encode ? propertyRead : presentValueCode(input, key, propertyRead)};`,
  ];
  branches.forEach((branch, index) => {
    const self = branch.className;
    if (!self) return;
    const subclasses = classes.filter((other) => !sameCode(other, self))
      .map((other) => code` && !((${input} as object) instanceof ${other} && ${other}.prototype instanceof ${self})`);
    statements.push(code`if ((${input} as object) instanceof ${self}${join(subclasses)}) return ${tag} === undefined || ${discriminatorMatch(tag, branch.values)} ? ${literal(index)} : ${rejecting(tag)};`);
  });
  branches.forEach((branch, index) => statements.push(code`if (${discriminatorMatch(tag, branch.values)}) return ${literal(index)};`));
  statements.push(fallback === undefined ? code`return ${rejecting(tag)};` : code`return ${literal(branches.length)};`);
  const body = join(statements, code` `);
  const id = `__golemVariant_${createHash('sha256').update(render(body)).digest('hex').slice(0, 10)}`;
  return selfPlacedHelper(id, () => code`function ${identifier(id)}(${input}: unknown): number { ${body} }`);
}

/**
 * `emitDispatch` through a selector, when a branch is a model class: the guard of each class would otherwise stand in every
 * writer. The selector picks the index of the branch; the branch it names converts the value.
 *
 * The caller can promise that the branches read nothing of the writer's function but `expression` (`standalone`). The picking
 * and converting is then one function of the file, and each writer calls it with the value; its id comes from its text, so
 * identical unions of one direction share one function. Otherwise, or when a branch names a part that only the writer's
 * function knows, the writer holds the index in a module variable and tests it itself.
 */
function selectedDispatch(options: DispatchOptions): Code | undefined {
  const { expression: value, branches, fallback, fallbackClass } = options;
  const classes = [...branches.flatMap((branch) => branch.className ? [branch.className] : []), ...(fallback && fallbackClass ? [fallbackClass] : [])];
  if (!branches.some((branch) => branch.className) || !classes.every(isPlainName)) return undefined;
  const encode = options.direction !== 'decode';
  const key = literal(options.property);
  const tag = code`(${value} as unknown as Record<string, unknown>)[${key}]`;
  const json = (convert: Code, tagValue: Code): Code => code`${rt.conversion.jsonWithDiscriminator}(${convert}, ${literal(JSON.stringify(options.property))}, ${tagValue})`;
  // Encoding always writes the selected tag, so the wire value decodes to the same variant. An instance may hold no tag, and
  // then it takes the first value of its branch; a plain object the selector took by its tag holds one.
  const arm = (branch: DispatchBranch): Code => {
    const { convert } = branch;
    if (!encode) return convert;
    const tagValue = branch.className ? code`(${tag} ?? ${literal(branch.values[0])})` : tag;
    if (options.direction === 'encode-value') return code`${rt.conversion.withDiscriminatorValue}(${convert}, ${key}, ${tagValue})`;
    if (branch.writesTag === 'always') return convert;
    if (branch.writesTag === false) return json(convert, tagValue);
    return branch.className ? code`(${tag} === undefined ? ${json(convert, literal(branch.values[0]))} : ${convert})` : convert;
  };
  const outside = options.rest ?? (encode ? (options.nullish === undefined ? value : options.nullish) : value);
  // The last arm needs no test: the selector returns no other index.
  const last = branches.length - (fallback === undefined ? 1 : 0);
  const chainOf = (index: Code): Code => {
    let chain = fallback ?? arm(branches[last]);
    for (let at = last - 1; at >= 0; at--) chain = code`${index} === ${literal(at)} ? (${arm(branches[at])}) : (${chain})`;
    return chain;
  };
  const selector = helperName(variantSelector(options));
  const slot = options.standalone ? onlyInputSlot(value) : undefined;
  if (slot) {
    const body = bindInput(
      code`const ${BRANCH_INDEX} = ${selector}(${value}); return ${BRANCH_INDEX} < 0 ? (${outside}) : (${chainOf(BRANCH_INDEX)});`,
      slot,
      UNION_PARAMETER,
    );
    // An input or a name left in the body belongs to the writer's function, which the union function cannot see.
    if (!body.parts.some((part) => part.kind === 'input' || part.kind === 'name' || part.kind === 'export')) {
      const id = `__golemUnion_${createHash('sha256').update(render(body)).digest('hex').slice(0, 10)}`;
      // The return type is written, so no function in a cycle of codecs has an inferred one. The arms of JSON text are strings
      // when no scalar or default conversion of the caller stands among them; those have a type of their own, so it is left.
      const returns = options.direction !== 'encode-json' ? code` : unknown` : options.rest === undefined && fallback === undefined ? code` : string` : code``;
      const union = selfPlacedHelper(id, () => code`function ${identifier(id)}(${UNION_PARAMETER}: unknown)${returns} { ${body} }`);
      return code`${helperName(union)}(${value})`;
    }
  }
  const index = helperName(SELECTED_INDEX);
  return code`((${index} = ${selector}(${value})) < 0 ? (${outside}) : (${chainOf(index)}))`;
}

function inlineDispatch(options: DispatchOptions): Code {
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
    if (branch.writesTag === 'always') return convert;
    if (branch.writesTag === false) return injectJson(convert, tagValue);
    return tagMayBeMissing ? code`(${tag} === undefined ? ${injectJson(convert, tagValue)} : ${convert})` : convert;
  };
  const { rest, fallback, fallbackClass } = options;
  // The object test runs once: an object picks its branch by tag, and any other value is `rest`.
  let chain = fallback ?? reject;
  for (let index = branches.length - 1; index >= 0; index--) {
    const branch = branches[index];
    // The first test that runs reads the tag; every path through the chain starts there.
    const guard = tagLocal && index === 0
      ? code`(${tag} = ${tagRead}, ${discriminatorMatch(tag, branch.values)})`
      : discriminatorMatch(tag, branch.values);
    chain = code`${guard} ? (${encodeBranch(branch, tag, false)}) : (${chain})`;
  }
  const outside = rest ?? (encode ? code`${value} == null ? ${options.nullish === undefined ? value : options.nullish} : ${reject}` : value);
  let converted = code`(${objectValueExpression(expression, options.restIsInstance)} ? ${chain} : ${outside})`;
  // The default's class counts as a subclass candidate too: an instance of it is the default, not the branch it extends.
  const classes = [...branches.flatMap((branch) => branch.className ? [branch.className] : []), ...(fallback && fallbackClass ? [fallbackClass] : [])];
  for (let index = branches.length - 1; index >= 0; index--) {
    const branch = branches[index];
    if (!branch.className) continue;
    const self = branch.className;
    const subclasses = classes.filter((other) => !sameCode(other, self))
      .map((other) => code` && !((${value} as object) instanceof ${other} && ${other}.prototype instanceof ${self})`);
    const guard = code`(${value} as object) instanceof ${self}${join(subclasses)}`;
    const ownTag = code`(${tag} === undefined ? ${literal(branch.values[0])} : ${tag})`;
    const accepted = code`${tag} === undefined || ${discriminatorMatch(tag, branch.values)}`;
    const body = code`${accepted} ? (${encodeBranch(branch, ownTag, true)}) : ${reject}`;
    converted = code`${guard} ? (${body}) : (${converted})`;
  }
  return code`(${converted})`;
}

/** The variants of a `scalar | scalar[]` or `scalar | [T, ...]` union: its one sequence, and the scalar variants beside it. */
interface ScalarOrArray {
  readonly sequence: ArrayTypeDescriptor | TupleConversionDescriptor;
  readonly scalars: readonly ModelTypeDescriptor[];
}

/** A class value (a TSerde class or bigint) whose JSON form is a scalar, so the wire value tells it from an object or an array. */
function isClassValueOfScalar(descriptor: ModelTypeDescriptor): boolean {
  const wire = (descriptor as RichDescriptor).serde?.wireDescriptor;
  return descriptor.kind === 'class-value' && wire !== undefined && isScalarishDescriptor(wire);
}

/** How the model value of the scalar variants is told from a variant object: `'instance'` for a TSerde class instance, `true` for a Date, else `false`. */
function restInstance(scalars: readonly ModelTypeDescriptor[]): boolean | 'instance' {
  return scalars.some((variant) => variant.kind === 'class-value' && variant.typeName !== 'bigint') ? 'instance' : scalars.some((variant) => variant.kind === 'date');
}

/**
 * The variants a value's JSON type tells apart without a tag: scalar variants (a JSON scalar or a literal union, or one Date or one class value with a scalar JSON form)
 * and at most one array or tuple. Generated models and untagged objects are not scalarish.
 */
function jsonTypeVariants(
  variants: readonly ModelTypeDescriptor[],
): { readonly sequence?: ScalarOrArray['sequence']; readonly scalars: readonly ModelTypeDescriptor[] } | undefined {
  const sequences = variants.filter(
    (variant): variant is ArrayTypeDescriptor | TupleConversionDescriptor =>
      variant.kind === 'array' || variant.kind === 'tuple',
  );
  if (sequences.length > 1) return undefined;
  const scalars = variants.filter((variant) => variant !== sequences[0]);
  if (!scalars.every(isScalarishDescriptor) && !(scalars.length === 1 && (scalars[0].kind === 'date' || isClassValueOfScalar(scalars[0])))) return undefined;
  return { sequence: sequences[0], scalars };
}

/** A union of one array or tuple and scalar variants, the query-style shape: the wire value tells a string from an array. */
function scalarOrArray(
  present: readonly ModelTypeDescriptor[],
): ScalarOrArray | undefined {
  const types = jsonTypeVariants(present);
  return types?.sequence ? { sequence: types.sequence, scalars: types.scalars } : undefined;
}

/** The variants of a `scalar | T[] | object` union: its one sequence, its one object or model, and the scalar variants beside them. */
interface ScalarArrayObject extends ScalarOrArray {
  readonly object: ModelTypeDescriptor;
}

/**
 * A union of scalar variants, one array or tuple, and one object or model: the shape of a JSON value. The value tells
 * the three apart without a tag: `Array.isArray`, then a non-null object, then a scalar.
 */
function scalarArrayObject(
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
function emitSequenceBranch(
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
function scalarBranchVariant(scalars: readonly ModelTypeDescriptor[]): ModelTypeDescriptor | undefined {
  const converting = scalars.filter((scalar) => descriptorNeedsConversion(scalar));
  if (converting.length === 0) return undefined;
  if (scalars.length > 1) throw new AmbiguousUnionConversionError(scalars);
  return converting[0];
}

function emitScalarOrArrayConversion(
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

/** A union of one generated model beside scalars or null: the model takes every object value. */
interface GeneratedWithObjects {
  /** The conversion of the model; undefined when this walker emits no class for it. */
  readonly text: (generated: GeneratedModelTypeDescriptor) => Code | undefined;
  /** The model takes every object value whatever the other variants are, not only beside scalars. */
  readonly takesEveryObject?: boolean;
}

/** The variants a tag dispatch covers, and what it does with the values the tag does not reach. */
export interface TaggedUnion {
  readonly indices: readonly number[];
  readonly rest?: Code;
  /** `rest` converts a Date variant or a TSerde class variant (see `DispatchOptions`). */
  readonly restIsInstance?: boolean | 'instance';
  readonly fallback?: Code;
  /** The declared default variant that `fallback` converts: its class is not a tagged variant's, though it may extend one. */
  readonly fallbackVariant?: ModelTypeDescriptor;
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
  /**
   * Dispatch the variants at `indices` by tag (and class); undefined when they carry no tag to dispatch on. With a declared
   * table, `indices` are the variants that carry tag values; `rest` converts a value that is no object and `fallback` an object
   * whose tag selects none of them (see `DispatchOptions`).
   */
  readonly tagged: (spec: TaggedUnion) => Code | undefined;
  /** The conversion of the declared default variant, when it differs from `convert`. */
  readonly declaredDefault?: (variant: ModelTypeDescriptor) => Code | undefined;
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
 * fixed: a nullable single variant, a scalar-or-array pair, tagged dispatch (with the JSON-type variants and the declared
 * default of its table), a generated model beside plain variants, one object or model beside plain variants, and the ambiguity error. Each walker gives its conversions and its own
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
  // A scalar that converts (a Date or a serde scalar), and in stringify any scalar writer other than the plain one, converts no
  // null or undefined, so the nullish variants of the union stop at a guard before its conversion.
  const scalarBranch = (scalars: readonly ModelTypeDescriptor[]): Code => {
    const variant = scalarBranchVariant(scalars) ?? (json && scalars.length === 1 ? scalars[0] : undefined);
    if (!variant) return plain;
    const converted = convert(variant);
    if (!nullable) return converted;
    if (json) return sameCode(converted, plain) ? converted : code`(${value} == null ? 'null' : (${converted}))`;
    return sameCode(converted, plain) ? converted : code`(${value} == null ? ${value} : (${converted}))`;
  };
  /**
   * Tagged dispatch. Under a declared table the JSON type goes first: an array or tuple, a scalar or null take their own
   * variants, and only an object value reaches the tag, whose unmatched values take the declared default.
   */
  const taggedConversion = (): Code | undefined => {
    const indices = presentUnionIndices(descriptor);
    const table = descriptor.discriminator;
    const taggedIndices = table ? indices.filter((index) => table.variants[index].values.length > 0) : indices;
    if (!table || taggedIndices.length === indices.length) return conversion.tagged({ indices: taggedIndices });
    const rest = indices.filter((index) => !taggedIndices.includes(index) && index !== table.defaultVariant)
      .map((index) => descriptor.variants[index]);
    const types = jsonTypeVariants(rest);
    if (!types) throw new AmbiguousUnionConversionError(rest);
    const declared = table.defaultVariant === undefined ? undefined : descriptor.variants[table.defaultVariant];
    const fallback = declared && (conversion.declaredDefault?.(declared) ?? convert(declared));
    const scalar = rest.length > 0 ? scalarBranch(types.scalars) : undefined;
    const objects = conversion.tagged({
      indices: taggedIndices,
      ...(scalar === undefined ? {} : { rest: scalar, restIsInstance: restInstance(types.scalars) }),
      ...(fallback === undefined ? {} : { fallback, fallbackVariant: declared }),
    });
    if (objects === undefined || !types.sequence) return objects;
    const mapped = guarded(types.sequence, emitSequenceBranch(types.sequence, expression, conversion.items));
    return conversion.joinSequence?.(mapped, objects) ?? emitScalarOrArrayConversion(expression, mapped, objects);
  };
  const pair = scalarOrArray(present);
  if (pair) {
    const { sequence, scalars } = pair;
    const scalar = scalarBranch(scalars);
    const mapped = guarded(sequence, emitSequenceBranch(sequence, expression, conversion.items));
    return conversion.joinSequence?.(mapped, scalar) ?? emitScalarOrArrayConversion(expression, mapped, scalar);
  }
  const jsonValue = scalarArrayObject(present);
  if (jsonValue) {
    const { sequence, scalars, object } = jsonValue;
    const scalar = scalarBranch(scalars);
    const objectTest = objectValueExpression(expression, scalars.some((variant) => variant.kind === 'date'));
    const converted = guarded(object, convert(object));
    const mapped = guarded(sequence, emitSequenceBranch(sequence, expression, conversion.items));
    const rest = sameCode(converted, plain) && sameCode(scalar, plain)
      ? plain
      : json
        ? code`(${objectTest} ? ${converted} : ${scalar})`
        : code`${objectTest} ? (${converted}) : ${scalar}`;
    return conversion.joinSequence?.(mapped, rest) ?? emitScalarOrArrayConversion(expression, mapped, rest);
  }
  const tagged = taggedConversion();
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
