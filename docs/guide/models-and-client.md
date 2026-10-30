# SDK types in your models

Use an SDK type such as `TMoney` as a field of your own model, add your methods and rules, and send the API part with the generated client.

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-declaration

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-methods

## What an SDK type is

- An SDK holds types, not classes, in both [SDK modes](/reference/config#sdk-modes). The schema `TMoney` gives the type `TMoney` ([Generated SDK names](/reference/generated-files#generated-sdk-names)).
- The client returns plain objects of that type. Its dates are already `Date` or `Temporal` values ([Call operations](/guide/client-usage)).
- A class with methods, MobX or `instanceof` is your own model. You declare it with `IModel<…>` over the SDK type.
- Your `PaymentEditor` adds methods and a validation rule for `note`. Its `money` field is a plain `TMoney` object.

| | Golem mode | Standalone mode |
| --- | --- | --- |
| Your model reads | The schema graph of the SDK, as data | The TypeScript fields of the SDK type |
| Checks and conversions | One set for the SDK and your models, written by the `models` job | The SDK keeps its own. Your model gets its own |
| Limits of the schema | Kept in your model, such as `maxLength` | Only what the TypeScript type states |
| Needs | `mode: golem` and a `models` section | A TypeScript type that golem can derive |

## Install

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model @exprtlabs/golem-openapi typescript@~7.1.0-beta
```

Choose how to build in [Build tools](/guide/build). Include both `src/**/*.ts` and the generated `sdk/**/*.ts` in your TypeScript program.

## Configure both generators

One configuration runs the OpenAPI job first. The model job then resolves SDK types such as `TMoney`. This example uses golem mode, so the `models` job writes the checks and conversions of the SDK together with your model.

<<< ../../examples/payments/web/golem.yaml

The `createPayment` operation of the Payments API takes `money` as a `TMoney`, not the whole editor. The OpenAPI `input` is the document that the server's `controllers` job writes. Run `golem generate` in `server/` before you generate the web project. The controller that produces this operation is:

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

- `mode: golem` needs a `models` section in the same file.
- Leave `mode` out for a standalone SDK. The model job then derives your model from the TypeScript fields of the SDK type.
- With `dates: temporal`, the SDK types name the global `Temporal`. Add `"esnext.temporal"` to `compilerOptions.lib`, or set `skipLibCheck: true`, and load a `Temporal` at run time ([Dates and times](/guide/field-types#dates-and-times)).

## Declare the model

Write the declaration at the top of this page before the first generation. The SDK import is type-only, so it can point at the `sdk/` directory that the OpenAPI job is about to create.

Run `npx golem generate`. It writes `sdk/` and `src/payment-editor.model.generated.ts`. Then add your `PaymentEditor` class, as at the top of this page. Regeneration leaves it alone.

## Load and edit

<<< ../../examples/payments/web/src/summary.ts#payment-example

`fromWireFormat` loads JSON that did not come through the client into the editor:

<<< ../../examples/payments/web/src/summary.ts#load-from-wire

- Call `fromWireFormat<T>` for your own models only, for data that bypasses the client: a queue message, saved state or test data.
- Data from the client needs no conversion call. The client returns checked values, so pass them to the constructor.

## Put client data in a model

A model can have the SDK type itself as its fields. `IModel<Charge>` makes a model with the fields of `Charge`. The class has its own constructor, and its values come first:

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-view

- `new ChargeView(response.body)` takes the converted body of the client. It runs no second check.
- `super(values)` assigns the fields of `Charge` first. `fetchedAt` is app state. It is not a field of `Charge`, so golem never sends or checks it.
- `fromWireFormat<ChargeView>(json)` passes values only, so `fetchedAt` takes its default.
- An instance of your model is a valid request body. The client writes its declared fields only.

A model can also hold the type as a field. This model adds `isOverdue()`:

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-record-declaration

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-record-class

- The field `charge: Charge` is a plain `Charge`. Its `settlesOn` is a `Temporal.PlainDate`.
- `isOverdue` takes today's date as an argument, so a test can fix the date. The settlement day itself is not overdue.

## Levels and limits

- A model over an SDK type has its own level. It may lower the level of the project, and it cannot raise it ([validation levels](/reference/config#validation-profiles)).
- In golem mode, the model keeps the limits of the SDK type, such as `maxLength` and `pattern`.
- The client does not return your model. It returns the SDK type. Build your model where you need it.

## Validate and send

Before you send, `getValidator(editor).validate({ failFast: false })` checks every field and keeps the errors on the editor for a form ([Validate models](/guide/validation)).

<<< ../../examples/payments/web/src/payment-store.ts#validate-and-save

`toWireFormat<TPaymentEditor>(editor, { validate: false })` returns the plain object. The editor passed the check above, so `validate: false` skips a second one. Its `money` field is the plain `TMoney` object that the client sends.

<<< ../../examples/payments/web/src/payment-store.ts#send-payment

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
