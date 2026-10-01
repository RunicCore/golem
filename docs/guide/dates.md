# Dates and times

Hold dates in models and API clients as `Date` or as Temporal values, and send them as ISO 8601 strings.

<<< ../../examples/model/src/reminder.model.ts#date-field

## Use Date fields

A `Date` field is an ISO date-time string in JSON. `parse` and `fromWireFormat` restore it as a `Date`, and `stringify` and `toWireFormat` write it back.

<<< ../../examples/model/src/read-reminder.ts#read-reminder

Add format checks with [type tags](/guide/tags).

## Use Temporal fields

Declare a field with a type from [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal). Each type holds its `Temporal` class in the model and an ISO 8601 string in JSON.

<<< ../../examples/model/src/schedule.model.ts#temporal-fields

- Add `"esnext.temporal"` to `compilerOptions.lib` in `tsconfig.json`.
- Load a `Temporal` before converting. Install `temporal-polyfill` and import `temporal-polyfill/global` once, before the first conversion. Without a `Temporal`, conversion fails with "Temporal is not available".

<<< ../../examples/model/src/read-schedule.ts#read-schedule

| Field type | Model value | JSON |
| --- | --- | --- |
| `TemporalInstant` | `Temporal.Instant` | `2025-01-02T03:04:05Z` |
| `TemporalPlainDate` | `Temporal.PlainDate` | `2025-01-02` |
| `TemporalDuration` | `Temporal.Duration` | `PT1H30M` |

`TemporalZonedDateTime`, `TemporalPlainDateTime` and `TemporalPlainTime` work the same way.

## Use Temporal values in a client

Set `dates: temporal` on the [OpenAPI job](/reference/config#openapi-jobs). The generated model classes then map `format: date-time` to `Temporal.Instant`, `format: date` to `Temporal.PlainDate` and `format: duration` to `Temporal.Duration`. Without the key, the same fields are `Date` values.

<<< ../../examples/client-features/golem.yaml#openapi-dates-job

The response `body` keeps the JSON strings. Convert it with the generated model class to get Temporal values:

<<< ../../examples/client-features/src/payment-dates.ts#read-dates

Building the model class and calling `toWireFormat` writes the strings back:

<<< ../../examples/client-features/src/payment-dates.ts#write-dates

`format: time` stays a string. A `Temporal.Instant` is written with `Z`, so an offset in the original string is not kept. The generated client needs the same `esnext.temporal` setting and a loaded `Temporal`.

Full examples: [`examples/model`](https://github.com/RunicCore/golem/tree/master/examples/model) and [`examples/client-features`](https://github.com/RunicCore/golem/tree/master/examples/client-features)
