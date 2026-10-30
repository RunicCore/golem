import type { ImportedFunction, ModelConstraint, SerdeFunctions } from '../model-registry.js';
import { DURATION_PATTERN, PLAIN_DATE_TIME_PATTERN, PLAIN_TIME_PATTERN, ZONED_DATE_TIME_PATTERN } from '../temporal-wire.js';
import { code, type Code } from './code.js';
import type { ModelConversionDescriptor } from './model-source-emitter.js';
import { runtimeFunction } from './rt.js';

/** The `dates` values of an OpenAPI generation, which pick the class that a `date-time` string converts to. */
export type OpenApiDatesMode = 'date' | 'temporal';

/**
 * The classes that golem converts with no TSerde tag from the user: one entry for each class of the global scope, keyed by its qualified name
 * (`Temporal.Instant`). An entry is a default TSerde binding: the pair of functions that a TSerde tag names, here two functions of the golem runtime.
 * The type analysis finds an entry by the declaration of a field's type (`findBuiltinClass`), and an OpenAPI generation by the `format` of a string
 * schema. Nothing else reads the table: a descriptor carries its binding, and every generator resolves a binding the same way. A field of a user type
 * with a TSerde tag never reaches it.
 */
export interface BuiltinClass {
  /** The name of the class in the global scope; also the type that generated code writes. */
  readonly qualifiedName: string;
  readonly type: Code;
  /** The wire form of a plain field, with the format or pattern constraint that the codec checks. */
  readonly wire: ModelConversionDescriptor;
  /** The binding. `valid` tells an instance that holds no value (`new Date(NaN)`), which the class check calls after `instanceof`. */
  readonly serde: SerdeFunctions & { readonly valid?: ImportedFunction };
  /** The class below `globalThis`, which the instance check of a field looks up. */
  readonly classPath: readonly string[];
  /** The `format` of a string schema that an OpenAPI document converts to this class, by the `dates` value that picks the class. */
  readonly openApiFormat?: Readonly<Partial<Record<OpenApiDatesMode, string>>>;
}

type TemporalClassName = 'Instant' | 'ZonedDateTime' | 'PlainDate' | 'PlainDateTime' | 'PlainTime' | 'Duration';

const wireOf = (constraint: ModelConstraint): ModelConversionDescriptor => ({ kind: 'string', constraints: [constraint] });

/** The id of a serde is the ids of its two functions, as a TSerde tag makes it. */
function serdeOf(serialize: ImportedFunction, deserialize: ImportedFunction): SerdeFunctions {
  return { id: `${serialize.id}\0${deserialize.id}`, serialize, deserialize };
}

/** Each wire type states its rule once, as `temporal.ts` does: a JSON Schema format, or a pattern where no format matches the text Temporal writes. */
function temporalClass(name: TemporalClassName, type: Code, wire: ModelConstraint, format?: string): BuiltinClass {
  return {
    qualifiedName: `Temporal.${name}`,
    type,
    wire: wireOf(wire),
    serde: serdeOf(runtimeFunction('temporal', `serializeTemporal${name}`), runtimeFunction('temporal', `deserializeTemporal${name}`)),
    classPath: ['Temporal', name],
    ...(format === undefined ? {} : { openApiFormat: { temporal: format } }),
  };
}

const BUILTIN_CLASS_LIST: readonly BuiltinClass[] = [
  {
    qualifiedName: 'Date',
    type: code`Date`,
    wire: wireOf({ kind: 'format', value: 'date-time' }),
    serde: { ...serdeOf(runtimeFunction('conversion', 'serializeDate'), runtimeFunction('conversion', 'deserializeDate')), valid: runtimeFunction('validation-runtime', 'hasFiniteTime') },
    classPath: ['Date'],
    openApiFormat: { date: 'date-time' },
  },
  temporalClass('Instant', code`Temporal.Instant`, { kind: 'format', value: 'date-time' }, 'date-time'),
  temporalClass('ZonedDateTime', code`Temporal.ZonedDateTime`, { kind: 'pattern', value: ZONED_DATE_TIME_PATTERN }),
  temporalClass('PlainDate', code`Temporal.PlainDate`, { kind: 'format', value: 'date' }, 'date'),
  temporalClass('PlainDateTime', code`Temporal.PlainDateTime`, { kind: 'pattern', value: PLAIN_DATE_TIME_PATTERN }),
  temporalClass('PlainTime', code`Temporal.PlainTime`, { kind: 'pattern', value: PLAIN_TIME_PATTERN }),
  temporalClass('Duration', code`Temporal.Duration`, { kind: 'pattern', value: DURATION_PATTERN }, 'duration'),
];

export const BUILTIN_CLASSES: ReadonlyMap<string, BuiltinClass> = new Map(BUILTIN_CLASS_LIST.map((entry) => [entry.qualifiedName, entry]));

const MODES: readonly OpenApiDatesMode[] = ['date', 'temporal'];
/** One table for both `dates` values: the class that a string `format` converts to, by the value. */
const BY_OPENAPI_FORMAT: ReadonlyMap<OpenApiDatesMode, ReadonlyMap<string, BuiltinClass>> = new Map(MODES.map((mode) => [
  mode,
  new Map(BUILTIN_CLASS_LIST.flatMap((entry) => {
    const format = entry.openApiFormat?.[mode];
    return format === undefined ? [] : [[format, entry] as const];
  })),
]));

/** The class that the `dates` value converts a string schema of this `format` to. */
export function builtinClassByOpenApiFormat(dates: OpenApiDatesMode, format: string): BuiltinClass | undefined {
  return BY_OPENAPI_FORMAT.get(dates)?.get(format);
}

/** The descriptor of a field of the class. A generator whose document states the wire form itself passes its own `wire`. */
export function builtinClassDescriptor(entry: BuiltinClass, wire: ModelConversionDescriptor = entry.wire): ModelConversionDescriptor {
  return { kind: 'class-value', typeName: entry.qualifiedName, classRef: { path: entry.classPath }, serde: { ...entry.serde, wireDescriptor: wire } } as unknown as ModelConversionDescriptor;
}
