# Generate OpenAPI

Turn NestJS controller decorators and TypeScript types into an OpenAPI document, then generate a client from it.

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

`@exprtlabs/ts-to-openapi` reads this file; it doesn't start Nest or call handlers. NestJS 11 is supported.

## Install

```sh
npm install --save-dev @exprtlabs/ts-to-openapi@rc typescript@~7.0.2 ttsc@~0.30.4
```

## Describe a controller

The generator reads every `*.controller.ts` under `src/`. To choose files yourself, list them under `sources` in the [controller job](/reference/config#controller-jobs). From the controller above it writes:

- `GET /payments/{id}` with a required string path parameter `id`
- a JSON response with `id` and `note`
- the operation ID `PaymentsController_get`, which becomes the client method `paymentsController_get`

The default document version is OpenAPI 3.2. `class-validator` decorators aren't read; put constraints on the types ([type tags](/guide/tags)).

## Configure and generate

Add `runic-codegen.yaml` beside the project's TypeScript configuration and run `npx runic-codegen generate`:

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

`globalPrefix` must match `app.setGlobalPrefix()`; the generator reads controllers, not your bootstrap code. The `models` job generates `PaymentBase`. Set `openapiVersion: '3.1.2'` in the controller job when a downstream tool doesn't support 3.2.

You get `api/openapi.yaml`. The `createPayment` operation from a controller that takes and returns generated models:

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

## Generated models in a controller

<<< ../../examples/nest-openapi/src/payments.controller.ts#create-payment

<<< ../../examples/nest-openapi/src/payment.model.ts#payment-types

`@ApiOperation({ operationId: 'createPayment' })` replaces the default, so the client method is `createPayment()`.

## Generate a client from the document

Add an OpenAPI job that reads `./api/openapi.yaml` ([Generate a client](/guide/client)). One configuration can run both jobs:

<<< ../../examples/nest-openapi/runic-codegen.yaml

### Install the client and runtime packages

```sh
npm install --save-dev @exprtlabs/openapi-to-ts@rc @exprtlabs/model-codegen@rc
npm install @exprtlabs/codegen@rc ajv ajv-formats reflect-metadata @nestjs/swagger
```

<<< ../../examples/nest-openapi/src/client.ts#payment-client

## Set up TypeScript

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "plugins": [{ "transform": "@exprtlabs/codegen/ttsc-plugin", "nest": true }]
  }
}
```

Import `reflect-metadata` first in the application entry file, before any application module import. TypeScript erases the types of `@Body()`, `@Query()` and return values, so the plugin records them for the interceptor.

## Convert requests and responses

To convert `@Body()` and `@Query()` models and stringify `IModel` or `IObject` returns at runtime, register the interceptor:

<<< ../../examples/nest-openapi/src/application.ts#global-model-http

[`NestModelInterceptor`](/guide/nestjs-in-depth#nestmodelinterceptor) has the full request and response contract.

## Run the example

In `examples/nest-openapi/`, run `npm install`, `npm run generate` and `npm start`. The API listens at `http://127.0.0.1:3000/api/payments/transactions`; set `PORT` to use another port. In a second terminal, `npm run client` prints `Payment 1: USD 12.50` on a fresh server; set `API_BASE_URL` when the API runs elsewhere.

Full example: [`examples/nest-openapi`](https://github.com/exprtlabs/codegen/tree/main/examples/nest-openapi)
