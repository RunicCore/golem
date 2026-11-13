# Field types

Pick the TypeScript shape of a field and see how golem constructs, converts and validates it.

## Scalars, arrays and objects

| TypeScript shape | Runtime and JSON |
| --- | --- |
| `string`, `number`, `boolean`, `null`, `undefined` | stored as is |
| `bigint` | needs a [`TSerde`](/guide/serialization#change-the-json-form) codec |
| string, number and boolean literals | kept and checked |
| arrays and tuples | items convert recursively; tuple length and optional or rest positions are checked |
| object types | known properties convert; extra properties fail validation unless [`exact` is `false`](#objects-and-exact) |
| intersections | the fields merge |
| unions | [supported unions](#unions) |
| a declaration alias, such as `TPlace` | a nested plain object, still converted |
| your class, such as `Place` | a nested instance of that class |
| `Date` | an ISO date-time string in JSON, restored with `Date` parsing |
| `Temporal.Instant`, `Temporal.PlainDate` and the other Temporal classes, or the [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal) types `TemporalInstant`, `TemporalPlainDate` and so on | an ISO 8601 string in JSON ([Dates and times](#dates-and-times)) |
| a [recursive type alias](#recursive-type-aliases) | converted and validated at every level |
| `any`, `unknown` | accepted only when [`allowAny` is `true`](#any-and-unknown) |

An `undefined` property is left out of JSON. `bigint` needs a codec that writes it as JSON, such as a string. Without one, `stringify` rejects it.

[Validation tags](/guide/tags) add checks to these shapes, such as `MinLength` on a string. A `Date` is always checked as an ISO date-time string in JSON. On a model field, `Format` applies to a string ([Formats](/guide/tags#formats)), so use [`TValidation`](/guide/tags#add-a-custom-field-rule) for your own rule on a `Date`.

## Dates and times

Hold dates in models and the SDK as `Date` or as Temporal values, and send them as ISO 8601 strings.

`Date` and the Temporal classes are built-in [`TSerde`](/guide/serialization#change-the-json-form) types. Golem gives each class a default pair of functions, as a `TSerde` tag does. A field typed `Date` or `Temporal.Instant` needs no tag, and a `TSerde` tag on the same type replaces the default.

<<< ../../examples/models/src/reminder.model.ts#date-field

### Use Date fields

A `Date` field is an ISO date-time string in JSON. `parse` and `fromWireFormat` restore it as a `Date`, and `stringify` and `toWireFormat` write it back.

<<< ../../examples/models/src/read-reminder.ts#read-reminder

Golem writes a `Date` in UTC with milliseconds. A reader that gets `"2026-01-02T10:00:00Z"` holds a `Date` and writes back `"2026-01-02T10:00:00.000Z"`. A string with an offset, such as `+02:00`, is converted to UTC and written with `Z`. The `Date` keeps the moment, not the original text.

- To keep the exact text, declare the field as `string & Format<'date-time'>`. The value stays a string, and golem checks that it is a date-time ([Formats](/guide/tags#formats)).
- To write another form, declare it as `Date & TSerde<typeof encode, typeof decode>`. Your `encode` function writes the text and `decode` reads it ([change the JSON form](/guide/serialization#change-the-json-form)). The text comes from the `Date`, so it fits a fixed form, such as seconds with no milliseconds.

### Use Temporal fields

Declare a field with a type from [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal). Each type holds its `Temporal` class in the model and an ISO 8601 string in JSON.

You can also write the class itself: `Temporal.Instant`, `Temporal.ZonedDateTime`, `Temporal.PlainDate`, `Temporal.PlainDateTime`, `Temporal.PlainTime` or `Temporal.Duration`. It converts to the same JSON string as the matching type.

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

### Check a Date or Temporal field

Validation checks the model value of a `Date` or Temporal field with `instanceof`.

- A value of another type fails with one [`instance` issue](/reference/runtime-api#errors) at the field path. For a `Date`, the message is `Expected an instance of Date`.
- An invalid `Date`, such as `new Date(NaN)`, fails in the same way.
- Decoding reads a string only. Another JSON value throws `Deserialization` at every validation level, off included.
- The JSON value is checked as a `date-time` string for a `Date`, or as the form of the class for a Temporal field.

### Use Temporal values in a client

Set `dates: temporal` on the [SDK job](/reference/config#openapi-ts-block). The generated client then maps `format: date-time` to `Temporal.Instant`, `format: date` to `Temporal.PlainDate` and `format: duration` to `Temporal.Duration`. Without the key, the same fields are `Date` values.

With `dates: temporal`, `format: duration` means the Temporal form in every position of the document. It accepts the text that `Temporal.Duration` writes, such as `PT0.5S`, `PT1H30S` and `P1Y2D`. Without `dates: temporal`, a `duration` string must follow the RFC 3339 format, which has no fractional seconds.

<<< ../../examples/payments/server/golem.yaml#openapi-dates-job

The client converts the JSON strings for you, so the response `body` holds the Temporal values:

<<< ../../examples/payments/server/provider/settlement.ts#read-dates

A model of your own over the SDK type writes the strings back with `toWireFormat`:

<<< ../../examples/payments/server/provider/settlement.ts#write-dates

`format: time` stays a string. A `Temporal.Instant` is written with `Z`, so an offset in the original string is not kept. The generated client needs the same `esnext.temporal` setting, or `skipLibCheck: true`, and a loaded `Temporal`.

## Objects and exact

The second type argument of `IModel` and `IObject` sets two options for that declaration. `exact` controls extra properties. `allowAny` controls `any` and `unknown`.

<<< ../../examples/models/src/metadata.model.ts#exact-and-any

### The options exact and allowAny

| Option | Default | Where you set it | Effect |
| --- | --- | --- | --- |
| `exact` | `true` | The root of `golem.yaml` for every model, or the options of one `IObject` or `IModel` | `true`: an extra property fails validation, also in a nested plain object. `false`: a key that the model does not list is admitted. |
| `allowAny` | `false` | The root of `golem.yaml` for every model, or the options of one `IObject` or `IModel` | `false`: a field typed `any` or `unknown` fails with [`RUNM1011`](/reference/diagnostics#runm1011). `true`: the field is allowed ([`any` and `unknown`](#any-and-unknown)). |

- The option on the declaration overrides `golem.yaml`, and `golem.yaml` overrides the default. `{ allowAny: false }` tightens a permissive `golem.yaml`.
- A docs job reads the types that a controller signature spells out, such as an inline body, with `exact: false`, whatever `golem.yaml` says. A model that a signature names keeps its own `exact` ([derived type names](/reference/generated-files#derived-type-names)).
- A key on an instance that its model does not declare is program state, not an extra property. Codecs never report it as an unknown key and never write it to JSON, also inside an `unknown` or `any` field.
- Input from JSON or a request stays exact. Constructors assign declared fields only.
- To decode input that holds more keys than the model declares, such as `process.env` or the headers of a request, pass `{ strip: true }` to `parse` or `fromWireFormat`. `stringify` and `toWireFormat` take it too, for a value with an extra key, such as a database row. A closed object then loses each key that it does not declare, at every level, and the check passes. A map, an `AdditionalProperties` tag, `PatternProperties` and an object with `exact: false` keep their extra keys. A union of objects that has a `Discriminator` tag picks the variant by the tag first ([`strip`](/reference/runtime-api#strip)).

## Nested models and derived types

A field typed with your class, such as `office: Place`, holds an instance of that class. A field typed with the declaration alias (`TPlace`) holds a plain object. `Pick`, `Omit`, `Partial`, `Required` and `Readonly` produce a derived type as a plain object.

<<< ../../examples/models/src/assignee.model.ts#nested-and-derived

A derived type keeps field conversion and validation.

A derived type is exact by default, like any model. Put a whole-object [`TValidation`](/guide/tags#add-a-custom-field-rule) predicate or [`TSerde`](/guide/serialization#change-the-json-form) formatter on the derived type itself. Do not reuse one that you wrote for another shape.

## Unions

Golem converts the unions below.

Supported without a tag:

- scalar types only, such as `string | number`, and literal unions, such as `'paid' | 'pending'`
- optional and nullish values: `T | undefined`, `T | null`
- one object, model or class beside scalars: `string | TPlace`
- strings, numbers, booleans or literals beside one array or one tuple, as in query objects (`status?: Status | Status[]`). The items can convert: `string | Date[]`. A Date can be the only scalar beside the array: `Date | Date[]`, `Date | string[]`
- a model beside an array of that model: `TPlace | TPlace[]`
- strings, numbers, booleans or literals beside one array and one object or model: `string | string[] | TPlace`. The `JsonValue` alias under [Recursive type aliases](#recursive-type-aliases) has this shape

A union of two or more objects needs a declared tag, as the next section shows.

### Declare the tag of an object union

An object union names its tag key in the type with [`Discriminator`](/guide/tags#name-the-tag-of-a-union). Golem reads that key and no other. The variants can be object types, models, `IObject` types, SDK models or records.

<<< ../../examples/models/src/contact.model.ts#discriminated-union

- Put `Discriminator<'kind'>` on the union. Import it from `@exprtlabs/golem/tags`.
- Declare `kind` in each variant as a required literal type, or as a union of literals.
- Give each variant values of its own. Two variants cannot share a value.
- The tag does not change the TypeScript type. Your code sees the same union.
- A union without the tag stops generation with [`RUNM1080`](/reference/diagnostics#runm1080). A variant without the key, or a shared value, stops it with [`RUNM1087`](/reference/diagnostics#runm1087).

The tag works at every position: a field, an optional field, an array item, a record value and a tuple item. Write it on the union itself or on an alias of the union. Write `null` outside the tag, and put an array of tagged unions in parentheses:

<<< ../../examples/models/src/contact.model.ts#union-tag-forms

- TypeScript reduces `null & Discriminator<'kind'>` to `never`. `(TEmail | TPhone | null) & Discriminator<'kind'>` therefore loses `null`.
- `others` above is an array of the tagged union: the parentheses wrap the union and its tag, and the brackets follow.

Scalars, literals, one `Date`, one array or tuple, and `null` can sit beside the tagged objects, as in `(string | TEmail | TPhone) & Discriminator<'kind'>`. So can a [`TSerde`](/guide/tags) class value whose JSON form is a scalar, such as a `URL` written as a string. Golem picks a variant in this order:

1. The JSON type of the value picks a scalar, an array or `null`.
2. For an object, the value of `kind` picks the variant.
3. An object whose `kind` is missing or matches no variant is an error, unless the tag names a [default variant](/guide/tags#name-the-tag-of-a-union).

## Recursive type aliases

A type alias can refer to itself, in any shape: a union, an array, a tuple or a record. Golem generates one function for the alias, so a recursive alias needs no model around it. For example, `type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }` is a valid field type, as in `IModel<{ payload: JsonValue }>`.

Use the alias as a field type, as an optional field or as an array item. Golem validates and converts every level. `stringify` and `toWireFormat` throw an error for a value that contains itself.

A type alias that does not refer to itself stays part of the field type. A recursive alias that holds a `Date` or a model converts the `Date` or the model at every level. A cycle that golem cannot name stops generation with [`RUNM1056`](/reference/diagnostics#runm1056).

## `any` and `unknown`

A field typed `any` or `unknown` fails unless `allowAny` is `true` ([the options table](#the-options-exact-and-allowany)). The `TIntegrationEvent` declaration above sets it for one model.

- `allowAny: true` skips inferred structure and conversion for that field.
- Explicit tags still run, and the JSON value must still be representable as JSON.
- Neither `allowAny` nor `exact` changes which fields `toWireFormat` emits.
- A referenced model keeps its own policy.

Full examples: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models) and [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
