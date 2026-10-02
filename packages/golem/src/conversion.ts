import { IssueCode, IssueRepresentation, IssueSource, LibError, LibErrorKind, type IssuePath } from './errors.js';
import { activeConversionPath, conversionError } from './conversion-error.js';
import {
  findGeneratedModelDefinition,
  findGeneratedModelDefinitionForConstructor,
  type GeneratedModel,
  type GeneratedModelConstructor,
  type GeneratedModelResult,
  type GeneratedModelWire,
} from './model.js';

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
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
  throw conversionError(
    direction === 'serialize' ? LibErrorKind.Serialization : LibErrorKind.Deserialization,
    `Unknown ${property} discriminator value: ${shown}.`,
    [...activeConversionPath, property],
    undefined,
    direction === 'deserialize',
  );
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

/** Generated model decoders read wire fields from an object; any other input is rejected as input. */
export function requireModelObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw conversionError(LibErrorKind.Deserialization, `${name} expected an object.`, activeConversionPath, undefined, true);
  }
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

let activeDecodeValues: WeakMap<object, Function | Set<Function>> | undefined;
let activeEncodeModels: Set<object> | undefined;
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
  checkCycles: boolean,
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
    if (checkCycles && objectValue) assertAcyclicValue(value, LibErrorKind.Deserialization);
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
 * Decode a generated model through its registered internal conversion hook.
 * Generated classes intentionally do not expose a public `fromJSON` method;
 * this registry is the runtime seam used by nested conversion.
 */
export function decodeGeneratedModel<Constructor extends GeneratedModelConstructor>(
  constructor: Constructor,
  value: unknown,
): GeneratedModelResult<Constructor>;
export function decodeGeneratedModel(
  constructor: GeneratedModelConstructor,
  value: unknown,
): object {
  return decodeGeneratedModelValue(constructor, value, true);
}

/**
 * Nested generated-model decode after the caller checked the input for cycles
 * or produced a detached tree (`JSON.parse`). Application code should keep
 * using `decodeGeneratedModel`.
 */
export function decodeGeneratedModelTrusted<Constructor extends GeneratedModelConstructor>(
  constructor: Constructor,
  value: unknown,
): GeneratedModelResult<Constructor>;
export function decodeGeneratedModelTrusted(
  constructor: GeneratedModelConstructor,
  value: unknown,
): object {
  return decodeGeneratedModelValue(constructor, value, false);
}

/**
 * Encode a generated model through its registered internal conversion hook.
 * Hooks return a detached plain wire representation.
 */
export function encodeGeneratedModel<Model extends GeneratedModel>(model: Model): GeneratedModelWire<Model>;
/** Internal generated expressions may only know a value as `unknown` until
 * their runtime `instanceof` guard succeeds. Keep that fallback narrow at
 * runtime while leaving the public serde API branded. */
export function encodeGeneratedModel(model: unknown): unknown;
export function encodeGeneratedModel(model: unknown): unknown {
  if (model === null || typeof model !== 'object') {
    throw conversionError(LibErrorKind.Serialization, 'Expected a generated model instance.');
  }
  const definition = findGeneratedModelDefinition(model);
  const conversion = definition?.conversion;
  if (!conversion) {
    throw conversionError(LibErrorKind.Serialization, 'Generated model conversion metadata is missing. Regenerate the model.');
  }
  const active = activeEncodeModels ??= new Set<object>();
  if (active.has(model)) throw conversionError(LibErrorKind.Serialization, 'Cyclic generated model input cannot be encoded.');
  active.add(model);
  try {
    return conversion.encode(model);
  } finally {
    active.delete(model);
    if (active.size === 0) activeEncodeModels = undefined;
  }
}

/**
 * Restore a model Date from wire text with ECMAScript `Date` parse; an existing
 * Date is kept. Format and calendar rules belong on tags or validation.
 */
export function deserializeDate(value: unknown, path: IssuePath = activeConversionPath): Date {
  if (value instanceof Date) return value;
  const date = typeof value === 'string' ? new Date(value) : undefined;
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
