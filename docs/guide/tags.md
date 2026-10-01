# Type tags

Attach validation constraints, custom rules and JSON conversions to field types.

Start with a [configured model project](/guide/quick-start). Keep validation enabled and install its runtime peers:

```sh
npm install ajv ajv-formats
```

Run `npx golem generate` after saving a model file. [Standalone validation](/reference/config#validation-profiles) is an alternative to runtime Ajv.

Tags are type-only annotations on a field type.

- A validation constraint such as `MinLength<3>` or `TValidation<typeof notBlank>` adds a generated check.
- A `TSerde<typeof encode, typeof decode>` serialize formatter changes the field's JSON value.
- Add validation constraints without changing the TypeScript type application code sees.
- Compose tags through aliases, intersections, arrays and supported unions.

<<< ../../examples/model/src/builtin-tags.model.ts#builtin-tags

- `title` remains a `string` to application code; tags do not coerce it.
- Arguments must be literal types, such as `Minimum<0>` or `Pattern<'^[A-Z]+$'>`.

## Add a built-in tag

Intersect the field type with each validation constraint tag. The title above is `string & MinLength<3> & MaxLength<80>`.

## Name a tag combination

Give a combination of tags a type alias and use the alias as the field type. A type parameter can supply a tag argument, so one alias serves every length.

<<< ../../examples/model/src/tag-aliases.model.ts#tag-aliases

- `Handle<20>` checks `maxLength: 20` and the pattern; aliases can use other aliases.
- The argument must be a literal where you use the alias. `Varchar<number>` fails with [RUNM1043](/reference/diagnostics#runm1043).
- An alias can hold one tag of each kind that depends on a type parameter ([RUNM1062](/reference/diagnostics#runm1062)).
- `TSerde` and `TValidation` inside an alias take `typeof` an exported function, not a type parameter ([RUNM1061](/reference/diagnostics#runm1061)).
- An alias or codec can come from an installed package. The generated file imports the codec through the package's `exports` ([RUNM1060](/reference/diagnostics#runm1060)).

## Built-in validation constraints

| Value | Tags |
| --- | --- |
| Numbers | `Integer`, `Minimum<N>`, `Maximum<N>`, `ExclusiveMinimum<N>`, `ExclusiveMaximum<N>`, `MultipleOf<N>` |
| Strings | `MinLength<N>`, `MaxLength<N>`, `Pattern<'...'>`, `Format<'email'>`, `Format<'uuid'>`, `Format<'date'>`, `Format<'date-time'>` |
| Arrays | `MinItems<N>`, `MaxItems<N>`, `UniqueItems`, `Contains<T>`, `MinContains<N>`, `MaxContains<N>`, `UnevaluatedItems<T>` |
| Objects | `MinProperties<N>`, `MaxProperties<N>`, `PropertyNames<T>`, `PatternProperties<Map>`, `AdditionalProperties<T>`, `UnevaluatedProperties<T>` |
| Related fields | `DependentRequired<Map>`, `DependentSchemas<Map>` |
| Alternatives | `OneOf<Tuple>`, `Not<T>`, `IfThenElse<Condition, Then, Else>` |

- Length and item limits must be nonnegative integers; `MultipleOf` must be positive.
- The generator rejects malformed patterns and validation constraints attached to incompatible types.
- `Format` validates only names known by the installed validation engine; an unknown format name is an annotation.

## Object and array validation constraints

Schema-valued tags describe another TypeScript contract:

<<< ../../examples/model/src/collection-tags.model.ts#collection-tags

- `Contains<T>` counts matching elements; `MinContains` and `MaxContains` bound the count.
- `DependentRequired` requires listed keys when its trigger is present; `DependentSchemas` checks the whole object in that situation.
- `PropertyNames`, `PatternProperties`, `AdditionalProperties`, `UnevaluatedProperties` and `UnevaluatedItems` check keys or values without adding TypeScript index signatures.
- `OneOf<[A, B]>`, `Not<T>` and `IfThenElse` choose or reject schema branches; none changes assignability or selects a converter.

## Add a custom field rule

Use `TValidation<typeof predicate>` when a built-in tag cannot express the validation constraint. Declare the predicate in its own module and import it into the model file; a predicate declared in a model file is a generation error ([RUNM1065](/reference/diagnostics#runm1065)).

<<< ../../examples/model/src/task-input-rule.ts#custom-rule-fn

<<< ../../examples/model/src/task-input.model.ts#custom-rule

- Extra `TValidation` on a nested SDK type, such as `Money & TValidation<typeof extra>`, is compiled into the parent model's Ajv validator next to the nested SDK schema; it does not create a second validator.
- Export a synchronous function with one required value.
- Built-in constraints run first. Several predicates on one value run in a fixed order that doesn't follow the order you wrote them, so keep each predicate independent of the others.
- Return `true` to accept, `false` for a default message, or a string for a custom message.
- Generated checks run before the predicate. A predicate on the model field type checks the model value; a predicate on the `TSerde` decoder's parameter type checks the JSON value.
- For rules that depend on another field or an asynchronous lookup, use an [instance validator rule](/guide/validation#instance-rules).

The generated file imports your predicate. OpenAPI documents carry only the JSON schema, never the predicate.

## Convert a field to a different JSON value

`TSerde<typeof encode, typeof decode>` is a serialize formatter: `encode` turns the model value into its JSON value, and `decode` turns the JSON value back into the model value. Both are synchronous. JSON text uses `stringify` / `parse`. A plain object uses `toWireFormat` / `fromWireFormat`.

`TPermissionInput` is an IModel; `fromWireFormat<TPermissionInput>` returns a plain object and `fromWireFormat<PermissionInput>` constructs your class.

<<< ../../examples/model/src/permission-rules.ts#serde-tag-fn

<<< ../../examples/model/src/permission-input.model.ts#serde-tag

- The same behavior applies when the field is nested.
- Declare the encoder and decoder in their own module, like a `TValidation` predicate; in a model file they are a generation error ([RUNM1065](/reference/diagnostics#runm1065)).
- `TSerde` encoders and decoders run during conversion, never during generation.
- Their return values and exceptions are observed by `stringify` / `parse` and `fromWireFormat` / `toWireFormat`.
- An encoder must return JSON-compatible data; non-finite numbers, cycles and other unrepresentable values still fail with validation disabled.

### Which type controls validation?

Here `PermissionWire` is a string tagged with a hexadecimal pattern, and the model stores `permissions` as a number:

| Declaration or option | Effect |
| --- | --- |
| `decodePermissions(value: PermissionWire)` | JSON validation includes the pattern. Generated validation checks it **before decoding and after encoding**. |
| Change the decoder parameter to `value: string` | JSON validation keeps the string type check but drops the pattern, even if the encoder still returns `PermissionWire`. |
| `permissions: number & Integer & Minimum<0> & …` | These are validation constraints on the model value. They run **after decoding and before encoding**, regardless of whether the decoder accepts plain `string`. |
| `{ validate: false }` | Runs only the `TSerde` serialize formatter, without Ajv. Without this option, `parse`, `stringify`, `fromWireFormat` and `toWireFormat` run Ajv when validation is enabled. |

- The decoder's parameter type defines the JSON schema.
- The encoder's return type is checked for TypeScript compatibility. Tags on the return type alone add no JSON validation.
- A plain `string` parameter keeps the string check and drops the tagged validation constraints on the JSON value. This also applies to aliases such as `ProjectName = string & MinLength<3>`.

Calling `encodePermissions()` or `decodePermissions()` directly runs only the function body. Type annotations do not perform runtime checks by themselves.

JSON validation and model validation are separate stages, and each rule runs once per conversion ([validation during conversion](/guide/serialization#validation-during-conversion)).

## Convert a field to a class value

A `TSerde` field can hold a class instance, such as `Uint8Array`, or a `bigint`. The codec does all the conversion, and validation checks the JSON value.

<<< ../../examples/model/src/base64-codec.ts#base64-codec

<<< ../../examples/model/src/attachment.model.ts#class-valued-field

Converting the model writes the JSON form and restores the instance:

<<< ../../examples/model/src/attachment-json.ts#attachment-json

- The class must have a name, be exported from a module (under any name, or as the default export), and have no type parameter without a default ([RUNM1063](/reference/diagnostics#runm1063)).
- A `TemporalInstant` is this kind of field; the [Temporal types](/guide/dates#use-temporal-fields) ship their own codecs.
