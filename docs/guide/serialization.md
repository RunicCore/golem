# Serialization

Convert models and plain objects to and from JSON, with or without validation.

These calls convert a named [`IObject` or `IModel`](/guide/models#iobject-or-imodel).

- `stringify<T>` and `parse<T>` use JSON text.
- `toWireFormat<T>` and `fromWireFormat<T>` use a plain object.
- A `TSerde` serialize formatter changes that field's JSON value.

## Convert to and from JSON

<<< ../../examples/models/src/estimate.model.ts#money-model

<<< ../../examples/models/src/estimate-json.ts#iobject-json

<<< ../../examples/models/src/read-json.ts#read-json

::: info ttsc
`parse`, `stringify`, `fromWireFormat` and `toWireFormat` throw unless `@exprtlabs/golem/ttsc-plugin` rewrites them. Compile with TypeScript 7 and `ttsc` 0.30.x; `tsc` does not run that transform.
:::

- The type argument selects the model.
- `T` must be a named generated `IObject` or `IModel`. An inline object type is not enough.
- [Unsupported unions](/guide/model-composition#unions) fail generation.

With validation on, the default, these calls check the value with Ajv. `{ validate: false }` skips that check. `failFast: false` reports every issue instead of the first one. It does not turn Ajv off.

`validate<T>(value)` from `@exprtlabs/golem/validation` narrows `value` to that model. `validateInstance(model)` returns the issue list and does not throw for an ordinary invalid value.

`parse<TMoney>` returns a plain object; `parse<Task>` returns a `Task`.
`new Task(parse<TTask>(text))` parses an IObject and passes it to the `Task` constructor; use it when the constructor takes extra arguments. Nested fields follow the field type, not the root type argument.

`JSON.stringify(model)` does not run conversion or validation.

`fromWireFormat` and `parse` copy objects, maps (`Record<string, V>`) and arrays, and read each declared property once, so a getter runs once. Values typed `unknown` or `any`, including the undeclared properties of an open object, are carried by reference: the result holds the same object as the input. `decodeGeneratedModel` copies nothing: fields without conversion are the input's own values. Cyclic input throws `LibError` of kind `deserialization`.

Do not write `stringify(toWireFormat(x))` or `fromWireFormat(parse(text))` on the JSON path. `stringify` writes JSON for the declared fields, applying each `TSerde` serialize formatter. `parse` reads that JSON back.

## Validation during conversion

| Call | Checks JSON | Converts | Checks model |
| --- | --- | --- | --- |
| `parse<T>(text)` | ✓ | ✓ | ✓ |
| `parse<T>(text, { validate: false })` | | ✓ | |
| `stringify<T>(value)` | ✓ | ✓ | ✓ |
| `stringify<T>(value, { validate: false })` | | ✓ | |
| `fromWireFormat<T>(wire)` | ✓ | ✓ | ✓ |
| `toWireFormat<T>(value)` | ✓ | ✓ | ✓ |
| `validate<T>(value)` | | | ✓ |

Each rule runs once; your decoders only see values that passed the JSON check.

`failFast: false` throws with every issue. `validate<T>(value)` returns whether the value matches, without throwing. `validateInstance(model)` returns the issues.

When `validation` is off, generated output has no Ajv. `{ validate: true }` then throws `LibErrorKind.ValidationUnavailable`, described in the [runtime reference](/reference/runtime-api#errors). `{ validate: false }` skips the check for data you already trust.

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models)
