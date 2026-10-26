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

## Describe a controller

The generator reads every `*.controller.ts` file under `src/`. Set `suffixes` in the [controller job](/reference/config#controller-jobs) to use other endings, or list files under `sources` to choose them yourself. From the controller above it writes:

- `GET /payment-notes/{id}` with a required string path parameter `id`
- a JSON response with `id` and `note`
- the operation ID `PaymentNotesController_get`, which becomes the client method `paymentNotesController_get`

The default document version is OpenAPI 3.2. The generator reads types and [validation tags](/guide/tags), not `class-validator` decorators. Put constraints on the types.

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

You get `api/openapi.yaml`. Set `openapiVersion: '3.1.2'` in the controller job when a downstream tool does not support 3.2. That version handles whole query objects differently ([query compatibility](/reference/nestjs#query-compatibility)).

## Models in a controller

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

<<< ../../examples/payments/server/src/payment.model.ts#payment-types

<<< ../../examples/payments/server/src/payment.model.ts#payment-class

`Payment` extends the generated `TPaymentBaseModel`, which the `models` job writes ([Generate a client from the document](#generate-a-client-from-the-document)). `@ApiOperation({ operationId: 'createPayment' })` replaces the default, so the client method is `createPayment()`. `@ApiBadRequestResponse` and `@ApiBadGatewayResponse` from `@nestjs/swagger` produce the `400` and `502` responses. The component name `Payment` follows the [naming rules](/reference/nestjs#component-names). The controller above produces this operation in `api/openapi.yaml`:

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

To convert and validate the request at runtime, [register the interceptor](/guide/nestjs-requests).

## Generate a client from the document

The controller job writes `api/openapi.yaml`. An OpenAPI job reads that document and generates the client ([Generate a client](/guide/client)). The example runs it from `web/golem.yaml`. The controller job in `server/golem.yaml`:

<<< ../../examples/payments/server/golem.yaml#controllers-job

`globalPrefix: api` must match `app.setGlobalPrefix()`, because the generator reads controllers and not your bootstrap code. The `models` job in the same configuration generates `TPaymentBaseModel`.

Install the client and runtime packages:

```sh
npm install --save-dev @exprtlabs/golem-openapi @exprtlabs/golem-model
npm install @exprtlabs/golem reflect-metadata
```

<<< ../../examples/payments/web/src/submit-payment.ts#payment-client

## Run the example

The example is in the Golem repository's [`examples/payments/`](https://github.com/RunicCore/golem/tree/master/examples/payments). The controllers are under `server/`. Run these steps in `examples/payments/`:

1. Run `npm install`.
2. Run `npm run generate`.
3. Run `npm start`. The API listens at `http://127.0.0.1:3000/api/payments/transactions`, which is `globalPrefix: api` plus the controller route `payments/transactions`.

Set `API_PORT` to use another port.

To see the whole flow, run `npm run demo`. It starts the API on a free port with a stand-in payment provider and submits one payment through the generated client. It prints a line that begins `Payment 1: USD 12.50`.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
