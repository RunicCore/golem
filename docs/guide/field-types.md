# Field types

Pick the TypeScript shape of a field and see how golem constructs, converts and validates it.

## Scalars, arrays and objects

| TypeScript shape | Runtime and JSON |
| --- | --- |
| `string`, `number`, `boolean`, `null`, `undefined` | stored as is; an `undefined` property is left out of JSON |
| `bigint` | needs a [`TSerde`](/guide/serialization#change-the-json-form) codec that writes it as JSON, such as a string; without one, `stringify` rejects it |
| string, number and boolean literals | kept and checked |
| arrays and tuples | items convert recursively; tuple length and optional or rest positions are checked |
| object types | known properties convert; extra properties fail validation unless [`exact` is `false`](#objects-and-exact) |
| intersections | the fields merge |
| unions | [supported unions](#unions) |
| a declaration alias, such as `TPlace` | a nested plain object, still converted |
| your class, such as `Place` | a nested instance of that class |
| `Date` | an ISO date-time string in JSON, restored with `Date` parsing |
| `TemporalInstant`, `TemporalPlainDate` and the other [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal) types | an ISO 8601 string in JSON ([Dates and times](/guide/dates)) |
| a [recursive type alias](#recursive-type-aliases) | converted and validated at every level |
| `any`, `unknown` | accepted only when [`allowAny` is `true`](#any-and-unknown) |

[Validation tags](/guide/tags) add checks to these shapes, such as a format check on a `Date`.

## Objects and exact

The second type argument of `IModel` and `IObject` controls extra properties, `any` and `unknown`:

<<< ../../examples/models/src/metadata.model.ts#exact-and-any

`exact` defaults to `true`: extra properties fail validation, including in nested plain objects. A key on an instance that its model does not declare is program state, not an extra property. Codecs never report it as an unknown key and never write it to JSON, also inside an `unknown` or `any` field. Input from JSON or a request stays exact. Constructors assign declared fields only.

Set `exact: false` in `golem.yaml` to change the default for every model. The option on the declaration overrides `golem.yaml`, and `golem.yaml` overrides the default.

## Nested models and derived types

A field typed with your class, such as `office: Place`, holds an instance of that class. A field typed with the declaration alias (`TPlace`) holds a plain object. `Pick`, `Omit`, `Partial`, `Required` and `Readonly` produce a derived type as a plain object.

<<< ../../examples/models/src/assignee.model.ts#nested-and-derived

A derived type keeps field conversion and validation. It does not keep `Place` methods, constructor defaults or rules added with [`getValidator(model).extend()`](/guide/validation#instance-rules). `Readonly` keeps the TypeScript modifier and does not freeze the value.

A derived type is exact by default, like any model. Put a whole-object [`TValidation`](/guide/tags#add-a-custom-field-rule) predicate or [`TSerde`](/guide/serialization#change-the-json-form) formatter on the derived type itself. Do not reuse one that you wrote for another shape.

## Unions

Golem converts the unions below. Generation fails for any other union, because conversion never tries the variants one by one.

Supported:

- scalar types only, such as `string | number`, and literal unions, such as `'paid' | 'pending'`
- optional and nullish values: `T | undefined`, `T | null`
- one object, model or class beside scalars: `string | TPlace`
- strings, numbers, booleans or literals beside one array or one tuple, as in query objects (`status?: Status | Status[]`). The items can convert: `string | Date[]`
- a model beside an array of that model: `TPlace | TPlace[]`
- strings, numbers, booleans or literals beside one array and one object or model: `string | string[] | TPlace`. The `JsonValue` alias under [Recursive type aliases](#recursive-type-aliases) has this shape
- object unions with one unique, required literal discriminator
- an SDK model class (generated from an OpenAPI document) plus a primitive or a uniquely tagged object

A discriminated union of two models:

<<< ../../examples/models/src/contact.model.ts#discriminated-union

Generation fails for:

- a root `IModel` union such as `IModel<TEmail | TPhone>`: put the union in a field ([`RUNM1052`](/reference/diagnostics#runm1052))
- object unions without a unique required literal discriminator: give each variant a required literal field such as `kind: 'cat'` ([`RUNM1080`](/reference/diagnostics#runm1080))
- several undiscriminated SDK model classes, or an SDK model class plus an array, `any`, `unknown`, intersection or untagged object ([`RUNM1030`](/reference/diagnostics#runm1030))
- any other union that would need to probe alternatives ([`RUNM1082`](/reference/diagnostics#runm1082))

`Extract` and `Exclude` keep your class only when the selected branch is the unchanged named model. A structurally identical plain object does not gain its methods.

## Recursive type aliases

A type alias can refer to itself, in any shape: a union, an array, a tuple or a record. Golem generates one function for the alias, so a recursive alias needs no model around it. For example, `type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }` is a valid field type, as in `IModel<{ payload: JsonValue }>`.

Use the alias as a field type, as an optional field or as an array item. Golem validates and converts every level. `stringify` and `toWireFormat` throw an error for a value that contains itself.

A type alias that does not refer to itself stays part of the field type. A recursive alias that holds a `Date` or a model converts the `Date` or the model at every level. A cycle that golem cannot name stops generation with [`RUNM1056`](/reference/diagnostics#runm1056).

## `any` and `unknown`

A field typed `any` or `unknown` fails with [`RUNM1011`](/reference/diagnostics#runm1011) unless `allowAny` is `true`. The `TIntegrationEvent` declaration above sets it for one model. Set `allowAny: true` in `golem.yaml` to allow it in every model. The option on the declaration overrides `golem.yaml`, and `{ allowAny: false }` tightens a permissive `golem.yaml`.

`allowAny: true` skips inferred structure and conversion for that field. Explicit tags still run, and the JSON value must still be representable as JSON. Neither `allowAny` nor `exact` changes which fields `toWireFormat` emits. A referenced model keeps its own policy.

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models)
