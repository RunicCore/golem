# Generate OpenAPI

Turn NestJS controller decorators and TypeScript types into an OpenAPI document, then generate a client from it.

A controller in your NestJS project, `src/payment-notes.controller.ts`:

<<< ../../examples/payments/server/src/payment-notes.controller.ts#payment-note-controller

`@exprtlabs/golem-ts-openapi` reads this file; it doesn't start Nest or call handlers. NestJS 11 is supported.

## Install

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi@rc typescript@~7.0.2
npm install @nestjs/swagger
```

## Describe a controller

The generator reads every `*.controller.ts` under `src/`. To choose files yourself, list them under `sources` in the [controller job](/reference/config#controller-jobs). From the controller above it writes:

- `GET /payment-notes/{id}` with a required string path parameter `id`
- a JSON response with `id` and `note`
- the operation ID `PaymentNotesController_get`, which becomes the client method `paymentNotesController_get`

The default document version is OpenAPI 3.2. `class-validator` decorators aren't read; put constraints on the types ([type tags](/guide/tags)).

## Configure and generate

Add `golem.yaml` beside the project's TypeScript configuration and run `npx golem generate`:

```yaml
version: 1
controllers:
  - framework: nestjs
    root: .
    output: ./api/openapi.yaml
    info:
      title: Payments API
      version: '1'
```

Set `openapiVersion: '3.1.2'` in the controller job when a downstream tool doesn't support 3.2. You get `api/openapi.yaml`.

## Generated models in a controller

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

<<< ../../examples/payments/server/src/payment.model.ts#payment-types

<<< ../../examples/payments/server/src/payment.model.ts#payment-class

`Payment` extends the generated `TPaymentBaseModel`, which the `models` job writes ([Generate a client from the document](#generate-a-client-from-the-document)). `@ApiOperation({ operationId: 'createPayment' })` replaces the default, so the client method is `createPayment()`. `@ApiBadRequestResponse` and `@ApiBadGatewayResponse` from `@nestjs/swagger` produce the `400` and `502` responses. The controller above produces this operation in `api/openapi.yaml`:

```yaml
post:
  operationId: createPayment
  requestBody:
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/TPaymentInput"
    required: true
  responses:
    "201":
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Payment"
      description: Created
    "400":
      description: Invalid payment input.
    "502":
      description: The payment provider declined or is unavailable.
```

### Component names

A model's component name comes from the types it was declared with:

| Declaration | Component |
| --- | --- |
| `class Payment extends TPaymentBaseModel {}` for `type TPayment = IModel<…>` | `Payment`, the class name |
| Two or more classes extending `TPaymentBaseModel` | `TPayment`, the exact alias |
| `type TMerchant = IModel<…>` with no class | `TMerchant`, the exact alias |
| `type TPaymentInput = IObject<…>` | `TPaymentInput`, the exact alias |

`@ApiSchema({ name })` on a class still sets its name. A type derived from a model, such as `Omit<TMerchant, 'id'>`, is named from the model's component, as in `TMerchantOmitId`. Two models with the same component name and an identical schema share one component. Two with the same name and different schemas are qualified by where they are declared. Each takes the shortest trailing run of its file's directory segments, relative to the project root, that tells the models apart, joined with `.`: `orders.Payment` and `billing.Payment`. Models in the same directory add the file name without `.model.ts` or `.ts`: `billing.payment.Payment` and `billing.refund.Payment`. Characters other than letters, digits and underscores in a segment become `_`.

## Generate a client from the document

The controller job writes `api/openapi.yaml`. An OpenAPI job reads that document and generates the client ([Generate a client](/guide/client)); the example runs it from `web/golem.yaml`. The controller job in `server/golem.yaml`:

<<< ../../examples/payments/server/golem.yaml#controllers-job

`globalPrefix: api` must match `app.setGlobalPrefix()`; the generator reads controllers, not your bootstrap code. The `models` job in the same configuration generates `TPaymentBaseModel`.

### Install the client and runtime packages

```sh
npm install --save-dev @exprtlabs/golem-openapi@rc @exprtlabs/golem-model@rc
npm install @exprtlabs/golem@rc ajv ajv-formats reflect-metadata
```

<<< ../../examples/payments/web/src/submit-payment.ts#payment-client

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

With a `controllers` job in `golem.yaml`, the rewrite records `@Body()`, `@Query()` and return types for Nest. Every host applies it: [`golem build`](/reference/cli#build), the [loader](/reference/runtime-api#loader) and the [Vite](/reference/runtime-api#vite) and [esbuild](/reference/runtime-api#esbuild) plugins. Run `npx golem generate` first, then build with `npx golem build`.

Import `reflect-metadata` first in the application entry file, before any application module import. TypeScript erases the types of `@Body()`, `@Query()` and return values, so the rewrite records them for `NestModelInterceptor`, which converts and validates requests and responses.

## Convert requests and responses

To convert `@Body()` and `@Query()` models and stringify `IModel` or `IObject` returns at runtime, register the interceptor:

<<< ../../examples/payments/server/src/application.ts#global-model-http

[`NestModelInterceptor`](/guide/nestjs-in-depth#nestmodelinterceptor) has the full request and response contract.

## Run the example

The example is in the Golem repository's [`examples/payments/`](https://github.com/RunicCore/golem/tree/master/examples/payments); the controllers are under `server/`. There, run `npm install`, `npm run generate` and `npm start`. The API listens at `http://127.0.0.1:3000/api/payments/transactions`: `globalPrefix: api` plus the controller route `payments/transactions`. Set `API_PORT` to use another port. `npm run demo` starts the API on a free port with a stand-in payment provider, submits one payment through the generated client and prints a line that begins `Payment 1: USD 12.50`.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
