# OpenAPI support

Check what the client generator supports for each OpenAPI version, feature and profile. The generator turns the validation keywords of a schema into model and client validation, whichever tool produced the document.

The table opens on OpenAPI 3.1 with MobX off and validation on. Each row names the feature, its support status and what to expect.

<SupportTable />

## Generated names

Generation reports a schema field that is named like an `Object.prototype` member, such as `__proto__` or `toString`, or like a generated model member, such as `toJSON`. Rename the field in the API contract.

An operation name that is a JavaScript reserved word receives a `_` suffix (`operationId: delete` generates `delete_`), as does a client member name such as `constructor`. Generation reports the rename as a warning ([`OPENAPI_OPERATION_RENAMED`](/reference/diagnostics#openapi-operation-renamed)). Operation names that differ only by letter case stop generation, because their modules would collide on case-insensitive file systems.

A security scheme named `constructor` keeps that name on the generated `auth` option. When an `auth` object omits that credential, set `constructor: undefined`, for example `auth: { bearerAuth: 'token', constructor: undefined }`.

## Recursive schemas

A component schema that refers to itself through `$ref` generates, also when it is not an object. For example, a `JsonValue` component that is a `oneOf` of scalars, an array of `JsonValue` and an object with `additionalProperties` of `JsonValue` becomes the type `JsonValue`. A model field of that component has the type `Types.JsonValue`.

A recursive component that holds a `date-time` value or a model has a second type for the models. In the model, the value is a `Date` or a model instance at each level. On the wire, it is the string or the plain object. The client converts between the two for you.

A component that does not refer to itself stays part of each field that uses it.

## References between files

A discriminator `mapping` value inside a referenced file must be a pointer such as `#/components/schemas/Dog`, or the name of a root alias. A bare name in another file names a root component, so generation fails when the root declares none by that name and reports the mapping and its file.

`#/…` always means the containing document root, also inside a schema that declares its own `$id`. The `no-unresolved-refs` rule reports a pointer relative to an `$id` resource, such as `#/properties/x`.

## Response matching

When several response declarations could match, the client selects an exact status before a status range or `default`, then the most specific media type. It does not switch to another status declaration to make a media type match. Status and media-type matching runs even with `validation: false`.

## Text bodies and streams

A text body or response whose schema is not a plain string and not unknown needs a `bodyEncoders` or `responseDecoders` entry for its media type ([body formats](/guide/codecs)). This holds for a `$ref` and for `allOf`, `oneOf` and `anyOf` too. An unknown or absent text schema stays a raw string. Disabling validation does not turn that string into a decoded number, because decoding and validation are separate steps.

The required-codec check applies to the operation, response status and media type that declared it. An unrelated operation still uses built-in handling even when another operation on the same client requires a custom codec.

The `itemSchema` streaming contract needs an OpenAPI 3.2 document. The generator reads OpenAPI 3.1 and 3.2 documents. `itemSchema: false` generates the response type `AsyncIterable<never>`, and validation rejects the first item.

## Full compliance matrix

The complete matrix by OpenAPI version and profile is the [`MATRIX.md` file](https://github.com/RunicCore/golem/blob/master/packages/golem-openapi/MATRIX.md) of the package.
