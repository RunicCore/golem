# OpenAPI client support

Check what the client generator supports for each OpenAPI version, feature and profile. The page also lists limits on NestJS controller generation.

The table opens on OpenAPI 3.1 with MobX off and validation on. Each row names the feature, whether it is available, and the limitation that still applies.

These limits show up often:

- Callbacks and webhooks get TypeScript types. The application implements the handlers.
- The client does not choose an OpenAPI `servers` URL. Pass `baseUrl`.
- A whole query object stays one schema on OpenAPI 3.2. OpenAPI 3.1.2 flattens independent fields and rejects a contract whose constraints would be lost ([query compatibility](/reference/config#query-compatibility)).
- A cookie parameter, or an API key sent through a cookie, reaches the server as a `Cookie` header from Node, but browsers don't let scripts set that header ([`OPENAPI_BROWSER_COOKIE`](/reference/diagnostics#openapi-browser-cookie)).

<SupportTable>
<template #type-system-limits>

## Type system limits

</template>
</SupportTable>

## Generated names

Schema fields that override `Object.prototype` names, such as `__proto__` or `toString`, are unsupported. Generation reports the field so you can rename it in the API contract.

An operation name that is a JavaScript reserved word receives a `_` suffix (`operationId: delete` generates `delete_`), as does a client member name such as `constructor`; generation reports the rename as a warning ([`OPENAPI_OPERATION_RENAMED`](/reference/diagnostics#openapi-operation-renamed)). Operation names that differ only by letter case are rejected because their modules would collide on case-insensitive file systems.

A security scheme named `constructor` keeps that name on the generated `auth` option; it is not renamed. TypeScript requires `constructor: undefined` when supplying an `auth` object that omits that credential, for example `auth: { bearerAuth: 'token', constructor: undefined }`. This avoids a conflict with JavaScript's inherited constructor property while leaving the credential unavailable.

## Recursive schemas

A component schema that refers to itself through `$ref` generates, also when it is not an object. For example, a `JsonValue` component that is a `oneOf` of scalars, an array of `JsonValue` and an object with `additionalProperties` of `JsonValue` becomes the type `JsonValue`. A model field of that component has the type `Types.JsonValue`.

A recursive component that holds a `date-time` value or a model has a second type for the models. In the model, the value is a `Date` or a model instance at each level. On the wire, it is the string or the plain object. The client converts between the two for you.

A component that does not refer to itself stays part of each field that uses it.

## References between files

A discriminator `mapping` value inside a referenced file must be a pointer such as `#/components/schemas/Dog`, or the name of a root alias. A bare name in another file names a root component, so generation fails when the root declares none by that name and reports the mapping and its file.

`#/…` always means the containing document root, also inside a schema that declares its own `$id`. Pointers relative to an `$id` resource, such as `#/properties/x`, are unsupported; the `no-unresolved-refs` rule reports them.

## Response matching

When several response declarations could match, the client selects an exact status before a status range or `default`, then the most specific media type. It does not switch to another status declaration to make a media type match. Status and media-type matching runs even with `validation: false`.

## Text bodies and streams

A `$ref` and a composed schema (`allOf`, `oneOf`, `anyOf`) follow the same text-codec classification as a plain schema: unless it classifies as a plain string or as unknown, the media type needs a `bodyEncoders` or `responseDecoders` entry. An unknown or absent text schema stays a raw string; disabling validation does not turn that raw string into a decoded number, because decoding and validation are separate steps.

The required-codec check applies to the operation, response status and media type that declared it. An unrelated operation still uses built-in handling even when another operation on the same client requires a custom codec.

OpenAPI 3.1 does not provide the `itemSchema` streaming contract; it needs OpenAPI 3.2. OpenAPI 3.0 documents are not accepted. Declaring `itemSchema: false` permits no items — validation rejects the first one — and generates a response type of `AsyncIterable<never>`. With validation disabled, decoded items still arrive despite that type.

## Nest controller generation

A whole query object stays one schema on OpenAPI 3.2. OpenAPI 3.1.2 flattens it into independent named parameters only when no contract rule is lost; when it can't, generation fails with a loss diagnostic naming the field and the rule it would drop.

Class-level Swagger response decorators, such as `@ApiOkResponse()`, apply to every route on the class, including inherited routes. A method-level decorator for the same status replaces the class one. Repeated decorators on the same class or method apply from bottom to top, following `@nestjs/swagger`'s own merge order. Named helpers such as `@ApiTooManyRequestsResponse()` are supported, along with exact statuses, `1XX` through `5XX`, and `default`. A range or fallback response keeps the inferred `200` or `201` response.

`@ApiExcludeEndpoint()` and `@ApiExcludeEndpoint(true)` omit a route; `false` keeps it. `@ApiOperation({ hidden: false })` cannot restore an explicitly excluded endpoint.

## Full compliance matrix

The complete matrix by OpenAPI version and profile is in [`MATRIX.md`](https://github.com/RunicCore/golem/blob/master/packages/golem-openapi/MATRIX.md).
