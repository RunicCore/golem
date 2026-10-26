# Convert requests

Convert and validate the `@Body()` and `@Query()` models of your NestJS 11 controllers, and write model responses as JSON.

The types in your controller signatures drive both the OpenAPI schema and the runtime conversion. [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments) combines the sections below in one app.

## Set up TypeScript

Add these options to the `tsconfig.json` from [Quick start](/guide/quick-start):

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Import `reflect-metadata` first in the application entry file, before any application module import.

TypeScript erases the types of `@Body()`, `@Query()` and return values. With a `controllers` job in `golem.yaml`, the build rewrite records them for `NestModelInterceptor`.

- Every host applies the rewrite ([Build your app](/guide/build)).
- The rewrite also loads the generated module of each model it records, so the codec exists before the first request.
- Write the parameter type and the return type explicitly, because the rewrite reads the annotation.

## Register the interceptor

`NestModelInterceptor` runs `fromWireFormat` on `@Body()` and `@Query()` before the handler. It writes an `IModel` or `IObject` return with `stringify`. It works with the Express and Fastify adapters.

<<< @/../examples/payments/server/src/application.ts#global-model-http

Declare a model and use it as a `@Body()` type:

<<< ../../examples/payments/server/src/payment-draft.model.ts#payment-draft

Add a method to your controller:

<<< ../../examples/payments/server/src/payments.controller.ts#draft-method

## What happens to a request

The interceptor converts HTTP handlers. A handler of another context, such as RPC, passes through unchanged.

1. `fromWireFormat` runs on each `@Body()` and `@Query()` parameter with fail-fast validation.
2. Input that fails validation or cannot be decoded returns HTTP 400 with `issues` (`LibError.causedByInput`). Examples are a broken constraint, an unknown discriminator tag and an unparsable date.
3. Valid input reaches the handler as a model. A type alias stays a plain object, and your class is constructed.
4. An `IModel` or `IObject` return is stringified with that type. This includes a `Promise` or an array of that type. A return that the rewrite did not mark stays Nest JSON. Examples are a handler with no written return type and a handler that returns a union.
5. An application converter that throws, and missing generated metadata, return HTTP 500. A marked return whose generated model did not load fails the request with HTTP 500 before the handler runs.

`@Param()` and `@Headers()` stay as Nest received them.

## Parameter types and arrays

Every `@Body()` and `@Query()` parameter needs an `IModel` or `IObject` type, or a [union of models](#union-of-models):

- **Accepted types:** an `IModel`, an `IObject`, your class that extends a generated model class, or a tagged union of models.
- **`@Query()`:** it needs one object model or a tagged union of models. A union with no shared tag, such as `TFilterA | TFilterB` without a tag field, stops with [`RUNM1081`](/reference/diagnostics#runm1081).
- **Other types:** the interceptor throws a `TypeError` that names the controller, the method and the parameter. Nest answers HTTP 500. This holds for a plain interface, a plain class, a primitive and a parameter with no type.
- **Timing:** the interceptor throws on each request to the handler, not at startup. Return types are not affected.
- **Build report:** `golem build` and `golem check` report [`RUNM1081`](/reference/diagnostics#runm1081) for a typed parameter of that kind.
- **Option `nonModelInputs`:** if your own interceptor handles those parameters, set `nonModelInputs: warn` in [golem.yaml](/reference/config#root-keys). The error becomes a warning.

A whole `@Body()` parameter reads the request body as follows:

| Request body | Declared type | Result |
| --- | --- | --- |
| A JSON object | `@Body() payment: TPayment` | Converts to the model. Invalid input returns HTTP 400. |
| A JSON array | `@Body() items: Item[]` | Converts item by item. An invalid item returns HTTP 400. Each issue path starts with the item index, such as `[1, 'name']`. |
| A value that is not an array | `@Body() items: Item[]` | Returns HTTP 400 with a `type` issue. |

A whole `@Query()` is an object, so declare it as one model and not as an array.

- Give all whole `@Body()` parameters of a handler one model type. The same rule holds for whole `@Query()` parameters.
- Name one field with `@Body('payment') payment: TPayment` or `@Query('filter') filter: TFilter` when the model sits under one key. Its type is an `IModel` or `IObject`, and the parameter is required: an optional `payment?: TPayment` stops the `controllers` job, because the interceptor answers HTTP 400 for a missing value.
- A one-field `@Body('items') items: TPayment[]` takes an array of models. The interceptor converts it item by item, and an invalid item returns HTTP 400 with the path `['items', 1, 'name']`. A one-field `@Query` cannot be an array of models: the `controllers` job reports [`NEST1107`](/reference/diagnostics#nest1107).
- Do not mix a whole `@Body()` and a one-field `@Body('field')` in one handler. The same rule holds for `@Query()`. The `controllers` job reports [`NEST1103`](/reference/diagnostics#nest1103) for a mixed body and [`NEST1107`](/reference/diagnostics#nest1107) for a mixed query.
- A one-field `@Query` model has no array field at any depth. OpenAPI does not define arrays in a `deepObject` parameter, and the `controllers` job reports [`NEST1107`](/reference/diagnostics#nest1107). Send an array in a `@Body`, or in a whole `@Query()` on OpenAPI 3.2.

The `controllers` job writes the one-field `@Body` parameters as the properties of one object request body. It writes a one-field `@Query` model as a `deepObject` query parameter, such as `?filter[status]=paid`. The app must parse nested query keys:

- Express 5 reads `filter[status]` as one flat key by default. Set the parser once: `app.set('query parser', 'extended')` on the Express instance, which a Nest app gets from `app.getHttpAdapter().getInstance()`.
- Fastify has the same default. Pass a parser that reads nested keys, such as `qs.parse`, as the `querystringParser` option of `new FastifyAdapter({ querystringParser })`.

## Query objects

HTTP query values are strings, and repeated keys arrive as string arrays. Declare the query as an `IObject`. Before `fromWireFormat`, `NestModelInterceptor` decodes each field to the type its schema declares:

| Field type | Query text | Decoded value |
| --- | --- | --- |
| `number` or `Integer` | `?limit=42` | `42` |
| `boolean` | `?active=true` | `true` |
| A number or boolean literal, such as `42` or `true` | `?mode=42` | `42` |
| An array field given one value | `?status=paid` | `['paid']` |

- A value that does not fit the declared type stays a string, so validation rejects it with HTTP 400.
- A field that also accepts a string keeps it. For `string | number`, `'42'` stays `'42'`.
- A JSON body keeps its own types and is not decoded.

<<< @/../examples/payments/server/src/payment.model.ts#payment-filter

<<< @/../examples/payments/server/src/payments.controller.ts#query-method

- `GET /api/payments/transactions?limit=10&status=paid` yields `{ limit: 10, status: 'paid' }`.
- Repeated `status=paid&status=pending` yields `{ status: ['paid', 'pending'] }`.
- `limit=abc`, `status=refunded`, and undeclared keys (`exact: true`) return HTTP 400 before the handler.
- `PaymentStatus | PaymentStatus[]` is the [supported query union](/guide/field-types#unions).

OpenAPI 3.2 emits the whole query schema, and its SDK calls `.execute({ querystring: { limit: 10, status: ['paid'] } })`. OpenAPI 3.1.2 flattens a query object into named parameters ([query compatibility](/reference/nestjs#query-compatibility)).

## Extra properties

The `exact` option decides whether a model rejects keys that it does not declare ([Objects and exact](/guide/field-types#objects-and-exact)).

- A named `IObject` or `IModel` keeps its own `exact`. Without the option, it takes the `exact` key of `golem.yaml`, and that key defaults to `true`.
- A type that you spell out inline in a controller signature is read with `exact` set to `false`. Its schema admits extra properties.
- The example models set `{ exact: true }`, which repeats the default. You can leave it out. Keep it when `golem.yaml` sets `exact: false` and the model must stay exact.

## Union of models

A whole `@Body()` or `@Query()` parameter can be a union of models, such as `TCircle | TRect` or an alias of one. Each model needs a required literal field with a value of its own, such as `kind: 'circle'` ([unions](/guide/field-types#unions)).

- The interceptor reads the tag and converts the input with the model that the tag picks. A missing or unknown tag returns HTTP 400.
- A query string holds the tag as text. The interceptor decodes it to the type that the picked model declares.
- The `controllers` job documents a body as `oneOf` with a `discriminator`. A query union needs OpenAPI 3.2; OpenAPI 3.1.2 stops with [`NEST1108`](/reference/diagnostics#nest1108).
- A union converts only as a whole parameter. An array of a union and a union in `@Body('field')` stop with [`RUNM1081`](/reference/diagnostics#runm1081).
- A union of models with no shared tag stops with [`RUNM1081`](/reference/diagnostics#runm1081).
- A union return stays Nest JSON.
- A custom interceptor cannot read a union binding: `objectCodecFromMetatype` returns nothing for a union parameter.

## Model responses

The interceptor stringifies a return only when its declared type is a model:

| Declared return type | Response |
| --- | --- |
| `IModel` or `IObject`, including a `Promise` of that type | That type's JSON |
| Array of that type | JSON array of those values |
| Primitive, plain object, file, non-model class, or a union | Nest JSON |

Declare a wrapper object as a model when its fields need conversion, because the interceptor does not look inside a plain wrapper.

To write the response with a codec other than the one of the declared return type, use `nestModelStringifyInterceptor`. Get that codec with `objectCodecFromMetatype` from a `@Body()` or `@Query()` parameter that is already typed with the target class. The imports are in the [runtime API](/reference/runtime-api#nest).

## Run with the Node loader

Node's type stripping rejects the parameter decorators of a NestJS controller. The Node loader compiles each file that has a decorator with your TypeScript, so the app needs no second loader.

1. Set `experimentalDecorators` and `emitDecoratorMetadata` in the tsconfig that `golem.yaml` names.
2. Run the entry file through golem's loader:

```sh
node --import @exprtlabs/golem/register src/main.ts
```

The [`register`](/reference/runtime-api#register) entry describes the loader.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
