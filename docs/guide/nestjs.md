# OpenAPI from controllers

Turn NestJS controller decorators and TypeScript types into an OpenAPI document, then generate a client from it.

A controller in your NestJS project, `src/payment-notes.controller.ts`:

<<< ../../examples/payments/server/src/payment-notes.controller.ts#payment-note-controller

`@exprtlabs/golem-ts-openapi` reads this file. It does not start Nest or call handlers. It supports the NestJS version in [Compatibility](/compatibility).

## Install

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi typescript@~7.1.0-beta
npm install @nestjs/swagger
```

An app that registers `NestModelInterceptor` imports `@exprtlabs/golem-ts-openapi/nest` at run time. Install `@exprtlabs/golem-ts-openapi` without `--save-dev` then, and add the [`nest` extension](/reference/config#nest-extension) to the `ts-openapi` block.

## Describe a controller

The generator reads every `*.controller.ts` file under `src/`. Set `suffixes` in the [docs job](/reference/config#ts-openapi-block) to use other endings, or list files under `sources` to choose them yourself. From the controller above it writes:

- `GET /payment-notes/{id}` with a required string path parameter `id`
- a JSON response with `id` and `note`
- the operation ID `PaymentNotesController_get`, which becomes the client method `paymentNotesController_get`

The default document version is OpenAPI 3.2. The generator reads types and [validation tags](/guide/tags), not `class-validator` decorators. Put constraints on the types.

## Configure and generate

Add `golem.yaml` beside the project's TypeScript configuration and run `npx golem generate`:

```yaml
version: 1
ts-openapi:
  docs:
    - output: ./api/openapi.yaml
      info:
        title: Payments API
        version: '1'
```

You get `api/openapi.yaml`. Set `openapiVersion: '3.1.2'` in the docs job when a downstream tool does not support 3.2. That version handles whole query objects differently ([query compatibility](/reference/nestjs#query-compatibility)).

## Models in a controller

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

<<< ../../examples/payments/server/src/payment.model.ts#payment-types

<<< ../../examples/payments/server/src/payment.model.ts#payment-class

`Payment` extends the generated `TPaymentBaseModel`, which the models job writes ([Generate a client from the document](#generate-a-client-from-the-document)). `@ApiOperation({ operationId: 'createPayment' })` replaces the default, so the client method is `createPayment()`. `@ApiBadRequestResponse` and `@ApiBadGatewayResponse` from `@nestjs/swagger` produce the `400` and `502` responses. The component name `Payment` follows the [naming rules](/reference/nestjs#component-names). The controller above produces this operation in `api/openapi.yaml`:

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
      description: ""
    "400":
      description: Invalid payment input.
    "502":
      description: The payment provider declined or is unavailable.
```

To convert and validate the request at runtime, add the `nest` extension and [register the interceptor](/guide/nestjs-requests).

## Generate a client from the document

The docs job writes `api/openapi.yaml`. An SDK job reads that document and generates the client ([Generate an SDK](/guide/client)). The example runs it from `web/golem.yaml`. The `ts-openapi` block in `server/golem.yaml`, with the docs job and the `nest` extension:

<<< ../../examples/payments/server/golem.yaml#controllers-job

`globalPrefix: api` must match `app.setGlobalPrefix()`, because the generator reads controllers and not your bootstrap code. The models job in the same configuration generates `TPaymentBaseModel`.

Install the client and runtime packages:

```sh
npm install --save-dev @exprtlabs/golem-openapi-ts @exprtlabs/golem-model typescript@~7.1.0-beta
npm install @exprtlabs/golem reflect-metadata
```

<<< ../../examples/payments/web/src/submit-payment.ts#payment-client

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
