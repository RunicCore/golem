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

Use `TValidation<typeof predicate>` when a built-in tag cannot express the validation constraint. Declare the predicate in its own module and import it into the model file, not the other way around. Every project predicate is collected into one generated module, which the model's own generated file needs at start-up; a predicate declared in the model file itself creates a cycle between those two files, and loading throws before either one finishes.

<<< ../../examples/model/src/task-input-rule.ts#custom-rule-fn

<<< ../../examples/model/src/task-input.model.ts#custom-rule

- Extra `TValidation` on a nested SDK type, such as `Money & TValidation<typeof extra>`, is compiled into the parent model's Ajv validator next to the nested SDK schema; it does not create a second validator.
- Export a synchronous function with one required value.
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

JSON validation and model validation are two stages, and each rule runs once per
conversion: the second stage checks only what conversion produced
([validation during conversion](/guide/serialization#validation-during-conversion)).
After successful `parse` / `fromWireFormat`, another `validateInstance(model)` call is
unnecessary unless you have edited the model. Use `getValidator(model).validate()` when
an editor needs stored field errors.

## Worked example: permissions

One permissions contract runs through a NestJS API, an OpenAPI SDK and an application model. The API sends permission bits as a hexadecimal string; your model works with a number.

### Define the field rules

<<< ../../examples/showcase/src/access-rules.ts#model-and-tags

### Generate the API contract

The backend declares the same contract, and one configuration generates the document and the SDK without starting a server:

<<< ../../examples/showcase/backend/project-access.model.ts#backend-model

<<< ../../examples/showcase/backend/project-access.controller.ts#project-access-controller

<<< ../../examples/showcase/golem.yaml

### Define the model

The SDK type carries only the JSON schema, so re-attach `PermissionBits` to get the number field and the read-bit rule.

<<< ../../examples/showcase/src/project-access.model.ts#model-definition

### Load, edit and serialize

<<< ../../examples/showcase/src/edit-access.ts#home-example

### Show an invalid edit

<<< ../../examples/showcase/src/check-permissions.ts#permission-errors

The check returns: "A project access record must include the read permission bit."

### Save through the client

<<< ../../examples/showcase/src/save-access.ts#api-operations

The class as type argument (`ProjectAccessEditor`) builds your class; the `T…` type (`TProjectAccessEditor`) gives or takes a plain object, here typed as [`ProjectAccessEditorJSON`](/guide/models#declare-fields).

Run `npm start` in `examples/showcase`; set `PROJECT_ACCESS_API_BASE_URL` to send the save to a real API.

Full example: [`examples/showcase`](https://github.com/RunicCore/golem/tree/master/examples/showcase)
