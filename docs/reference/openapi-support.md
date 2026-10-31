# OpenAPI support

Check what the client generator supports for each OpenAPI version, feature and profile. The generator turns the validation keywords of a schema into client validation, whichever tool produced the document. A [`golem` mode SDK](/reference/config#sdk-modes) hands them to the models job, which compiles them with your models.

## Feature support

The table shows one row for each feature, for one OpenAPI version and one set of generation settings. It opens on OpenAPI 3.1 with MobX off and validation on.

- Choose the OpenAPI version and the generation settings above the table. The rows change with your choice.
- The small label under a feature name is its surface: runtime behavior, TypeScript types or generated metadata. A feature with more than one surface has one row for each surface.
- The support column gives the status. The meaning of each status is in the list under the table.
- The last column lists what to expect, such as a condition or a setting that the row needs.
- Type a word in "Find a feature" to show only the rows that match.

<SupportTable />

## Generated names

An operation name that is a JavaScript reserved word receives a `_` suffix (`operationId: delete` generates `delete_`), as does a client member name such as `constructor`. Generation reports the rename as a warning ([`OPENAPI_OPERATION_RENAMED`](/reference/diagnostics#openapi-operation-renamed)).

## Recursive schemas

A component schema that refers to itself through `$ref` generates, also when it is not an object. For example, a `JsonValue` component that is a `oneOf` of scalars, an array of `JsonValue` and an object with `additionalProperties` of `JsonValue` becomes the type `JsonValue`.

A recursive component that holds a `date-time` value has the converted type in the SDK: the value is a `Date` or a `Temporal` value at each level. In JSON, it is the string. The client converts between the two for you, in both modes.

A component that does not refer to itself stays part of each field that uses it.

## References between files

A discriminator `mapping` value inside a referenced file must be a pointer such as `#/components/schemas/Dog`, or the name of a root alias. A bare name in another file names a root component, so generation fails when the root declares none by that name and reports the mapping and its file.

`#/…` always means the containing document root, also inside a schema that declares its own `$id`. The `no-unresolved-refs` rule reports a pointer relative to an `$id` resource, such as `#/properties/x`.

## What the client converts

The client converts what it carries, in both [SDK modes](/reference/config#sdk-modes):

- request and response bodies and stream items,
- `path`, `query`, `header` and `cookie` parameters, including `$ref` `deepObject` and `querystring` parameters,
- declared response headers.

The payload of a webhook or a callback is a type of the SDK. The SDK has no handler for it. An app model over the type converts the payload.

A `date` or `date-time` value becomes a `Date`, or a `Temporal` value with `dates: temporal`. The checks run at the [`validate`](/guide/client-usage#lower-the-checks) level of the call. Conversion runs at every level.

## Response matching

When several response declarations could match, the client selects an exact status before a status range or `default`, then the most specific media type. It does not switch to another status declaration to make a media type match. Status and media-type matching runs even with `validation: false`.

## Text bodies and streams

A text body or response whose schema is not a plain string and not unknown needs an entry for its media type ([body formats](/guide/codecs)):

- A text body needs a `bodyEncoders` entry.
- A text response needs a `responseDecoders` entry.
- This holds for a `$ref` and for `allOf`, `oneOf` and `anyOf` too.
- An unknown or absent text schema stays a raw string. Disabling validation does not turn that string into a decoded number, because decoding and validation are separate steps.

The required-codec check applies to the operation, response status and media type that declared it. An unrelated operation still uses built-in handling even when another operation on the same client requires a custom codec.

The `itemSchema` streaming contract needs an OpenAPI 3.2 document. The generator reads OpenAPI 3.1 and 3.2 documents. `itemSchema: false` generates the response type `AsyncIterable<never>`, and validation rejects the first item.

## Full compliance matrix

The complete matrix by OpenAPI version and profile is the [`MATRIX.md` file](https://github.com/RunicCore/golem/blob/master/packages/golem-openapi/MATRIX.md) of the package.
