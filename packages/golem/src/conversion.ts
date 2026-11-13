import { LibError, LibErrorKind, type IssuePath } from './errors.js';
import { activeConversionPath, conversionError } from './conversion-error.js';
import { type GeneratedModelConstructor, type GeneratedModelResult } from './model.js';
import { findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor, isGeneratedModel } from './model-registry.js';
import { instanceFields } from './presence.js';
import { isDateTime } from './rfc3339.js';

/** The tag as JSON text. A tag comes from a request, so any value can arrive: `String` throws for an object whose `toString` is not a function. */
function shownTag(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? 'a value that JSON cannot show';
  } catch {
    return 'a value that JSON cannot show';
  }
}

/**
 * Generated union conversions call this when an object's tag selects no
 * variant, or contradicts the variant class of the instance being encoded.
 * The issue path is the active conversion path plus the tag property.
 */
export function unknownDiscriminatorValue(
  property: string,
  value: unknown,
  direction: 'serialize' | 'deserialize',
): never {
  throw conversionError(
    direction === 'serialize' ? LibErrorKind.Serialization : LibErrorKind.Deserialization,
    `Unknown ${property} discriminator value: ${shownTag(value)}.`,
    [...activeConversionPath, property],
    undefined,
    direction === 'deserialize',
  );
}

/**
 * A value a tagged union reads as one of its objects when a class value such as a URL sits beside them: a plain object (also
 * one with no prototype) or a model instance. Any other object is the class value, which this test leaves out.
 */
export function isVariantObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null || isGeneratedModel(value);
}

/** Generated union encoders write the selected variant's tag when the encoded object lacks it. */
export function withDiscriminatorValue(encoded: unknown, property: string, value: unknown): unknown {
  return (encoded as Record<string, unknown>)[property] === undefined
    ? { ...(encoded as object), [property]: value }
    : encoded;
}

/** JSON counterpart of withDiscriminatorValue; `encodedProperty` is the property as JSON text. */
export function jsonWithDiscriminator(text: string, encodedProperty: string, value: unknown): string {
  const head = `{${encodedProperty}:${JSON.stringify(value)}`;
  return text === '{}' ? `${head}}` : `${head},${text.slice(1)}`;
}

/**
 * Rejects, as input, a value that is no object where a generated model decoder reads wire fields. `segment` is the field or
 * index that the active path does not hold yet; it joins the path here, so a decoder that passes it builds no path for a valid value.
 */
export function rejectModelObject(name: string, segment?: string | number): never {
  const path = segment === undefined ? activeConversionPath : [...activeConversionPath, segment];
  throw conversionError(LibErrorKind.Deserialization, `${name} expected an object.`, path, undefined, true);
}

/** Generated model decoders read wire fields from an object; any other input is rejected as input. */
export function requireModelObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) rejectModelObject(name);
  return value as Record<string, unknown>;
}

/** Own enumerable data property that does not invoke inherited setters, including `__proto__`. */
export function defineModelProperty(target: object, name: string, value: unknown): void {
  // With no own or inherited property of that name, assignment creates the
  // same data property and is much faster than defineProperty.
  if (!(name in target)) {
    (target as Record<string, unknown>)[name] = value;
    return;
  }
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * The root of a call with `allowGetter`: a copy with the root's prototype, so a model instance keeps its model. Each
 * declared field is read once, so its getter runs once and the copy never runs a prototype getter again: a defined
 * value is an own enumerable property, and `undefined` is an own non-enumerable one, absent in the JSON view and
 * shadowing the prototype. Another own enumerable key keeps its defined value, except program state of a model
 * instance, which is left out and never read. Nested values are shared. A root that is no object stays as it is.
 */
export function readRootFields(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const copy: object = Object.create(Object.getPrototypeOf(value));
  for (const name of fields) {
    const read = root[name];
    if (read === undefined) Object.defineProperty(copy, name, { value: undefined, configurable: true, writable: true });
    else defineModelProperty(copy, name, read);
  }
  const declared = instanceFields(value);
  for (const key of Object.keys(root)) {
    if (Object.hasOwn(copy, key) || (declared !== undefined && !declared.includes(key))) continue;
    const read = root[key];
    if (read !== undefined) defineModelProperty(copy, key, read);
  }
  return copy;
}

/**
 * The body of a closed object as data: an instance of a class (any prototype but `Object.prototype` or null) keeps only the
 * declared fields it holds, so its program state is never sent or judged as an unknown key. A plain object stays as it is and
 * an extra key of it is an error. A getter or accessor of the class supplies its value; a field named like an `Object.prototype` member (`constructor`) or `__proto__` reads and writes as data.
 */
export function withDeclaredFields(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return value;
  const declared: Record<string, unknown> = {};
  for (const name of fields) {
    const read = declaredFieldValue(value, name);
    if (read !== undefined) defineModelProperty(declared, name, read);
  }
  return declared;
}

/** The value of a declared field: an own property, or an accessor of a class between the value and `Object.prototype`; a name only `Object.prototype` holds (`toString`) or a method of the class is no field. */
function declaredFieldValue(value: object, name: string): unknown {
  for (let holder: object | null = value; holder !== null && holder !== Object.prototype; holder = Object.getPrototypeOf(holder) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, name);
    if (descriptor !== undefined) return holder === value || descriptor.get !== undefined ? Reflect.get(value, name) : undefined;
  }
  return undefined;
}

/** The default `maxDepth`: how many levels of objects and arrays a recursive model's input may nest. */
const DEFAULT_MAX_DEPTH = 512;

/** The `maxDepth` of a call or of an interceptor: `undefined` is the default, `Infinity` turns the bound off. */
export function resolveMaxDepth(maxDepth: unknown): number {
  if (maxDepth === undefined) return DEFAULT_MAX_DEPTH;
  if (typeof maxDepth !== 'number' || !(maxDepth >= 1)) {
    throw new TypeError(`maxDepth must be a number of at least 1, or Infinity to turn the bound off; got ${String(maxDepth)}.`);
  }
  return maxDepth;
}

/** The error of input that nests objects and arrays deeper than `maxDepth`: the input caused it. */
export function nestingDepthError(maxDepth: number): LibError {
  return conversionError(
    LibErrorKind.Deserialization,
    `The input nests objects and arrays deeper than ${maxDepth} levels. Raise the maxDepth option to accept deeper input.`,
    [],
    undefined,
    true,
  );
}

/**
 * What `strip` removes from a value, as data a generated codec holds for each model. A plan describes one JSON
 * value: an object (`keys`, `closed`, `patterns`, `fields`, `values`, `tag`), an array (`items`, `prefix`), a union
 * of an object and an array (`object`, `array`), or a value that a TSerde field holds (`serde`). A plan that names a model by
 * a function is read when it is used, so a model that holds itself has a plan. The keys of a plan are the keys of the wire and
 * of the model alike, so one plan serves decode and encode; only a `serde` value has two shapes. The generated code of a model
 * holds and shares plans: this is a type for that code, which a user does not write or read.
 */
export interface StripPlan {
  /** The declared keys of an object. */
  readonly keys?: ReadonlySet<string>;
  /** The object declares no other key: a key that is not in `keys` and matches no pattern is removed. */
  readonly closed?: true;
  /** Patterns of keys that the object declares (`patternProperties`), each with the plan of its value when that holds something to strip; a key that matches one is kept. */
  readonly patterns?: readonly { readonly pattern: string; readonly plan?: StripPlanRef }[];
  /** The plan of the value of each declared key that holds something to strip. */
  readonly fields?: { readonly [name: string]: StripPlanRef };
  /** The plan of the value of each key that is not declared and is kept: a map value or an additional property. */
  readonly values?: StripPlanRef;
  /** The tag property of a tagged union, the plan of each tag value (a number and the text of that number are two tags), and the plan of a value whose tag selects none. */
  readonly tag?: string;
  readonly variants?: ReadonlyMap<string | number | boolean, StripPlanRef>;
  readonly default?: StripPlanRef;
  /** The plan of each item of an array, or of each item of a tuple after `prefix`. */
  readonly items?: StripPlanRef;
  readonly prefix?: readonly StripPlanRef[];
  /** A union of an object and an array: the plan of each JSON type. */
  readonly object?: StripPlanRef;
  readonly array?: StripPlanRef;
  /** The plan of the wire form of a TSerde value. A decode follows it; an encode leaves the model value as it is, because its shape is the serde's own. */
  readonly serde?: StripPlanRef;
}

/**
 * The plan a generated module declares for its model: it builds the plan at its first use and keeps it, so a module that never
 * strips builds none, and a bundler drops the call when nothing names the plan (the call carries a pure annotation).
 */
export function stripPlan(build: () => StripPlan): () => StripPlan {
  let plan: StripPlan | undefined;
  return () => plan ??= build();
}

/** A plan, a function that gives it, or `undefined` for a value that holds nothing to strip (the plan another module exports for such a node). */
export type StripPlanRef = StripPlan | (() => StripPlan | undefined) | undefined;

/** Thrown inside the strip walk when it nests deeper than the limit; `stripUndeclared` turns it into the cycle error or the depth error. */
const STRIP_TOO_DEEP = Symbol('strip too deep');

const stripPatterns = new Map<string, RegExp>();

function matchesStripPattern(pattern: string, key: string): boolean {
  let expression = stripPatterns.get(pattern);
  if (expression === undefined) stripPatterns.set(pattern, expression = new RegExp(pattern, 'u'));
  return expression.test(key);
}

/**
 * What a strip walk carries: the depth limit, and whether the value is a model value (an encode) rather than a wire value (a decode).
 * `onPath` holds the arrays and objects that the walk is inside, and exists only when no depth limit ends a cycle.
 */
interface StripWalk {
  readonly limit: number;
  readonly model: boolean;
  readonly onPath?: Set<object>;
}

/** Puts the array or object that the walk enters on the path. One that is already on it is a cycle, with the error of the cycle check of the direction. A shared object is on the path only while the walk is inside it. */
function enterStripPath(value: object, walk: StripWalk): void {
  const onPath = walk.onPath;
  if (onPath === undefined) return;
  if (onPath.has(value)) {
    throw conversionError(walk.model ? LibErrorKind.Serialization : LibErrorKind.Deserialization, 'Cyclic values cannot be converted.', [...activeConversionPath], undefined, !walk.model);
  }
  onPath.add(value);
}

function stripLevel(value: unknown, ref: StripPlanRef | undefined, depth: number, walk: StripWalk): unknown {
  if (ref === undefined || value === null || typeof value !== 'object') return value;
  const plan = typeof ref === 'function' ? ref() : ref;
  if (plan === undefined) return value;
  // The root is level 1, as `valueNestsDeeperThan` and `textNestsDeeperThan` count it: the value at `depth` is level `depth + 1`.
  if (depth >= walk.limit) throw STRIP_TOO_DEEP;
  if (plan.serde !== undefined) return walk.model ? value : stripLevel(value, plan.serde, depth, walk);
  if (Array.isArray(value)) return stripArray(value, plan.array === undefined ? plan : (typeof plan.array === 'function' ? plan.array() : plan.array), depth, walk);
  if (plan.array !== undefined || plan.object !== undefined) return stripLevel(value, plan.object, depth, walk);
  return stripObject(value as Record<string, unknown>, plan, depth, walk);
}

function stripArray(value: unknown[], plan: StripPlan | undefined, depth: number, walk: StripWalk): unknown {
  if (plan === undefined || (plan.items === undefined && plan.prefix === undefined)) return value;
  enterStripPath(value, walk);
  let out: unknown[] | undefined;
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    const next = stripLevel(item, index < (plan.prefix?.length ?? 0) ? plan.prefix?.[index] : plan.items, depth + 1, walk);
    if (next === item) continue;
    // A copy keeps the holes of the array, as the conversion of an array keeps them; only a changed item is written.
    out ??= value.slice();
    out[index] = next;
  }
  walk.onPath?.delete(value);
  return out ?? value;
}

/**
 * True when a closed object removes `key`: no declared key and no pattern names it. It is decided before the value is read,
 * so the getter of a removed key never runs.
 */
function removesKey(key: string, plan: StripPlan): boolean {
  if (plan.closed !== true || plan.keys?.has(key) === true) return false;
  if (plan.patterns !== undefined) {
    for (const entry of plan.patterns) if (matchesStripPattern(entry.pattern, key)) return false;
  }
  return true;
}

/**
 * The value of one key of an object that `removesKey` keeps, after strip: a declared field by the plan of the field, a key that a
 * pattern declares by the plan of the pattern, any other key by `values`. Decode and encode, a plain object and an instance
 * of a class read a key by this one rule.
 */
function stripEntry(key: string, member: unknown, plan: StripPlan, depth: number, walk: StripWalk): unknown {
  let next = member;
  let declared = plan.keys?.has(key) === true;
  if (declared && plan.fields !== undefined && Object.hasOwn(plan.fields, key)) next = stripLevel(member, plan.fields[key], depth + 1, walk);
  // A key that a pattern declares holds a value that the pattern's plan strips, also when `keys` names the key too.
  if (plan.patterns !== undefined) {
    for (const entry of plan.patterns) {
      if (!matchesStripPattern(entry.pattern, key)) continue;
      declared = true;
      next = stripLevel(next, entry.plan, depth + 1, walk);
    }
  }
  return declared ? next : stripLevel(member, plan.values, depth + 1, walk);
}

function stripObject(value: Record<string, unknown>, plan: StripPlan, depth: number, walk: StripWalk): unknown {
  if (plan.tag !== undefined) {
    // A tag of another type is in no entry of the map, so it takes the default.
    const tag = value[plan.tag] as string | number | boolean;
    const chosen = plan.variants?.has(tag) === true ? plan.variants.get(tag) : plan.default;
    return stripLevel(value, chosen, depth, walk);
  }
  enterStripPath(value, walk);
  const result = stripKeys(value, plan, depth, walk);
  walk.onPath?.delete(value);
  return result;
}

function stripKeys(value: Record<string, unknown>, plan: StripPlan, depth: number, walk: StripWalk): unknown {
  if (walk.model) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return stripInstance(value, plan, depth, walk);
  }
  let out: Record<string, unknown> | undefined;
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;
    const removed = removesKey(key, plan);
    const member = removed ? undefined : value[key];
    const next = removed ? undefined : stripEntry(key, member, plan, depth, walk);
    if ((removed || next !== member) && out === undefined) {
      out = {};
      for (let earlier = 0; earlier < index; earlier++) defineModelProperty(out, keys[earlier] as string, value[keys[earlier] as string]);
    }
    if (out !== undefined && !removed) defineModelProperty(out, key, next);
  }
  return out ?? value;
}

/**
 * An instance of a class, for an encode. Its own keys that its model does not declare are program state, which no codec writes
 * or judges, unless the model keeps other keys as data (`values` or a pattern: a map, an index signature, `AdditionalProperties`
 * or `patternProperties`). So a closed model walks its declared fields only, and a model with data keys walks every own key
 * by the rule of a plain object (`stripEntry`). The instance itself is returned when nothing in it changes. A key that
 * changes gives a clone with the prototype and the own properties of the instance and the stripped value in place of that
 * key, so the encoder reads the clone as it reads the instance. A key is read as the encoder reads it: an own enumerable
 * property. A getter of the class counts only with `allowGetter`, which makes the codec read it into an own property first.
 */
function stripInstance(value: object, plan: StripPlan, depth: number, walk: StripWalk): unknown {
  const keepsData = plan.closed !== true && (plan.values !== undefined || plan.patterns !== undefined);
  const names = keepsData ? Object.keys(value) : plan.fields === undefined ? undefined : Object.keys(plan.fields);
  if (names === undefined) return value;
  let changed: PropertyDescriptorMap | undefined;
  // A name here is a declared field or a key of a model that keeps other keys as data, so `removesKey` is false for it.
  for (const name of names) {
    if (!Object.prototype.propertyIsEnumerable.call(value, name)) continue;
    const member: unknown = Reflect.get(value, name);
    const next = stripEntry(name, member, plan, depth, walk);
    if (next === member) continue;
    // A sealed or frozen instance holds its keys as non-configurable properties, which a copy cannot redefine, so the copy takes the new value in its own descriptor. The map has no prototype, so a key called `__proto__` stays a key.
    (changed ??= Object.create(null) as PropertyDescriptorMap)[name] = { value: next, enumerable: true, configurable: true, writable: true };
  }
  if (changed === undefined) return value;
  // The copy is read by the encoder only and is never returned to the caller, so it is not frozen again.
  return Object.create(Object.getPrototypeOf(value), { ...Object.getOwnPropertyDescriptors(value), ...changed }) as object;
}

/**
 * The value without the keys that a closed object of `plan` does not declare, at every level: a wire value for a decode, a model value
 * for an encode (`model`). It copies only an object or an array that changes and never writes to the input, so a value that holds
 * nothing to remove is returned as it is. A model value takes no key from an instance of a class, whose undeclared keys are program state unless its model keeps other keys as data, but strips the objects
 * that its declared fields and its data keys hold; it leaves the model value of a TSerde field as it is. A value that nests deeper than `maxDepth` is a cycle or too deep: the cycle check reports a cycle, else the depth error is thrown.
 */
export function stripUndeclared(value: unknown, plan: StripPlanRef, maxDepth?: number, model?: true): unknown {
  const limit = resolveMaxDepth(maxDepth);
  // With the bound off no depth check ends a cycle, and the walk would end the call stack: the walk keeps the objects on its path and reports a revisit as the cycle error of the direction. It reads only the keys that it walks, so a getter of a key that a closed object removes never runs. A value parsed from JSON text has no cycle.
  const onPath = limit === Infinity && (model === true || detachedInputDepth === 0) ? new Set<object>() : undefined;
  const walk: StripWalk = { limit, model: model === true, onPath };
  try {
    return stripLevel(value, plan, 0, walk);
  } catch (error) {
    if (error !== STRIP_TOO_DEEP) throw error;
    if (walk.model) {
      assertAcyclicEncodeInput(value);
      throw conversionError(LibErrorKind.Serialization, `The value nests objects and arrays deeper than ${walk.limit} levels. Raise the maxDepth option to encode a deeper value.`);
    }
    assertWireAcyclic(value);
    throw nestingDepthError(walk.limit);
  }
}

const LEAVE = Symbol('leave');

/** A level of the depth walk: an array, a plain object or a golem model instance. Bytes, dates, maps and other class values are leaves. */
function isNestingLevel(entry: object): boolean {
  if (Array.isArray(entry)) return true;
  const prototype: unknown = Object.getPrototypeOf(entry);
  return prototype === Object.prototype || prototype === null || instanceFields(entry) !== undefined;
}

/** The deepest level the plain walk follows, so its recursion stays far from the call stack limit whatever `maxDepth` a caller sets. Changes speed only. */
const PLAIN_WALK_MAX_DEPTH = 512;
/** The most objects the plain walk visits, so a value that many paths share ends it fast and the exact walk decides. Changes speed only. */
const PLAIN_WALK_BUDGET = 16_384;

/** The objects the running plain walk may still visit. A getter that starts another walk only resets it, which gives that walk more objects and never a wrong answer. */
let plainWalkBudget = 0;

/**
 * True when `level` and everything below it fits in `levels` levels and the budget. Cycles and shared nodes spend the budget or
 * reach the depth, so it answers false for them. When it answers false the exact walk reads the value again, so a getter runs
 * twice. It allocates one array of values for each object (`Object.values`); an array level allocates nothing.
 */
function fitsPlainWalk(level: object, levels: number): boolean {
  if (levels < 1 || --plainWalkBudget < 0) return false;
  if (Array.isArray(level)) {
    for (let index = 0; index < level.length; index++) {
      const item: unknown = level[index];
      if (typeof item === 'object' && item !== null && isNestingLevel(item) && !fitsPlainWalk(item, levels - 1)) return false;
    }
    return true;
  }
  const items: unknown[] = Object.values(level);
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (typeof item === 'object' && item !== null && isNestingLevel(item) && !fitsPlainWalk(item, levels - 1)) return false;
  }
  return true;
}

/**
 * True when `value` nests arrays, plain objects and model instances deeper than `maxDepth`. A plain recursive walk answers
 * first for the common value, which fits; it never answers "too deep". Otherwise the walk below decides. It uses an explicit
 * stack, so a deep value cannot end the call stack, the root is always a level, and an object already on the current path is a cycle, which the cycle
 * checks report. An object that several paths share is walked again only when a path reaches it deeper than before,
 * so a DAG costs one walk for each node and depth, not one for each path.
 */
export function valueNestsDeeperThan(value: unknown, maxDepth: number): boolean {
  if (maxDepth === Infinity || value === null || typeof value !== 'object') return false;
  plainWalkBudget = PLAIN_WALK_BUDGET;
  if (fitsPlainWalk(value, Math.min(maxDepth, PLAIN_WALK_MAX_DEPTH))) return false;
  const onPath = new Set<object>();
  const walkedAt = new Map<object, number>();
  const stack: unknown[] = [value];
  let depth = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === LEAVE) {
      onPath.delete(stack.pop() as object);
      depth--;
      continue;
    }
    if (entry === null || typeof entry !== 'object' || onPath.has(entry) || (entry !== value && !isNestingLevel(entry))) continue;
    if (++depth > maxDepth) return true;
    if ((walkedAt.get(entry) ?? 0) >= depth) { depth--; continue; }
    walkedAt.set(entry, depth);
    onPath.add(entry);
    stack.push(entry, LEAVE);
    if (Array.isArray(entry)) for (let index = 0; index < entry.length; index++) stack.push(entry[index]);
    else for (const key of Object.keys(entry)) stack.push((entry as Record<string, unknown>)[key]);
  }
  return false;
}

/** True when JSON `text` opens more than `maxDepth` nested objects and arrays; it reads the text once and parses nothing. */
export function textNestsDeeperThan(text: string, maxDepth: number): boolean {
  if (maxDepth === Infinity) return false;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 92) index++;
      else if (char === 34) inString = false;
    } else if (char === 34) inString = true;
    else if (char === 123 || char === 91) {
      if (++depth > maxDepth) return true;
    } else if (char === 125 || char === 93) depth--;
  }
  return false;
}

/**
 * The error of a failed conversion: a LibError stays as it is. Any other throw is the application's deserializer,
 * wrapped with the active path. It reads wire input, so its throw is bad input. A model constructor is not a
 * deserializer: `constructModel` has already made its throw a LibError that is not bad input, so it stays as it is here.
 * The generated code calls a serializer outside these scopes, so a serializer's throw reaches the caller as it is.
 */
function itemFailure(error: unknown): LibError {
  if (error instanceof LibError) return error;
  const message = error instanceof Error && error.message ? error.message : 'Field deserialization failed.';
  return conversionError(LibErrorKind.Deserialization, message, activeConversionPath, error, true);
}

/**
 * Builds a model over the decoded fields, for every generated decode. A LibError stays as it is. Any other throw is the
 * application's constructor, a fault of the program and not of the input: it becomes a LibError with `causedByInput`
 * false and the exception as its `cause`, at the root and inside a field, an item or a record value alike.
 */
export function constructModel(constructor: abstract new (...args: never[]) => unknown, init: unknown): unknown {
  try {
    return Reflect.construct(constructor, [init]);
  } catch (error) {
    if (error instanceof LibError) throw error;
    const message = error instanceof Error && error.message ? error.message : 'A model constructor failed.';
    throw conversionError(LibErrorKind.Deserialization, message, activeConversionPath, error, false);
  }
}

/** Generated synchronous conversion scope; no instance or result state is retained. A converter that throws fails as `itemFailure` says. */
export function convertModelField<Arg, Value>(
  field: string | number,
  convert: (arg: Arg) => Value,
  arg: Arg,
): Value {
  activeConversionPath.push(field);
  try {
    return convert(arg);
  } catch (error) {
    throw itemFailure(error);
  } finally {
    activeConversionPath.pop();
  }
}

/**
 * The one loop under `convertModelItems` and `convertModelTupleItems`: it converts each item under its index in the
 * error path. The result is a new array of the same length that skips holes, as `map` does. `withPosition` is the same
 * for every item, so the call shape is fixed before the loop and no closure is made per item.
 */
function convertEachItem<Value>(
  convert: (item: unknown, index: number, items: readonly unknown[]) => Value,
  items: readonly unknown[],
  withPosition: boolean,
): Value[] {
  const length = items.length;
  const converted = new Array<Value>(length);
  const depth = activeConversionPath.push(0) - 1;
  try {
    for (let index = 0; index < length; index++) {
      if (!(index in items)) continue;
      activeConversionPath[depth] = index;
      converted[index] = withPosition ? convert(items[index], index, items) : (convert as (item: unknown) => Value)(items[index]);
    }
  } catch (error) {
    throw itemFailure(error);
  } finally {
    activeConversionPath.length = depth;
  }
  return converted;
}

/**
 * Generated synchronous conversion of each array item, under its index in the error path. `convert` gets the item only,
 * so a converter with an optional second parameter, such as `deserializeDate`, keeps its default path.
 */
export function convertModelItems<Value>(
  convert: (item: unknown) => Value,
  items: readonly unknown[],
): Value[] {
  return convertEachItem(convert, items, false);
}

/** Generated synchronous conversion of each tuple item, under its index in the error path. `convert` gets the item, its index and the array. */
export function convertModelTupleItems<Value>(
  convert: (item: unknown, index: number, items: readonly unknown[]) => Value,
  items: readonly unknown[],
): Value[] {
  return convertEachItem(convert, items, true);
}

/**
 * The one loop under `convertModelRecord` and `copyModelRecord`: a new record with each own entry of `source` whose value
 * is not undefined, in key order, the value converted by `convert` when there is one. With `withPath`, a throwing entry
 * runs under its key in the error path, as `convertModelField` does; without it, an error passes as it is.
 */
function convertEachEntry(
  withPath: boolean,
  convert: ((value: unknown) => unknown) | undefined,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const depth = withPath ? activeConversionPath.push('') - 1 : -1;
  try {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (depth >= 0) activeConversionPath[depth] = key;
      defineModelProperty(out, key, convert === undefined ? value : convert(value));
    }
  } catch (error) {
    throw withPath ? itemFailure(error) : error;
  } finally {
    if (depth >= 0) activeConversionPath.length = depth;
  }
  return out;
}

/** Generated synchronous conversion of each value of a record under its key in the error path. `convert` gets the value only. */
export function convertModelRecord(
  convert: (value: unknown) => unknown,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return convertEachEntry(true, convert, source);
}

/** A copy of a record without its undefined values, each other value converted by `convert` (as it is when absent), with no error path. */
export function copyModelRecord(
  source: Record<string, unknown>,
  convert?: (value: unknown) => unknown,
): Record<string, unknown> {
  return convertEachEntry(false, convert, source);
}

let activeDecodeValues: WeakMap<object, Function | Set<Function>> | undefined;
/** Wire objects a generated recursive `fill` is decoding; a wire already in it is a cycle. */
const activeDecodeWires = new Set<object>();
/** Greater than zero while a generated decoder runs over `JSON.parse` output, which cannot be cyclic. */
let detachedInputDepth = 0;

/**
 * Reject active-path cycles before a validator or generated converter walks a
 * value. Shared references are allowed: the active set drops a value on return.
 * The issue path starts at the active conversion path.
 */
export function assertAcyclicValue(
  value: unknown,
  kind: LibErrorKind.Serialization | LibErrorKind.Deserialization = LibErrorKind.Deserialization,
): void {
  walkConversionInput(value, kind, new Set(), [...activeConversionPath]);
}

/**
 * Generated decoders carry values of `unknown` and open fields by reference,
 * and walk recursive structures. They call this with the object being decoded,
 * the field and the field's value, and use the returned value. A cycle in
 * `value`, including one back to `owner`, throws with the active conversion
 * path plus `field` and the path inside `value`. Nothing is checked while a
 * decoder runs over parsed JSON text.
 */
export function assertPropertyAcyclic(owner: object, field: string | number, value: unknown): unknown {
  if (detachedInputDepth > 0 || value === null || typeof value !== 'object') return value;
  walkConversionInput(value, LibErrorKind.Deserialization, new Set([owner]), [...activeConversionPath, field]);
  return value;
}

/**
 * Generated encoders of a model that reaches a recursive model call this before their validator runs: a validator walks
 * a cyclic value until the stack ends. Shared references are allowed.
 */
export function assertAcyclicEncodeInput(value: unknown): void {
  assertAcyclicValue(value, LibErrorKind.Serialization);
}

/** Objects a generated recursive encoder is writing; an object already in it is a cycle. */
const activeEncodeValues = new Set<object>();

/**
 * A generated encoder of a recursive model registers the value it writes and rejects one that is already being
 * written, so each level costs one set operation. The cycle is a server-side value, so the error is not caused by
 * input. Call `endEncode` in a `finally`.
 */
export function beginEncode(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (activeEncodeValues.has(value)) throw conversionError(LibErrorKind.Serialization, 'Cyclic values cannot be encoded.');
  activeEncodeValues.add(value);
}

export function endEncode(value: unknown): void {
  if (value !== null && typeof value === 'object') activeEncodeValues.delete(value);
}

/** `assertAcyclicValue` for generated decoders: nothing is checked over parsed JSON text. */
export function assertWireAcyclic(value: unknown): void {
  if (detachedInputDepth === 0) assertAcyclicValue(value);
}

/**
 * A generated recursive `fill` registers the object it decodes and rejects one that is already
 * being decoded, so each level costs one set operation instead of a walk of its subtree. The issue
 * path is the active conversion path. Call `endDecode` in a `finally`.
 */
export function beginDecode(wire: object): void {
  if (detachedInputDepth > 0) return;
  if (activeDecodeWires.has(wire)) {
    throw conversionError(LibErrorKind.Deserialization, 'Cyclic values cannot be converted.', [...activeConversionPath], undefined, true);
  }
  activeDecodeWires.add(wire);
}

export function endDecode(wire: object): void {
  if (detachedInputDepth === 0) activeDecodeWires.delete(wire);
}

/** Runs a generated decoder over the output of `JSON.parse`; a tree parsed from text has no cycle to check. */
export function decodeDetachedInput<Options, Value>(
  convert: (wire: unknown, options: Options) => Value,
  wire: unknown,
  options: Options,
): Value {
  detachedInputDepth++;
  try {
    return convert(wire, options);
  } finally {
    detachedInputDepth--;
  }
}

/**
 * Runs a generated decoder for a caller outside generated code, such as a constructor or a serde
 * deserializer that a parse invoked: its input is checked for cycles even while a parse is running.
 */
export function decodeCheckedInput<Options, Value>(
  convert: (wire: unknown, options: Options) => Value,
  wire: unknown,
  options: Options,
): Value {
  const depth = detachedInputDepth;
  detachedInputDepth = 0;
  try {
    return convert(wire, options);
  } finally {
    detachedInputDepth = depth;
  }
}

function walkConversionInput(
  value: unknown,
  kind: LibErrorKind.Serialization | LibErrorKind.Deserialization,
  active: Set<object>,
  path: (string | number)[],
): void {
  if (value === null || typeof value !== 'object') return;
  if (active.has(value)) {
    throw conversionError(kind, 'Cyclic values cannot be converted.', [...path], undefined, kind === LibErrorKind.Deserialization);
  }
  active.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      path.push(index);
      walkConversionInput(value[index], kind, active, path);
      path.pop();
    }
  } else {
    const definition = findGeneratedModelDefinition(value);
    if (definition) {
      // Existing model instances retain identity, but their declared graph still needs checking.
      for (const field of definition.fields) {
        path.push(field);
        walkConversionInput(Reflect.get(value, field), kind, active, path);
        path.pop();
      }
      if (definition.additionalProperties) {
        const known = new Set(definition.fields);
        for (const [name, item] of Object.entries(value)) {
          if (known.has(name)) continue;
          path.push(name);
          walkConversionInput(item, kind, active, path);
          path.pop();
        }
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        for (const name of Object.keys(value)) {
          path.push(name);
          walkConversionInput(Reflect.get(value, name), kind, active, path);
          path.pop();
        }
      }
    }
  }
  active.delete(value);
}

function decodeGeneratedModelValue(
  constructor: GeneratedModelConstructor,
  value: unknown,
): object {
  if (value !== null && typeof value === 'object' && value instanceof constructor) return value;
  const definition = findGeneratedModelDefinitionForConstructor(constructor);
  const conversion = definition?.conversion;
  if (!conversion) {
    throw conversionError(LibErrorKind.Deserialization, 'Generated model conversion metadata is missing. Regenerate the model.');
  }
  const active = activeDecodeValues ??= new WeakMap<object, Function | Set<Function>>();
  const objectValue = value !== null && typeof value === 'object' ? value : undefined;
  const previousOwner = objectValue ? active.get(objectValue) : undefined;
  if (previousOwner === constructor || (previousOwner instanceof Set && previousOwner.has(constructor))) {
    throw conversionError(LibErrorKind.Deserialization, 'Cyclic generated model input cannot be decoded.', activeConversionPath, undefined, true);
  }
  if (objectValue) {
    // Most values have one active constructor. Allocate a set only when the
    // same value is deliberately decoded through multiple model contracts.
    if (previousOwner instanceof Set) previousOwner.add(constructor);
    else active.set(objectValue, previousOwner ? new Set([previousOwner, constructor]) : constructor);
  }
  try {
    const decoded = conversion.decode(value, constructor);
    if (decoded === null || typeof decoded !== 'object' || !(decoded instanceof constructor)) {
      throw conversionError(LibErrorKind.Deserialization, 'Generated model conversion did not return an instance of the requested model.');
    }
    return decoded;
  } catch (error) {
    if (error instanceof LibError) throw error;
    throw conversionError(
      LibErrorKind.Deserialization,
      error instanceof Error && error.message
        ? `Generated model deserialization failed: ${error.message}`
        : 'Generated model deserialization failed.',
      activeConversionPath,
      error,
    );
  } finally {
    if (objectValue) {
      if (previousOwner instanceof Set) previousOwner.delete(constructor);
      if (previousOwner) active.set(objectValue, previousOwner);
      else active.delete(objectValue);
    }
  }
}

/**
 * Nested generated-model decode after the caller checked the input for cycles
 * or produced a detached tree (`JSON.parse`).
 */
export function decodeGeneratedModelTrusted<Constructor extends GeneratedModelConstructor>(
  constructor: Constructor,
  value: unknown,
): GeneratedModelResult<Constructor>;
export function decodeGeneratedModelTrusted(
  constructor: GeneratedModelConstructor,
  value: unknown,
): object {
  return decodeGeneratedModelValue(constructor, value);
}

/**
 * Restore a model Date from a `date-time` text. The text must fit the `date-time` format
 * at every level of validation, off included, because `new Date('5')` reads text that is no time (F-39).
 * A leap second (`isDateTime` allows second 60 only at 23:59:60 UTC) reads as second 59 with its fraction, as `Temporal.Instant.from` does,
 * because `new Date` rejects second 60.
 */
export function deserializeDate(value: unknown, path: IssuePath = activeConversionPath): Date {
  const date = typeof value === 'string' && isDateTime(value) ? new Date(value.startsWith('60', 17) ? `${value.slice(0, 17)}59${value.slice(19)}` : value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) {
    throw conversionError(LibErrorKind.Deserialization, 'Expected a date-time string.', path, undefined, true);
  }
  return date;
}

/**
 * A serde whose wire form is a string, a number or a boolean reads only that JSON type: any other wire value is bad input at every level of
 * validation, off included (F-39). The deserializer that this returns runs on a value of the JSON type and throws for any other.
 */
export function wireChecked(expected: 'string' | 'number' | 'boolean', deserialize: (value: unknown) => unknown): (value: unknown) => unknown {
  return (value) => {
    if (typeof value !== expected) throw conversionError(LibErrorKind.Deserialization, `Expected a ${expected}.`, activeConversionPath, undefined, true);
    return deserialize(value);
  };
}

/** Write a finite Date as UTC with millisecond precision. */
export function serializeDate(value: unknown, path: IssuePath = activeConversionPath): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw conversionError(LibErrorKind.Serialization, 'Expected a valid Date.', path);
  }
  const serialized = value.toISOString();
  if (serialized.length !== 24) throw conversionError(LibErrorKind.Serialization, 'Date year must be between 0000 and 9999.', path);
  return serialized;
}
