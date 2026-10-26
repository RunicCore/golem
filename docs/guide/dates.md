# Dates and times

Hold dates in models and API clients as `Date` or as Temporal values, and send them as ISO 8601 strings.

<<< ../../examples/models/src/reminder.model.ts#date-field

## Use Date fields

A `Date` field is an ISO date-time string in JSON. `parse` and `fromWireFormat` restore it as a `Date`, and `stringify` and `toWireFormat` write it back.

<<< ../../examples/models/src/read-reminder.ts#read-reminder

Golem writes a `Date` in UTC with milliseconds. A reader that gets `"2026-01-02T10:00:00Z"` holds a `Date` and writes back `"2026-01-02T10:00:00.000Z"`. A string with an offset, such as `+02:00`, is converted to UTC and written with `Z`. The `Date` keeps the moment, not the original text.

- To keep the exact text, declare the field as `string & Format<'date-time'>`. The value stays a string, and golem checks that it is a date-time ([Formats](/guide/tags#formats)).
- To write another form, declare it as `Date & TSerde<typeof encode, typeof decode>`. Your `encode` function writes the text and `decode` reads it ([change the JSON form](/guide/serialization#change-the-json-form)). The text comes from the `Date`, so it fits a fixed form, such as seconds with no milliseconds.

## Use Temporal fields

Declare a field with a type from [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal). Each type holds its `Temporal` class in the model and an ISO 8601 string in JSON.

<<< ../../examples/models/src/schedule.model.ts#temporal-fields

- Add `"esnext.temporal"` to `compilerOptions.lib` in `tsconfig.json`.
- Load a `Temporal` before converting. Install `temporal-polyfill` and import `temporal-polyfill/global` once, before the first conversion. Without a `Temporal`, conversion fails with "Temporal is not available".

<<< ../../examples/models/src/read-schedule.ts#read-schedule

| Field type | Model value | JSON |
| --- | --- | --- |
| `TemporalInstant` | `Temporal.Instant` | `2025-01-02T03:04:05Z` |
| `TemporalPlainDate` | `Temporal.PlainDate` | `2025-01-02` |
| `TemporalDuration` | `Temporal.Duration` | `PT1H30M` |

A `Temporal` value is written in its own `toString()` form. A `TemporalInstant` shows fractional seconds only when it has them, for example `2025-01-02T03:04:05.250Z`.

`TemporalZonedDateTime`, `TemporalPlainDateTime` and `TemporalPlainTime` work the same way.

## Use Temporal values in a client

Set `dates: temporal` on the [OpenAPI job](/reference/config#openapi-jobs). The generated model classes then map `format: date-time` to `Temporal.Instant`, `format: date` to `Temporal.PlainDate` and `format: duration` to `Temporal.Duration`. Without the key, the same fields are `Date` values.

<<< ../../examples/payments/server/golem.yaml#openapi-dates-job

The response `body` keeps the JSON strings. Import `fromWireFormat` from `@exprtlabs/golem/serde` and the model class from the generated SDK. Convert the body with the model class to get Temporal values:

<<< ../../examples/payments/server/provider/settlement.ts#read-dates

Building the model class and calling `toWireFormat` writes the strings back:

<<< ../../examples/payments/server/provider/settlement.ts#write-dates

`format: time` stays a string. A `Temporal.Instant` is written with `Z`, so an offset in the original string is not kept. The generated client needs the same `esnext.temporal` setting and a loaded `Temporal`.

Full examples: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models) and [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
