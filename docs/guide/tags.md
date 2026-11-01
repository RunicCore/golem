# Validation tags

Add built-in constraints and custom rules to field types.

A **type tag** is a type-only annotation that you intersect with a field type. A validation tag, such as `MinLength<3>` or `TValidation<typeof notBlank>`, adds a generated check. It does not change the TypeScript type that application code sees. [`TSerde`](/guide/serialization#change-the-json-form) is the type tag for the JSON form of a field.

<<< ../../examples/models/src/builtin-tags.model.ts#builtin-tags

- `title` stays a `string` to application code. Tags do not coerce it.
- Arguments must be literal types, such as `Minimum<0>` or `Pattern<'^[A-Z]+$'>`.

## Add a built-in tag

Intersect the field type with each validation tag. `TaggedTitle` above is `string & MinLength<3> & MaxLength<80>`. Run `npx golem generate` after you save the model file.

## Name a tag combination

Give a combination of tags a type alias and use the alias as the field type. A type parameter can supply a tag argument, so one alias serves every length.

<<< ../../examples/models/src/tag-aliases.model.ts#tag-aliases

- `Handle<20>` checks `maxLength: 20` and the pattern. Aliases can use other aliases.
- Inside an alias, `TSerde` and `TValidation` take `typeof` an exported function.
- An alias or codec can come from an installed package. The generated file imports the codec through the `exports` of the package. When the package has no `exports` field, it imports by the path inside the package ([RUNM1060](/reference/diagnostics#runm1060)).

## Built-in validation constraints

Each family has its own tags. Every tag, its JSON Schema keyword and the field types it fits are in [Built-in tags](/reference/runtime-api#built-in-tags).

| Family | What it checks | Example |
| --- | --- | --- |
| [Numbers](/reference/runtime-api#built-in-tags) | Range, whole numbers and multiples | `Minimum<N>` |
| [Strings](/reference/runtime-api#built-in-tags) | Length, pattern and format | `MaxLength<N>` |
| [Arrays](/reference/runtime-api#built-in-tags) | Item count, uniqueness and matching items | `UniqueItems` |
| [Objects](/reference/runtime-api#built-in-tags) | Property count, names and extra keys | `MinProperties<N>` |
| [Related fields](/reference/runtime-api#built-in-tags) | Fields that depend on each other | `DependentRequired<Map>` |
| [Alternatives](/reference/runtime-api#built-in-tags) | Branches of a schema | `OneOf<Tuple>` |

## Object and array validation constraints

Schema-valued tags describe another TypeScript contract:

<<< ../../examples/models/src/collection-tags.model.ts#collection-tags

- `Contains<T>` counts matching elements. `MinContains` and `MaxContains` bound the count.
- `DependentRequired<{ remindOn: ['dueOn'] }>` requires `dueOn` whenever `remindOn` is present, so the rejected subscription above fails. In general it requires the listed keys when its trigger key is present. `DependentSchemas` checks the whole object in that situation.
- `PropertyNames`, `PatternProperties` and `UnevaluatedProperties` check keys or values without adding TypeScript index signatures.
- `AdditionalProperties<V>` makes each other key of the object a value of type `V`. `parse`, `stringify` and `toWireFormat` convert and write those keys by `V`, as they do for an index signature. `AdditionalProperties<unknown>` keeps the values as they are. `AdditionalProperties<never>` allows no other key.
- `OneOf<[A, B]>`, `Not<T>` and `IfThenElse` choose or reject schema branches. None changes assignability or selects a converter.

## Name the tag of a union

`Discriminator<Key>` names the property that tells the variants of a model union apart. Write it on a union of two or more objects. Golem reads that key and no other. [Unions](/guide/field-types#declare-the-tag-of-an-object-union) shows the placements.

<<< ../../examples/models/src/contact.model.ts#discriminated-union

| Parameter | Meaning |
| --- | --- |
| `Key` | The property that each variant declares as a required literal. |
| `Default` (optional) | The one variant that may lack `Key`. |

- Each variant declares `Key` as a required literal type, or a union of literals. No two variants share a value. A variant that breaks this rule stops generation ([RUNM1087](/reference/diagnostics#runm1087)).
- A union of two or more objects without the tag stops generation ([RUNM1080](/reference/diagnostics#runm1080)).
- A tag on a value that is not such a union stops generation ([RUNM1051](/reference/diagnostics#runm1051)).
- The tag does not change the TypeScript type. The generated model files carry no tag.

### Add a default variant

Give `Discriminator` a second type argument to name the default variant. The default is the variant that has no tag, such as an SDK type from an OpenAPI document.

<<< ../../examples/models/src/contact.model.ts#union-tag-default

- An object whose `kind` is missing, or matches no other variant, becomes the default.
- The default must be a variant of the union, and it must not declare `Key` itself. Otherwise generation stops ([RUNM1051](/reference/diagnostics#runm1051)).
- Only the default may lack `Key`.

### Document a tagged union

A docs job writes a tagged union as `oneOf` with `discriminator.propertyName` set to `Key`, and a `mapping` from each value to its schema.

- OpenAPI 3.2 states a default variant as `defaultMapping`.
- OpenAPI 3.1 has no `defaultMapping`, so the docs job writes a union with a default as `anyOf` with no `discriminator`. A `golem-openapi-ts` job that reads that 3.1 document stops with [`OPENAPI_UNION_DISCRIMINATOR_MISSING`](/reference/diagnostics#openapi-union-discriminator-missing) when the variants are models. For a union with a default, use OpenAPI 3.2. It is the default `openapiVersion`.
- A `golem-openapi-ts` job rejects an OpenAPI 3.1 document that writes `defaultMapping`: it is a keyword of 3.2.
- An SDK that `golem-openapi-ts` generates follows the `discriminator` of its document. On OpenAPI 3.2 it follows `defaultMapping` too.

## Formats

On a model field, `Format<'name'>` applies to a `string`, or to a `number` for a number format such as `number & Format<'int32'>`. A number format also applies to schemas from an OpenAPI document, where a number schema has `format: int32`. A format on the wrong type, such as `email` on a `number` or `int32` on a `string`, stops generation ([RUNM1051](/reference/diagnostics#runm1051)). Golem checks these names:

| Value | Format names | Applies to |
| --- | --- | --- |
| Strings | `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uuid`, `regex`, `byte`, `json-pointer`, `relative-json-pointer` | Model fields and OpenAPI schemas |
| Numbers | `int32`, `int64`, `float`, `double` | Model fields and OpenAPI schemas |
| Any string | `password`, `binary`, `media-range` | Model fields and OpenAPI schemas |

A format name that golem does not check stops generation. Set `unknownFormats: warn` in [`golem.yaml`](/reference/config#root-keys) to report it and continue.

## Add a custom field rule

Use `TValidation<typeof predicate>` when a built-in tag cannot express the validation constraint. Declare the predicate in its own module and import it into the model file. A predicate declared in a model file is a generation error ([RUNM1065](/reference/diagnostics#runm1065)).

<<< ../../examples/models/src/task-input-rule.ts#custom-rule-fn

<<< ../../examples/models/src/task-input.model.ts#custom-rule

- Export a synchronous function with one required value.
- Return `true` to accept, `false` for a default message, or a string for a custom message.
- Built-in constraints run first. Do not depend on the order of several predicates on one value.
- Generated checks run before the predicate. A predicate on the model field type checks the model value. A predicate on the parameter type of a `TSerde` decoder checks the JSON value.
- A field can add a rule to an SDK type, such as `Money & TValidation<typeof extra>`. The rule runs with the checks of the SDK type.
- For rules that depend on another field or an asynchronous lookup, use an [instance validator rule](/guide/validation#instance-rules).

The generated file imports your predicate. OpenAPI documents carry only the JSON schema, never the predicate.
