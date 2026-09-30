import type { Format, Pattern, TSerde } from './tags.js';
import { activeConversionPath, conversionError } from './conversion-error.js';
import { LibErrorKind } from './errors.js';

type TemporalNamespace = typeof Temporal; // from lib esnext.temporal
type TemporalClassName = 'Instant' | 'ZonedDateTime' | 'PlainDate' | 'PlainDateTime' | 'PlainTime' | 'Duration';

const MISSING = 'Temporal is not available; load a polyfill such as `temporal-polyfill/global` before converting.';

function runtime(kind: LibErrorKind.Serialization | LibErrorKind.Deserialization): TemporalNamespace {
  const value = (globalThis as { Temporal?: TemporalNamespace }).Temporal;
  if (!value) throw conversionError(kind, MISSING);
  return value;
}

/** Wire forms. Years outside 0000-9999 (Temporal's ±YYYYYY form) are rejected. */
export type TemporalInstantWire = string & Format<'date-time'>;
export type TemporalZonedDateTimeWire = string & Pattern<'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})\\[[A-Za-z0-9_+\\-/:]+\\]$'>;
export type TemporalPlainDateWire = string & Format<'date'>;
export type TemporalPlainDateTimeWire = string & Pattern<'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$'>;
export type TemporalPlainTimeWire = string & Pattern<'^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$'>;
/** Temporal's own `toString()` form: a sign, weeks mixed with other units, and up to nine fractional-second digits. */
export type TemporalDurationWire = string & Pattern<'^-?P(?!$)(?:\\d+Y)?(?:\\d+M)?(?:\\d+W)?(?:\\d+D)?(?:T(?=\\d)(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d{1,9})?S)?)?$'>;

function codec<Model extends { toString(): string }, Wire extends string>(className: TemporalClassName) {
  return {
    serialize(value: Model): Wire {
      const Class = runtime(LibErrorKind.Serialization)[className] as unknown as abstract new (...args: never[]) => Model;
      if (!(value instanceof Class)) throw conversionError(LibErrorKind.Serialization, `Expected a Temporal.${className}.`);
      return value.toString() as Wire;
    },
    deserialize(value: Wire): Model {
      const Class = runtime(LibErrorKind.Deserialization)[className] as unknown as { from(text: string): Model };
      try { return Class.from(value); }
      catch (cause) { throw conversionError(LibErrorKind.Deserialization, `Expected a Temporal.${className} string.`, activeConversionPath, cause, true); }
    },
  };
}

// The generator binds `typeof` to exported function declarations, so each class gets its own pair.
const instant = codec<Temporal.Instant, TemporalInstantWire>('Instant');
export function serializeTemporalInstant(value: Temporal.Instant): TemporalInstantWire { return instant.serialize(value); }
export function deserializeTemporalInstant(value: TemporalInstantWire): Temporal.Instant { return instant.deserialize(value); }
export type TemporalInstant = Temporal.Instant & TSerde<typeof serializeTemporalInstant, typeof deserializeTemporalInstant>;

const zonedDateTime = codec<Temporal.ZonedDateTime, TemporalZonedDateTimeWire>('ZonedDateTime');
export function serializeTemporalZonedDateTime(value: Temporal.ZonedDateTime): TemporalZonedDateTimeWire { return zonedDateTime.serialize(value); }
export function deserializeTemporalZonedDateTime(value: TemporalZonedDateTimeWire): Temporal.ZonedDateTime { return zonedDateTime.deserialize(value); }
export type TemporalZonedDateTime = Temporal.ZonedDateTime & TSerde<typeof serializeTemporalZonedDateTime, typeof deserializeTemporalZonedDateTime>;

const plainDate = codec<Temporal.PlainDate, TemporalPlainDateWire>('PlainDate');
export function serializeTemporalPlainDate(value: Temporal.PlainDate): TemporalPlainDateWire { return plainDate.serialize(value); }
export function deserializeTemporalPlainDate(value: TemporalPlainDateWire): Temporal.PlainDate { return plainDate.deserialize(value); }
export type TemporalPlainDate = Temporal.PlainDate & TSerde<typeof serializeTemporalPlainDate, typeof deserializeTemporalPlainDate>;

const plainDateTime = codec<Temporal.PlainDateTime, TemporalPlainDateTimeWire>('PlainDateTime');
export function serializeTemporalPlainDateTime(value: Temporal.PlainDateTime): TemporalPlainDateTimeWire { return plainDateTime.serialize(value); }
export function deserializeTemporalPlainDateTime(value: TemporalPlainDateTimeWire): Temporal.PlainDateTime { return plainDateTime.deserialize(value); }
export type TemporalPlainDateTime = Temporal.PlainDateTime & TSerde<typeof serializeTemporalPlainDateTime, typeof deserializeTemporalPlainDateTime>;

const plainTime = codec<Temporal.PlainTime, TemporalPlainTimeWire>('PlainTime');
export function serializeTemporalPlainTime(value: Temporal.PlainTime): TemporalPlainTimeWire { return plainTime.serialize(value); }
export function deserializeTemporalPlainTime(value: TemporalPlainTimeWire): Temporal.PlainTime { return plainTime.deserialize(value); }
export type TemporalPlainTime = Temporal.PlainTime & TSerde<typeof serializeTemporalPlainTime, typeof deserializeTemporalPlainTime>;

const duration = codec<Temporal.Duration, TemporalDurationWire>('Duration');
export function serializeTemporalDuration(value: Temporal.Duration): TemporalDurationWire { return duration.serialize(value); }
export function deserializeTemporalDuration(value: TemporalDurationWire): Temporal.Duration { return duration.deserialize(value); }
export type TemporalDuration = Temporal.Duration & TSerde<typeof serializeTemporalDuration, typeof deserializeTemporalDuration>;
