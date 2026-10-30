import type { ModelConstraint } from '../model-registry.js';
import { DURATION_PATTERN, PLAIN_DATE_TIME_PATTERN, PLAIN_TIME_PATTERN, ZONED_DATE_TIME_PATTERN } from '../temporal-wire.js';
import { code, type Code } from './code.js';
import type { ModelConversionDescriptor, SerdeResolver } from './model-source-emitter.js';
import { rt } from './rt.js';

/**
 * The classes that golem converts with no TSerde tag from the user: one entry for each class of the global scope, keyed by its qualified name
 * (`Temporal.Instant`). The type analysis finds an entry by the declaration of a field's type (`findBuiltinClass`), and the generators find it by its
 * serde id or its OpenAPI format. An entry holds the whole rule of its class: a field of a user type with a TSerde tag never reaches the registry.
 */
export interface BuiltinClass {
  /** The name of the class in the global scope; also the type that generated code writes. */
  readonly qualifiedName: string;
  /** The id of the serde binding in a descriptor. It names a codec of the runtime, so no function of the user's is imported. */
  readonly serdeId: string;
  readonly type: Code;
  /** The wire form of a plain field, with the format or pattern constraint that the codec checks. */
  readonly wire: ModelConversionDescriptor;
  readonly serialize: Code;
  readonly deserialize: Code;
  /** The class below `globalThis`, which the instance check of a field looks up. */
  readonly classPath: readonly string[];
  /** The `format` of a string schema that an OpenAPI document with `dates: temporal` converts to this class. */
  readonly openApiFormat?: string;
  /**
   * The name of a validity predicate (`INSTANCE_VALIDITY` in `validation-runtime.ts`) that an instance of the class must also pass: an
   * instance can be of the class and hold no value (`new Date(NaN)`). It travels in the `serde` of the descriptor, as data.
   */
  readonly valid?: string;
}

type TemporalClassName = 'Instant' | 'ZonedDateTime' | 'PlainDate' | 'PlainDateTime' | 'PlainTime' | 'Duration';

const wireOf = (constraint: ModelConstraint): ModelConversionDescriptor => ({ kind: 'string', constraints: [constraint] });

/** Each wire type states its rule once, as `temporal.ts` does: a JSON Schema format, or a pattern where no format matches the text Temporal writes. */
function temporalClass(name: TemporalClassName, type: Code, wire: ModelConstraint, openApiFormat?: string): BuiltinClass {
  return {
    qualifiedName: `Temporal.${name}`,
    serdeId: `temporal:Temporal${name}`,
    type,
    wire: wireOf(wire),
    serialize: rt.temporal[`serializeTemporal${name}` as const],
    deserialize: rt.temporal[`deserializeTemporal${name}` as const],
    classPath: ['Temporal', name],
    ...(openApiFormat === undefined ? {} : { openApiFormat }),
  };
}

const BUILTIN_CLASS_LIST: readonly BuiltinClass[] = [
  {
    qualifiedName: 'Date',
    serdeId: 'date',
    type: code`Date`,
    wire: wireOf({ kind: 'format', value: 'date-time' }),
    serialize: rt.conversion.serializeDate,
    deserialize: rt.conversion.deserializeDate,
    classPath: ['Date'],
    valid: 'finiteTime',
  },
  temporalClass('Instant', code`Temporal.Instant`, { kind: 'format', value: 'date-time' }, 'date-time'),
  temporalClass('ZonedDateTime', code`Temporal.ZonedDateTime`, { kind: 'pattern', value: ZONED_DATE_TIME_PATTERN }),
  temporalClass('PlainDate', code`Temporal.PlainDate`, { kind: 'format', value: 'date' }, 'date'),
  temporalClass('PlainDateTime', code`Temporal.PlainDateTime`, { kind: 'pattern', value: PLAIN_DATE_TIME_PATTERN }),
  temporalClass('PlainTime', code`Temporal.PlainTime`, { kind: 'pattern', value: PLAIN_TIME_PATTERN }),
  temporalClass('Duration', code`Temporal.Duration`, { kind: 'pattern', value: DURATION_PATTERN }, 'duration'),
];

export const BUILTIN_CLASSES: ReadonlyMap<string, BuiltinClass> = new Map(BUILTIN_CLASS_LIST.map((entry) => [entry.qualifiedName, entry]));

const BY_SERDE_ID: ReadonlyMap<string, BuiltinClass> = new Map(BUILTIN_CLASS_LIST.map((entry) => [entry.serdeId, entry]));
const BY_OPENAPI_FORMAT: ReadonlyMap<string, BuiltinClass> = new Map(BUILTIN_CLASS_LIST.flatMap((entry) => entry.openApiFormat === undefined ? [] : [[entry.openApiFormat, entry]]));

export function builtinClassBySerdeId(id: string): BuiltinClass | undefined {
  return BY_SERDE_ID.get(id);
}

/** The class that `dates: temporal` converts a string schema of this `format` to. */
export function builtinClassByOpenApiFormat(format: string): BuiltinClass | undefined {
  return BY_OPENAPI_FORMAT.get(format);
}

/** The descriptor of a field of the class. A generator whose document states the wire form itself passes its own `wire`. */
export function builtinClassDescriptor(entry: BuiltinClass, wire: ModelConversionDescriptor = entry.wire): ModelConversionDescriptor {
  return { kind: 'class-value', typeName: entry.qualifiedName, classRef: { path: entry.classPath }, serde: { id: entry.serdeId, wireDescriptor: wire, ...(entry.valid === undefined ? {} : { valid: entry.valid }) } } as unknown as ModelConversionDescriptor;
}

/**
 * Calls the codec of the runtime that a built-in serde id names. Conversion code holds values as `unknown`; wire validation has
 * already checked them, so the call casts. The codec is a runtime part, so the file imports exactly the codecs it calls.
 */
export const BUILTIN_SERDE: SerdeResolver = {
  deserialize: (id, value) => code`${builtinClassOfSerde(id).deserialize}((${value}) as never)`,
  serialize: (id, value) => code`${builtinClassOfSerde(id).serialize}((${value}) as never)`,
};

function builtinClassOfSerde(id: string): BuiltinClass {
  const entry = BY_SERDE_ID.get(id);
  if (entry === undefined) throw new Error(`Unexpected serde id in a generated SDK: ${id}`);
  return entry;
}
