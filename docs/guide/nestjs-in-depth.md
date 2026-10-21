# Controllers in depth

Shape routes, schemas, query objects, responses and request handling for NestJS 11 controllers.

The types in your controller signatures produce both the OpenAPI schema and the runtime request conversion. Each section below is a separate example; [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments) combines them in one app.

## Route helpers

`src/routes.ts`:

<<< @/../examples/payments/server/src/routes.ts#route-helper

Add to your controller:

<<< @/../examples/payments/server/src/payments.controller.ts#route-helper-method

| Path expression | Allowed |
| --- | --- |
| `'payments/transactions'` | Yes |
| `routes.resource({ service: 'payments', resource: 'transactions' })` | Yes |
| A helper returning a template, a concatenation, its own string parameters, a const string, or another simple helper | Yes |
| A helper whose object argument is destructured in its signature | Yes |
| A non-static class method used as a route helper | Rejected |
| A helper that reads a file, awaits, or otherwise runs instead of folding to a value at generation time | Rejected |

- The generator runs the helper on its own; it doesn't start your app or run other module code.
- Results over 1 MiB are rejected. Job settings are in [controller configuration](/reference/config#controller-jobs).

## Model schemas

Use `TSerde` to store a number in the model and send a string in JSON.

The converters live in their own module, because generated files import them:

<<< ../../examples/payments/server/src/decimal-text.ts#decimal-text

The model references them by type:

<<< ../../examples/payments/server/src/price.model.ts#decimal-price

- A controller parameter or return type using that model appears in OpenAPI as its JSON value: `amount` is a string schema with the `Pattern` declared on the decoder's parameter type.
- The decoder's parameter type supplies the JSON type. Generation reads that type; it never calls a converter to infer a schema.
- A validation constraint on the model value, such as `Minimum<0>` on a number, is not copied onto the string JSON field.
- Custom predicates and converters stay in TypeScript. OpenAPI carries only the JSON schema. Class-validator decorators are not interpreted.
- [`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value) declares the pair.

An `IModel` contract is authoritative in both request and response directions.
Swagger metadata can add documentation, but a structural override must agree
with the TypeScript contract and its [validation constraints](/guide/validation#openapi-validation-constraints-in-both-directions).

## NestModelInterceptor

`NestModelInterceptor` runs `fromWireFormat` on `@Body()` and `@Query()` before the handler, and writes an `IModel` or `IObject` return with `stringify`.

<<< @/../examples/payments/server/src/application.ts#global-model-http

Declare a model and use it as a `@Body()` type:

<<< ../../examples/payments/server/src/payment-draft.model.ts#payment-draft

Add a method to your controller:

<<< ../../examples/payments/server/src/payments.controller.ts#draft-method

What happens to a request:

1. `fromWireFormat` runs on `@Body()` and `@Query()` with fail-fast validation.
2. Nest rejects malformed JSON with HTTP 400 before this interceptor runs. Input that fails validation or can't be decoded, such as a broken constraint, an unknown discriminator tag or an unparsable date, returns HTTP 400 with `issues` (`LibError.causedByInput`).
3. Valid input reaches the handler as a model: a type alias stays a plain object, and your class is constructed.
4. An `IModel` or `IObject` return, including a `Promise` or an array of that type, is stringified with that type. A return that golem did not mark stays Nest JSON.
5. An application converter that throws, and missing generated metadata, stay HTTP 500. A marked return whose generated model did not load fails the request with HTTP 500 before the handler runs.

`@Param()` and `@Headers()` stay as Nest received them. Interfaces and array element types are erased from Nest metadata, so the rewrite records the model and whether the parameter is an array of it.

An array of models, such as `@Body() items: Item[]` or `@Body('items') items: Item[]`, converts item by item. An invalid item returns HTTP 400, and each issue path starts with the field name, if any, and the item index, such as `['items', 1, 'name']`. A value that is not an array returns HTTP 400 with a `type` issue. A whole `@Query()` cannot be an array, and the interceptor throws a `TypeError`.

### Input that is not a model

Every `@Body()` and `@Query()` parameter needs an `IModel` or `IObject` type. If a parameter has another type, the interceptor throws a `TypeError` that names the controller, the method and the parameter, and Nest answers HTTP 500. This covers a plain interface, a plain class, a primitive, a parameter with no type, and one field such as `@Body('name')` or `@Query('page')` with a plain type. The interceptor throws on each request to the handler, not at startup. Return types are not affected.

A one-field parameter with a model type, such as `@Body('address') address: Address`, converts that field with the same checks as a whole body. A missing field or a field that fails validation returns HTTP 400, and each issue path starts with the field name, such as `['address', 'street']`. A handler cannot take a whole `@Body()` and a one-field `@Body()` together, and the same holds for `@Query()`. In that case the interceptor throws a `TypeError`.

The [`controllers` job](/guide/nestjs#configure-and-generate) rejects `@Body('field')` with [`NEST1103`](/reference/diagnostics#nest1103), so the one-field body form is for apps without that job.

A one-field model in `@Query('address')` reads a nested query key such as `address[street]=Main`. The app needs a nested query parser for that, for example Express `query parser` set to `extended`.

To take plain types, declare the input as an `IModel` or `IObject`, or write your own interceptor.

The interceptor converts HTTP handlers only. A handler of another context, such as RPC, passes through unchanged.

Compile-time recording of these types needs the project settings in [Set up TypeScript](/guide/nestjs#set-up-typescript) and a value import of the model module, so the codec exists before the interceptor runs. The full `@exprtlabs/golem/nest` import is in the [runtime API](/reference/runtime-api#nest).

| Declared return type | Response |
| --- | --- |
| `IModel` or `IObject`, including a `Promise` of that type | That type's JSON |
| Array of that type | JSON array of those values |
| Primitive, plain object, file, non-model class, or a union | Nest JSON |

Models inside a plain wrapper are not traversed. Declare the wrapper as a model if its fields need serialization.

::: tip Optional
Use `nestModelStringifyInterceptor` to write the response with a codec other than the declared return type's own. Get that codec from a `@Body()` or `@Query()` parameter already typed with the target class, using `objectCodecFromMetatype`.
:::

## Query objects

HTTP query values are strings, and repeated keys arrive as string arrays. Declare the query as an `IObject`. Before `fromWireFormat`, `NestModelInterceptor` decodes each field to the type its schema declares:

| Field type | Query text | Decoded value |
| --- | --- | --- |
| `number` or `Integer` | `?limit=42` | `42` |
| `boolean` | `?active=true` | `true` |
| A number or boolean literal, such as `42` or `true` | `?mode=42` | `42` |
| An array field given one value | `?status=paid` | `['paid']` |

- A value that doesn't fit the declared type stays a string, so validation rejects it with HTTP 400.
- A field that also accepts a string keeps it: for `string | number`, `'42'` stays `'42'`.
- Only the query object's own properties are decoded; a query model that is a `$ref` to another model or a union at its root is passed through unchanged.
- A JSON body is not decoded.
- The interceptor stores the converted query on the individual request. Whole-query parameters on one route must use the same model type; repeated bindings share the converted value. The same rule applies to whole-body parameters. A one-field binding such as `@Query('address')` converts its field with its own model type.

<<< @/../examples/payments/server/src/payment.model.ts#payment-filter

<<< @/../examples/payments/server/src/payments.controller.ts#query-method

- `GET /api/payments/transactions?limit=10&status=paid` yields `{ limit: 10, status: 'paid' }`.
- Repeated `status=paid&status=pending` yields `{ status: ['paid', 'pending'] }`.
- `limit=abc`, `status=refunded`, and undeclared keys (`exact: true`) return HTTP 400 before the handler.
- `PaymentStatus | PaymentStatus[]` is the [supported query union](/guide/model-composition#unions). Arbitrary object unions are not converted on `@Query()` or `@Body()`.

OpenAPI 3.2 emits the whole query schema; its SDK uses `.execute({ querystring: { limit: 10, status: ['paid'] } })`. OpenAPI 3.1.2 flattens a query object into independent named parameters when the [contract survives](/reference/openapi-support#nest-controller-generation) and the values fit [query compatibility](/reference/config#query-compatibility).

## Status codes and media types

| Controller contract | Generated success response |
| --- | --- |
| `@Post()` | `201` by default |
| Other HTTP verbs | `200` by default |
| `@HttpCode(204)` | `204`, including an explicit empty response |
| Object or array return type | JSON by default |
| `@Res({ passthrough: true })` or `@Response({ passthrough: true })` | Inferred from the return type |
| Primitive, file, stream or manual response | Requires explicit supported Swagger media/schema metadata |

- A `void` return does not imply `204`.
- Swagger response decorators describe the response; `@HttpCode` controls Nest's status. Contradictions fail generation.
- Path parameters must match placeholders and be required. Expanded routes and versions receive distinct operation IDs; remaining collisions fail.

`@Res()` and `@Res({ passthrough: false })` handle the response manually, so declare a Swagger success response with a type or content/schema. Passthrough and endpoint-exclusion options must resolve to static booleans; generation reports an error when their values are unknown.

Class-level Swagger response decorators, exclusion decorators and their [merge order](/reference/openapi-support#nest-controller-generation) follow `@nestjs/swagger`.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
