# JSON conversion

Convert models to and from JSON, and change the JSON form of a field.

## Convert to and from JSON

These calls convert a named [`IObject` or `IModel`](/guide/models#iobject-or-imodel).

- `stringify<T>` and `parse<T>` use JSON text.
- `toWireFormat<T>` and `fromWireFormat<T>` use a plain object.

<<< ../../examples/models/src/estimate.model.ts#money-model

<<< ../../examples/models/src/estimate-json.ts#iobject-json

<<< ../../examples/models/src/read-json.ts#read-json

The type argument picks the model and the result: `parse<TMoney>` returns a plain object, and `parse<Task>` returns a `Task`. `new Task(parse<TTask>(text))` parses an `IObject` and passes it to the `Task` constructor. Use it when the constructor takes extra arguments. Nested fields follow the field type, not the root type argument.

::: info Build with golem
`parse`, `stringify`, `fromWireFormat`, `toWireFormat`, `validate` and `assertValue` throw unless a build rewrote them. Choose a host in [Build your app](/guide/build). `tsc` does not rewrite them.
:::

- `T` must be a named generated `IObject` or `IModel`. An inline object type is not enough.
- [Unsupported unions](/guide/field-types#unions) fail generation.
- Write these calls in your own source files. Golem does not rewrite a call inside a generated `*.generated.ts` file, so it throws at run time.
- A class whose model has a dynamic map keeps the extra keys of the input and converts each by the type of the map value.

Do not write `stringify(toWireFormat(x))` or `fromWireFormat(parse(text))` on the JSON path. `stringify` writes JSON for the declared fields and applies each `TSerde` serialize formatter. `parse` reads that JSON back. `JSON.stringify(model)` does not run conversion or validation.

## Model value and JSON value

The model value is what your code holds. The JSON value is what `toWireFormat` returns and `stringify` writes. For most fields the two are equal. A `Date` is a `Date` in the model and an ISO string in JSON. A [`TSerde`](#change-the-json-form) field has the form that its functions give.

A `Date` decodes with ECMAScript `Date` parsing. A value that is not a string, or that does not parse, throws `Deserialization` with `causedByInput: true`. Put format rules on `Format<'date-time'>` or `TValidation`. A `Date` encodes as UTC ISO text with milliseconds. A year outside 0000-9999 throws `Serialization`. A function, a symbol or an array hole is not a JSON value and fails the JSON check.

`WireFormat<T>` names the JSON shape of a model. Generated JSON types end in `JSON`, such as `TTaskJSON`.

## Change the JSON form

`TSerde<typeof encode, typeof decode>` is a serialize formatter. `encode` turns the model value into its JSON value, and `decode` turns the JSON value back into the model value. Both are synchronous.

`TPermissionInput` is an `IModel`. `fromWireFormat<TPermissionInput>` returns a plain object, and `fromWireFormat<PermissionInput>` constructs your class.

<<< ../../examples/models/src/permission-rules.ts#serde-tag-fn

<<< ../../examples/models/src/permission-input.model.ts#serde-tag

- The same behavior applies when the field is nested.
- Declare the encoder and decoder in their own module, like a `TValidation` predicate. In a model file they are a generation error ([RUNM1065](/reference/diagnostics#runm1065)).
- `TSerde` functions run during conversion, never during generation.
- A function that throws is wrapped once in a `LibError` with the exception as its `cause`.
- An encoder must return JSON-compatible data. Non-finite numbers, cycles and other values that JSON cannot hold still fail with validation disabled.

## Which type controls validation

Here `PermissionWire` is a string tagged with a hexadecimal pattern, and the model stores `permissions` as a number:

| Declaration or option | Effect |
| --- | --- |
| `decodePermissions(value: PermissionWire)` | JSON validation includes the pattern. Generated validation checks it **before decoding and after encoding**. |
| Change the decoder parameter to `value: string` | JSON validation keeps the string type check but drops the pattern, even if the encoder still returns `PermissionWire`. |
| `permissions: number & Integer & Minimum<0> & …` | These are validation constraints on the model value. They run **after decoding and before encoding**, whether the decoder accepts plain `string` or not. |
| `{ validate: false }` | Runs only the `TSerde` serialize formatter, without checks. |

- The decoder parameter type defines the JSON schema.
- The encoder return type is checked for TypeScript compatibility. Tags on the return type alone add no JSON validation.
- A plain `string` parameter keeps the string check and drops the tagged validation constraints on the JSON value. This also applies to aliases such as `ProjectName = string & MinLength<3>`.
- A parameter typed `any` or `unknown` fails with [`RUNM1011`](/reference/diagnostics#runm1011) unless `allowAny` is `true`, in `golem.yaml` or in the options of the model. Type the parameter as the JSON value that the decoder reads.

Calling `encodePermissions()` or `decodePermissions()` directly runs only the function body. Type annotations do not perform runtime checks by themselves.

## Class values

A `TSerde` field can hold a class instance, such as `Uint8Array`, or a `bigint`. The codec does all the conversion, and validation checks the JSON value.

<<< ../../examples/models/src/base64-codec.ts#base64-codec

<<< ../../examples/models/src/attachment.model.ts#class-valued-field

Converting the model writes the JSON form and restores the instance:

<<< ../../examples/models/src/attachment-json.ts#attachment-json

- The class must have a name and have no type parameter without a default. A module must export it, under any name or as the default export ([RUNM1063](/reference/diagnostics#runm1063)).
- A `TemporalInstant` is this kind of field. The [Temporal types](/guide/dates#use-temporal-fields) ship their own codecs.

## Checks during conversion

With validation on, the default, each call checks the value. The JSON value and the model value are checked at separate stages, and each rule runs once. Your decoders only see values that passed the JSON check.

| Call | Checks JSON | Converts | Checks model |
| --- | --- | --- | --- |
| `parse<T>(text)` | ✓ | ✓ | ✓ |
| `parse<T>(text, { validate: false })` | | ✓ | |
| `stringify<T>(value)` | ✓ | ✓ | ✓ |
| `stringify<T>(value, { validate: false })` | | ✓ | |
| `fromWireFormat<T>(wire)` | ✓ | ✓ | ✓ |
| `toWireFormat<T>(value)` | ✓ | ✓ | ✓ |
| `validate<T>(value)` | | | ✓ |

`{ validate: false }` skips the check for data you already trust. It does not update stored field errors.

<<< ../../examples/models/src/load-task.ts#validation-during-conversion

- After a successful `parse` or `fromWireFormat` with validation on, call `validateInstance(model)` again only after you edit the instance. Call `getValidator(model).validate()` to store all field errors for display.
- `failFast: false` throws with every issue instead of the first one. It does not turn the check off.
- `validate<T>(value)` from `@exprtlabs/golem/validation` narrows `value` to the model and returns whether it matches, without throwing. `validateInstance(model)` returns the issues and does not throw for an ordinary invalid value.
- When `validation` is off, generated output has no checks. `{ validate: true }` then throws a `LibError` of kind `validation_unavailable`. With validation off, a missing required field is not reported: `stringify` leaves it out, and `toWireFormat` returns it as `undefined`.

## Copies and references

`fromWireFormat` and `parse` copy objects, maps (`Record<string, V>`) and arrays. Values typed `unknown` or `any` (the model sets `allowAny: true`) are carried by reference, including the undeclared properties of an open object. The result holds the same object as the input.

Cyclic input throws a `LibError` of kind `deserialization`. Encoding a cyclic value throws a `LibError` of kind `serialization`.

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models)
