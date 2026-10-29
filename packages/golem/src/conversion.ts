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

const LEAVE = Symbol('leave');

/** A level of the depth walk: an array, a plain object or a golem model instance. Bytes, dates, maps and other class values are leaves. */
function isNestingLevel(entry: object): boolean {
  if (Array.isArray(entry)) return true;
  const prototype = Object.getPrototypeOf(entry);
  return prototype === Object.prototype || prototype === null || instanceFields(entry) !== undefined;
}

/**
 * True when `value` nests arrays, plain objects and model instances deeper than `maxDepth`. It walks with an explicit
 * stack, so a deep value cannot end the call stack, the root is always a level, and an object already on the current path is a cycle, which the cycle
 * checks report. An object that several paths share is walked again only when a path reaches it deeper than before,
 * so a DAG costs one walk for each node and depth, not one for each path.
 */
export function valueNestsDeeperThan(value: unknown, maxDepth: number): boolean {
  if (maxDepth === Infinity || value === null || typeof value !== 'object') return false;
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

/** Generated synchronous conversion scope; no instance or result state is retained. */
export function convertModelField<Arg, Value>(
  direction: 'serialize' | 'deserialize',
  field: string | number,
  convert: (arg: Arg) => Value,
  arg: Arg,
): Value {
  activeConversionPath.push(field);
  try {
    return convert(arg);
  } catch (error) {
    if (error instanceof LibError) throw error;
    const kind = direction === 'serialize' ? LibErrorKind.Serialization : LibErrorKind.Deserialization;
    const message = error instanceof Error && error.message
      ? error.message
      : `Field ${direction === 'serialize' ? 'serialization' : 'deserialization'} failed.`;
    throw conversionError(kind, message, activeConversionPath, error);
  } finally {
    activeConversionPath.pop();
  }
}

/** The error `convertModelItems` and `convertModelTupleItems` throw for a failed item, with the rules of `convertModelField`. */
function itemFailure(direction: 'serialize' | 'deserialize', error: unknown): LibError {
  if (error instanceof LibError) return error;
  const kind = direction === 'serialize' ? LibErrorKind.Serialization : LibErrorKind.Deserialization;
  const message = error instanceof Error && error.message
    ? error.message
    : `Field ${direction === 'serialize' ? 'serialization' : 'deserialization'} failed.`;
  return conversionError(kind, message, activeConversionPath, error);
}

/**
 * The one loop under `convertModelItems` and `convertModelTupleItems`: it converts each item under its index in the
 * error path. The result is a new array of the same length that skips holes, as `map` does. `withPosition` is the same
 * for every item, so the call shape is fixed before the loop and no closure is made per item.
 */
function convertEachItem<Value>(
  direction: 'serialize' | 'deserialize',
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
    throw itemFailure(direction, error);
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
  direction: 'serialize' | 'deserialize',
  convert: (item: unknown) => Value,
  items: readonly unknown[],
): Value[] {
  return convertEachItem(direction, convert, items, false);
}

/** Generated synchronous conversion of each tuple item, under its index in the error path. `convert` gets the item, its index and the array. */
export function convertModelTupleItems<Value>(
  direction: 'serialize' | 'deserialize',
  convert: (item: unknown, index: number, items: readonly unknown[]) => Value,
  items: readonly unknown[],
): Value[] {
  return convertEachItem(direction, convert, items, true);
}

/**
 * The one loop under `convertModelRecord` and `copyModelRecord`: a new record with each own entry of `source` whose value
 * is not undefined, in key order, the value converted by `convert` when there is one. With `direction`, a throwing entry
 * runs under its key in the error path, as `convertModelField` does; without it, an error passes as it is.
 */
function convertEachEntry(
  direction: 'serialize' | 'deserialize' | undefined,
  convert: ((value: unknown) => unknown) | undefined,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const depth = direction === undefined ? -1 : activeConversionPath.push('') - 1;
  try {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (depth >= 0) activeConversionPath[depth] = key;
      defineModelProperty(out, key, convert === undefined ? value : convert(value));
    }
  } catch (error) {
    throw direction === undefined ? error : itemFailure(direction, error);
  } finally {
    if (depth >= 0) activeConversionPath.length = depth;
  }
  return out;
}

/** Generated synchronous conversion of each value of a record under its key in the error path. `convert` gets the value only. */
export function convertModelRecord(
  direction: 'serialize' | 'deserialize',
  convert: (value: unknown) => unknown,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return convertEachEntry(direction, convert, source);
}

/** A copy of a record without its undefined values, each other value converted by `convert` (as it is when absent), with no error path. */
export function copyModelRecord(
  source: Record<string, unknown>,
  convert?: (value: unknown) => unknown,
): Record<string, unknown> {
  return convertEachEntry(undefined, convert, source);
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
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
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
 * Restore a model Date from a `date-time` text; an existing valid Date is kept. The text must fit the `date-time` format
 * at every level of validation, off included, because `new Date('5')` reads text that is no time (F-39).
 */
export function deserializeDate(value: unknown, path: IssuePath = activeConversionPath): Date {
  const date = value instanceof Date ? value : typeof value === 'string' && isDateTime(value) ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) {
    throw conversionError(LibErrorKind.Deserialization, 'Expected a date-time string.', path, undefined, true);
  }
  return date;
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
