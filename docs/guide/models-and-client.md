# Models with a client

Use an SDK type such as `Money` as a field of your own model, edit it with your methods and rules, and send the API part with the generated client.

<<< ../../examples/combined/src/payment-editor.model.ts#model-declaration

<<< ../../examples/combined/src/payment-editor.model.ts#model-methods

The generated class builds the `money` field as the SDK's runtime class, `MoneyModel`. Your `PaymentEditor` adds methods and a validation rule for `note`.

## Install

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
npm install --save-dev @exprtlabs/golem-model@rc @exprtlabs/golem-openapi@rc typescript@~7.0.2 ttsc@~0.30.4
```

Add the ttsc plugin to `tsconfig.json` and compile with `npx ttsc` ([TypeScript setup](/guide/install#typescript-setup)). Include both `src/**/*.ts` and the generated `sdk/**/*.ts` in your TypeScript program.

## Configure both generators

One configuration runs the OpenAPI job first; its `model-manifest.json` lets the model job resolve SDK types such as `Money`.

<<< ../../examples/combined/runic-codegen.yaml

The Payments API sends and returns `Money`, not the whole editor:

<<< ../../examples/combined/api.yaml

## Declare the application model

Write the declaration before the first generation. The SDK import is type-only, so it can point at the `sdk/` directory the OpenAPI job is about to create:

<<< ../../examples/combined/src/payment-editor.model.ts#model-declaration

Run `npx runic-codegen generate`. It writes `sdk/` and `src/payment-editor.model.generated.ts`, and shared files under `src/generated/models/`. Then add your `PaymentEditor` class, as at the top of this page; regeneration leaves it alone.

## Load and edit

<<< ../../examples/combined/src/payment-preview.ts#payment-example

`fromWireFormat` loads a plain object into the editor:

<<< ../../examples/combined/src/payment-preview.ts#load-from-wire

## Validate and send

Constructing `PaymentEditor` turns `money` into a `MoneyModel`. `toWireFormat(editor).money` is the plain `Money` body the client sends.

<<< ../../examples/combined/src/payment-app.ts#validate-and-save

<<< ../../examples/combined/src/payment-app.ts#send-payment

`validateInstance(editor)` returns the issues. `getValidator(editor)` keeps them on the model for a form ([Validation](/guide/validation)).

Full example: [`examples/combined`](https://github.com/exprtlabs/codegen/tree/main/examples/combined)
