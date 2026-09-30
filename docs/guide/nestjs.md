# Generate OpenAPI

Turn NestJS controller decorators and TypeScript types into an OpenAPI document, then generate a client from it.

A controller in your NestJS project, `src/payments.controller.ts`:

```ts
import { Controller, Get, Param } from '@nestjs/common';

interface Payment {
  id: string;
  note: string;
}

@Controller('payments')
export class PaymentsController {
  @Get(':id')
  public get(@Param('id') id: string): Payment {
    return { id, note: 'Order 123' };
  }
}
```

`@exprtlabs/golem-ts-openapi` reads this file; it doesn't start Nest or call handlers. NestJS 11 is supported.

## Install

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi@rc typescript@~7.0.2 ttsc@~0.30.4
npm install @nestjs/swagger
```

## Describe a controller

The generator reads every `*.controller.ts` under `src/`. To choose files yourself, list them under `sources` in the [controller job](/reference/config#controller-jobs). From the controller above it writes:

- `GET /payments/{id}` with a required string path parameter `id`
- a JSON response with `id` and `note`
- the operation ID `PaymentsController_get`, which becomes the client method `paymentsController_get`

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

<<< ../../examples/nest-openapi/src/payments.controller.ts#create-payment

<<< ../../examples/nest-openapi/src/payment.model.ts#payment-types

<<< ../../examples/nest-openapi/src/payment.model.ts#payment-class

`Payment` extends the generated `PaymentBase`, which the `models` job writes ([Generate a client from the document](#generate-a-client-from-the-document)). `@ApiOperation({ operationId: 'createPayment' })` replaces the default, so the client method is `createPayment()`. `@ApiBadRequestResponse` from `@nestjs/swagger` produces the `400` response. The controller above produces this operation in `api/openapi.yaml`:

```yaml
post:
  operationId: createPayment
  requestBody:
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/PaymentInput"
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
```

## Generate a client from the document

Add an OpenAPI job that reads `./api/openapi.yaml` ([Generate a client](/guide/client)). One configuration can run both jobs:

<<< ../../examples/nest-openapi/golem.yaml

`globalPrefix: api` must match `app.setGlobalPrefix()`; the generator reads controllers, not your bootstrap code. The `models` job generates `PaymentBase`.

### Install the client and runtime packages

```sh
npm install --save-dev @exprtlabs/golem-openapi@rc @exprtlabs/golem-model@rc
npm install @exprtlabs/golem@rc ajv ajv-formats reflect-metadata
```

<<< ../../examples/nest-openapi/src/client.ts#payment-client

## Set up TypeScript

Add these options to the `tsconfig.json` from [Quick start](/guide/quick-start). `"nest": true` makes the [plugin](/reference/runtime-api#ttsc-plugin) record `@Body()`, `@Query()` and return types for Nest.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "plugins": [{ "transform": "@exprtlabs/golem/ttsc-plugin", "nest": true }]
  }
}
```

Import `reflect-metadata` first in the application entry file, before any application module import. TypeScript erases the types of `@Body()`, `@Query()` and return values, so the plugin records them for `NestModelInterceptor`, which converts and validates requests and responses.

## Convert requests and responses

To convert `@Body()` and `@Query()` models and stringify `IModel` or `IObject` returns at runtime, register the interceptor:

<<< ../../examples/nest-openapi/src/application.ts#global-model-http

[`NestModelInterceptor`](/guide/nestjs-in-depth#nestmodelinterceptor) has the full request and response contract.

## Run the example

The example is in the Golem repository's [`examples/nest-openapi/`](https://github.com/exprtlabs/codegen/tree/main/examples/nest-openapi). There, run `npm install`, `npm run generate` and `npm start`. The API listens at `http://127.0.0.1:3000/api/payments/transactions`: `globalPrefix: api` plus the controller route `payments/transactions`. Set `PORT` to use another port. In a second terminal, `npm run client` prints `Payment 1: USD 12.50` on a fresh server; set `API_BASE_URL` when the API runs elsewhere.

Full example: [`examples/nest-openapi`](https://github.com/exprtlabs/codegen/tree/main/examples/nest-openapi)
