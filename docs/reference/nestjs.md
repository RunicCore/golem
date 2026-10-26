# NestJS controllers

See how each controller construct becomes OpenAPI.

## Route helpers

The generator folds a route path or version to a value at generation time. It does not start your app or run other module code. `src/routes.ts`:

<<< ../../examples/payments/server/src/routes.ts#route-helper

Use it in your controller:

<<< ../../examples/payments/server/src/payments.controller.ts#route-helper-method

| Path expression | Result |
| --- | --- |
| `'payments/transactions'` or an array of string literals | Used as written |
| `routes.resource({ service: 'payments', resource: 'transactions' })` | Folded to `payments/transactions` |
| A helper that returns a template, a concatenation, a const string, its own string parameters or another simple helper | Folded |
| A helper whose object argument is destructured in its signature | Folded |
| A static class method or an object-literal method used as a helper | Folded |
| A non-static class method used as a helper | Error |
| A helper whose body is more than one `return` expression (any statement before the return counts) | Error |

A route that the generator cannot fold stops generation with an error that names the expression.

## Model schemas

An `IModel` or `IObject` contract is authoritative in both request and response directions. Swagger metadata can add documentation. A structural override must agree with the TypeScript contract and its validation constraints, or generation stops.

Supported validation tags become OpenAPI keywords, and the client generator reads the same keywords back into model and request validation. The document can come from any OpenAPI producer.

| TypeScript tag | OpenAPI keyword | Generated validation |
| --- | --- | --- |
| `string & MinLength<3>` | `type: string`, `minLength: 3` | Rejects strings shorter than three characters |
| `number & Minimum<0>` | `type: number`, `minimum: 0` | Rejects negative numbers |
| `string & Pattern<'^[A-Z]+$'>` | `type: string`, `pattern: '^[A-Z]+$'` | Rejects strings that do not match |

The supported keywords depend on the OpenAPI version and profile ([OpenAPI support](/reference/openapi-support)).

Custom predicates and converters stay in TypeScript functions, because OpenAPI carries no executable code. Sharing them through imports is optional.

### Fields with a TSerde pair

For a field with a [`TSerde`](/guide/serialization#change-the-json-form) pair, the OpenAPI schema describes the JSON value, not the model value. The example stores a number in the model and sends a string in JSON. The converters live in their own module, because generated files import them:

<<< ../../examples/payments/server/src/decimal-text.ts#decimal-text

The model references them by type:

<<< ../../examples/payments/server/src/price.model.ts#decimal-price

- A controller parameter or return type that uses this model appears in OpenAPI as its JSON value. `amount` is a string schema with the `Pattern` declared on the decoder's parameter type.
- The decoder's parameter type supplies the JSON type. Generation reads that type and never calls a converter.
- A validation constraint on the model value, such as `Minimum<0>` on a number, is not copied onto the string JSON field.

## Component names

A model's component name comes from the types it was declared with:

| Declaration | Component |
| --- | --- |
| `class Payment extends TPaymentBaseModel {}` for `type TPayment = IModel<…>` | `Payment`, the class name |
| Two or more classes extending `TPaymentBaseModel` | `TPayment`, the exact alias |
| `type TMerchant = IModel<…>` with no class | `TMerchant`, the exact alias |
| `type TPaymentInput = IObject<…>` | `TPaymentInput`, the exact alias |

A type derived from a model, such as `Omit<TMerchant, 'id'>`, is named from the model's component, as in `TMerchantOmitId`. Two models with the same component name and an identical schema share one component. A model class named with `@ApiSchema({ name })` is the component of that name, in every `$ref` to it; its codec id and its generated model keep the model's name. Two model classes of one file with the same `@ApiSchema` name stop generation with [`RUNM1005`](/reference/diagnostics#runm1005). A plain DTO class stays inline in the document, and its `@ApiSchema({ name })` names it only for `getSchemaPath()` and `refs()` from `@nestjs/swagger`.

Two models with the same name and different schemas are qualified by where they are declared. Each takes the shortest trailing run of its file's directory segments, relative to the project root, that tells the models apart, joined with `.`: `orders.Payment` and `billing.Payment`. Models in the same directory add the file name without `.model.ts` or `.ts`: `billing.payment.Payment` and `billing.refund.Payment`. Characters other than letters, digits and underscores in a segment become `_`.

## Status codes and media types

| Controller contract | Generated success response |
| --- | --- |
| `@Post()` | `201` by default |
| Other HTTP verbs | `200` by default |
| `@HttpCode(204)` | `204`, including an explicit empty response |
| Object or array return type | JSON by default |
| `@Res({ passthrough: true })` or `@Response({ passthrough: true })` | Inferred from the return type |
| Primitive, file, stream or manual response | Needs an explicit Swagger media type and schema |

- A `void` return does not imply `204`.
- Swagger response decorators describe the response, and `@HttpCode` controls the status Nest sends. A Swagger `200`, `201`, `202`, `204` or `205` response that differs from the Nest status stops generation ([`NEST1311`](/reference/diagnostics#nest1311)).
- `@ApiProduces` sets the response media types, and `@ApiConsumes` sets the request body media types. `@Header('Content-Type', …)` sets the media type of the success response. A `content` option in a Swagger response sets its own.
- Path parameters must match the placeholders of the route, and they are always required.
- A route with several paths or versions gets one operation for each. Their operation IDs end in `__path_1`, `__version_1` and so on, or in `__path_1__version_1` when a route has several paths and several versions. Two operations with the same ID stop generation ([`NEST1305`](/reference/diagnostics#nest1305)).

`@Res()` and `@Res({ passthrough: false })` handle the response manually, so declare a Swagger success response with a type or content and schema. Write the `@Res()` options as an inline object. The `passthrough` option and the endpoint-exclusion options must be static booleans.

## Swagger decorators and merge order

The generator reads these `@nestjs/swagger` decorators:

| Decorator | Effect |
| --- | --- |
| `@ApiOperation` | `operationId`, `summary`, `description`, `deprecated` and `hidden` |
| `@ApiTags`, `@ApiProduces`, `@ApiConsumes` | Tags and media types |
| `@ApiBody` | Request body `type`, `isArray`, `required`, `description`, `content` and `schema` |
| `@ApiQuery`, `@ApiParam`, `@ApiHeader`, `@ApiHeaders` | Parameter metadata, from the method or the class |
| `@ApiResponse` and the named helpers, such as `@ApiTooManyRequestsResponse()` | Responses by exact status, `1XX` through `5XX`, or `default` |

Merge rules for response decorators follow `@nestjs/swagger`:

- A class-level decorator, such as `@ApiOkResponse()`, applies to every route on the class, including inherited routes.
- A method-level decorator for the same status replaces the class one.
- Repeated decorators on the same class or method apply from bottom to top. Two decorators for one status join their descriptions.
- A range or `default` response keeps the inferred `200` or `201` response.

## Query compatibility

| Target | Whole-query contract |
| --- | --- |
| OpenAPI 3.2 | Emits `in: querystring` with form content and the complete query schema |
| OpenAPI 3.1.2 | Flattens independent fields into named parameters and rejects a contract whose constraints would be lost ([`NEST1108`](/reference/diagnostics#nest1108)) |

Named `@Query('name')` parameters remain ordinary query parameters. A named parameter must be a scalar, an array of scalars, or an `IModel` or `IObject`, or generation stops ([`NEST1107`](/reference/diagnostics#nest1107)). A named model is one `deepObject` parameter (`filter[status]=paid`). A one-field `@Body('name')` model is a property of the request body ([`NEST1103`](/reference/diagnostics#nest1103) for another type).

A whole `@Query()` object follows these rules:

- A type with an index signature, such as a dictionary, stops generation on both versions ([`NEST1105`](/reference/diagnostics#nest1105)).
- A property that is not a scalar or an array of scalars stops generation on both versions ([`NEST1107`](/reference/diagnostics#nest1107)). This covers a nested object and a nullable value.
- On OpenAPI 3.2, the object becomes one `querystring` parameter. It cannot share an operation with named query parameters or a second whole object ([`NEST1107`](/reference/diagnostics#nest1107)).
- On OpenAPI 3.1.2, an object whose constraints or codecs would be lost in the flat form stops generation ([`NEST1108`](/reference/diagnostics#nest1108)).

## Excluded endpoints

- `@ApiExcludeEndpoint()` and `@ApiExcludeEndpoint(true)` omit a route. `@ApiExcludeEndpoint(false)` keeps it.
- `@ApiOperation({ hidden: true })` omits a route. `@ApiOperation({ hidden: false })` cannot restore an endpoint that `@ApiExcludeEndpoint()` excluded.
- `@ApiExcludeController()` omits every route of a controller. `@ApiExcludeController(false)` keeps them.
- Exclude a route that has no OpenAPI form, such as `@All()` or `@Sse()`, so generation skips it.
