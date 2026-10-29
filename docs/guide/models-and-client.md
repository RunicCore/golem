# SDK types in your models

Use an SDK type such as `TMoney` as a field of your own model, add your methods and rules, and send the API part with the generated client.

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-declaration

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-methods

The generated class builds the `money` field as the SDK's runtime class. The schema `TMoney` gives the type `TMoney` and the class `TMoneyModel` ([Generated SDK names](/reference/generated-files#generated-sdk-names)). Your `PaymentEditor` adds methods and a validation rule for `note`.

## Install

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model @exprtlabs/golem-openapi typescript@~7.1.0-beta
```

Choose how to build in [Build tools](/guide/build). Include both `src/**/*.ts` and the generated `sdk/**/*.ts` in your TypeScript program.

## Configure both generators

One configuration runs the OpenAPI job first. The model job then resolves SDK types such as `TMoney`.

<<< ../../examples/payments/web/golem.yaml

The `createPayment` operation of the Payments API takes `money` as a `TMoney`, not the whole editor. The OpenAPI `input` is the document that the server's `controllers` job writes. Run `golem generate` in `server/` before you generate the web project. The controller that produces this operation is:

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

## Declare the model

Write the declaration at the top of this page before the first generation. The SDK import is type-only, so it can point at the `sdk/` directory that the OpenAPI job is about to create.

Run `npx golem generate`. It writes `sdk/` and `src/payment-editor.model.generated.ts`. Then add your `PaymentEditor` class, as at the top of this page. Regeneration leaves it alone.

## Load and edit

<<< ../../examples/payments/web/src/summary.ts#payment-example

`fromWireFormat` loads a plain object into the editor:

<<< ../../examples/payments/web/src/summary.ts#load-from-wire

## Validate and send

Before you send, `getValidator(editor).validate({ failFast: false })` checks every field and keeps the errors on the editor for a form ([Validate models](/guide/validation)).

<<< ../../examples/payments/web/src/payment-store.ts#validate-and-save

`toWireFormat<TPaymentEditor>(editor, { validate: false })` returns the plain object. The editor passed the check above, so `validate: false` skips a second one. Its `money` field is the plain `TMoney` object that the client sends.

<<< ../../examples/payments/web/src/payment-store.ts#send-payment

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
