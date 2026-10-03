# Models with a client

Use an SDK type such as `TMoney` as a field of your own model, edit it with your methods and rules, and send the API part with the generated client.

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-declaration

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-methods

The generated class builds the `money` field as the SDK's runtime class, `TMoneyModel`. Your `PaymentEditor` adds methods and a validation rule for `note`.

## Install

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
npm install --save-dev @exprtlabs/golem-model@rc @exprtlabs/golem-openapi@rc typescript@~7.0.2
```

Build with `npx golem build`, the Vite or esbuild plugin, or the Node loader ([TypeScript setup](/guide/install#typescript-setup)). Include both `src/**/*.ts` and the generated `sdk/**/*.ts` in your TypeScript program.

## Configure both generators

One configuration runs the OpenAPI job first; its `model-manifest.json` lets the model job resolve SDK types such as `TMoney`.

<<< ../../examples/payments/web/golem.yaml

The Payments API's `createPayment` operation takes `money` as a `TMoney`, not the whole editor. The OpenAPI document is generated (`server/api/openapi.yaml`); the controller that produces this operation is:

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

## Declare the application model

Write the declaration before the first generation. The SDK import is type-only, so it can point at the `sdk/` directory the OpenAPI job is about to create:

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-declaration

Run `npx golem generate`. It writes `sdk/` and `src/payment-editor.model.generated.ts`, and shared files under `src/generated/models/`. Then add your `PaymentEditor` class, as at the top of this page; regeneration leaves it alone.

## Load and edit

<<< ../../examples/payments/web/src/summary.ts#payment-example

`fromWireFormat` loads a plain object into the editor:

<<< ../../examples/payments/web/src/summary.ts#load-from-wire

## Validate and send

Before sending, `getValidator(editor).validate({ failFast: false })` checks every field and keeps the errors on the editor for a form ([Validation](/guide/validation)). Constructing `PaymentEditor` turns `money` into a `TMoneyModel`; `encodeGeneratedModel(editor)` returns the plain object, so `wire.money` is the plain `TMoney` object the client sends.

<<< ../../examples/payments/web/src/payment-store.ts#validate-and-save

<<< ../../examples/payments/web/src/payment-store.ts#send-payment

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
