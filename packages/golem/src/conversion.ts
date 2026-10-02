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

/**
 * Generated synchronous conversion scope; no instance or result state is retained.
 * A converter that takes `arg` needs no per-call closure; the closure form serves nested conversions.
 */
export function convertModelField<Arg, Value>(
  direction: 'serialize' | 'deserialize',
  field: string | number,
  convert: (arg: Arg) => Value,
  arg: Arg,
): Value;
export function convertModelField<Value>(
  direction: 'serialize' | 'deserialize',
  field: string | number,
  convert: () => Value,
): Value;
export function convertModelField<Arg, Value>(
  direction: 'serialize' | 'deserialize',
  field: string | number,
  convert: (arg: Arg) => Value,
  arg?: Arg,
): Value {
  const previousLength = activeConversionPath.length;
  activeConversionPath.push(field);
  try {
    return convert(arg as Arg);
  } catch (error) {
    if (error instanceof LibError) throw error;
    const kind = direction === 'serialize' ? LibErrorKind.Serialization : LibErrorKind.Deserialization;
    const message = error instanceof Error && error.message
      ? error.message
      : `Field ${direction === 'serialize' ? 'serialization' : 'deserialization'} failed.`;
    throw conversionError(kind, message, activeConversionPath, error);
  } finally {
    activeConversionPath.length = previousLength;
  }
}

let activeDecodeValues: WeakMap<object, Function | Set<Function>> | undefined;
let activeEncodeModels: Set<object> | undefined;

/**
 * Reject active-path cycles before a validator or generated converter walks a
 * value. Shared references are allowed: the active set is removed on return.
 */
export function assertAcyclicValue(
  value: unknown,
  kind: LibErrorKind.Serialization | LibErrorKind.Deserialization = LibErrorKind.Deserialization,
): void {
  walkConversionInput(value, kind, false);
}

/** Check cycles and isolate plain input containers before invoking application code. */
export function cloneConversionInput(value: unknown): unknown {
  return walkConversionInput(value, LibErrorKind.Deserialization, true);
}

function walkConversionInput(
  value: unknown,
  kind: LibErrorKind.Serialization | LibErrorKind.Deserialization,
  copy: boolean,
): unknown {
  const active = new Set<object>();
  const path: (string | number)[] = [];
  const at = (current: unknown, field: string | number, clone: boolean): unknown => {
    path.push(field);
    try { return visit(current, clone); }
    finally { path.pop(); }
  };
  const visit = (current: unknown, clone: boolean): unknown => {
    if (current === null || typeof current !== 'object' || current instanceof Date) return current;
    if (active.has(current)) throw conversionError(kind, 'Cyclic values cannot be converted.', path, undefined, kind === LibErrorKind.Deserialization);
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (clone) return current.map((item, index) => at(item, index, true));
        current.forEach((item, index) => at(item, index, false));
        return current;
      }
      const definition = findGeneratedModelDefinition(current);
      if (definition) {
        // Existing model instances retain identity, but their declared graph still needs checking.
        for (const field of definition.fields) at(Reflect.get(current, field), field, false);
        if (definition.additionalProperties) {
          const known = new Set(definition.fields);
          for (const [name, item] of Object.entries(current)) {
            if (!known.has(name)) at(item, name, false);
          }
        }
        return current;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return current;
      if (clone) {
        // Snapshot before descending: callbacks/accessors in a later branch cannot
        // change which values this operation copies. Spread defines own data
        // properties, including __proto__, without invoking inherited setters.
        const result: Record<string, unknown> = Object.getOwnPropertySymbols(current).length === 0
          ? { ...current }
          : Object.fromEntries(Object.entries(current));
        for (const name of Object.keys(result)) {
          const item = result[name];
          if (item !== null && typeof item === 'object') result[name] = at(item, name, true);
        }
        return result;
      }
      for (const [name, item] of Object.entries(current)) at(item, name, false);
      return current;
    } finally { active.delete(current); }
  };
  return visit(value, copy);
}

function decodeGeneratedModelValue(
  constructor: GeneratedModelConstructor,
  value: unknown,
  isolate: boolean,
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
    const isolated = isolate && value !== null && typeof value === 'object' ? cloneConversionInput(value) : value;
    const decoded = conversion.decode(isolated, constructor);
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
 * Nested generated-model decode after the caller isolated input or produced a
 * detached tree (`JSON.parse`, cloned `fromWireFormat` root). Application code
 * should keep using `decodeGeneratedModel`.
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
