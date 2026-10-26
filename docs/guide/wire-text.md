# Keep a number in code and text on the wire

Hold money as integer cents and a priority as a number in your code, while the JSON keeps decimal text and a word, and edit the model in a form.

## A field with two forms

A JSON order holds text that people and other systems read. Your code needs numbers to add, sort and compare.

| Field | In your code | On the wire |
| --- | --- | --- |
| `amount` | `1250`, an integer in cents | `"12.50"`, decimal text |
| `priority` | `3` | `"high"` |
| `remindAt` | a `Date` | `"2025-01-02T03:04:05.000Z"` |

The code value of each field differs from its wire value. You have two ways to convert it:

- Write a mapper for each direction. Call it at every place where JSON enters or leaves your code.
- Declare the field with `TSerde`. Golem then converts the field each time `parse`, `stringify`, `fromWireFormat` or `toWireFormat` handles the model, also when the model is nested. It checks the value on both sides.

`TSerde` names two functions. The first turns the code value into the wire value. The second turns the wire value back into the code value. Use it for each field whose code value differs from its wire value.

Steps 2 and 3 use one order model of the examples. It holds the three fields side by side, as a model of your own does.

## Step 1: Install

Install the runtime, the generator and the React binding. `mobx-react-lite` gives you `observer`:

```sh
npm install @exprtlabs/golem mobx mobx-react-lite
npm install --save-dev @exprtlabs/golem-model
```

## Step 2: Write the two functions in their own module

Priority is a number in code and a word on the wire:

<<< ../../examples/models/src/priority-word.ts#priority-word

An amount is an integer in cents in code and decimal text on the wire:

<<< ../../examples/models/src/decimal-text.ts#decimal-text

- Export each function. Each function is synchronous and takes one parameter.
- Type the parameter of the second function as the wire value. `PriorityWord` limits the words, and `DecimalText` limits the text to a pattern. Golem checks the wire value against this type before it calls the function.
- Keep the functions out of the model file. The generated file imports the functions, and the model file imports the generated file. A function in the model file makes the two files import each other, and generation stops with [RUNM1065](/reference/diagnostics#runm1065).

## Step 3: Declare the fields with TSerde and tags

Write `typeof` each function in `TSerde`, and import the functions as types:

<<< ../../examples/models/src/order.model.ts#order-declaration

- Tags on the field type, such as `Integer` and `Minimum<0>`, check the code value. They run after decoding and before encoding.
- Generation never runs your functions.

The `remindAt` field is a `Date` and needs no `TSerde`. Golem writes it as an ISO text and reads it back as a `Date`.

- A `Date` does not keep its text. Golem writes it in UTC with milliseconds. The text `"2025-01-02T03:04:05+07:00"` reads as the same instant and writes back as `"2025-01-01T20:04:05.000Z"`.
- To keep the exact text, declare the field as `string & Format<'date-time'>`. Golem checks the RFC 3339 format and keeps the string as it is ([Formats](/guide/tags#formats)).
- `Date & TSerde<…>` works when the wire text needs another form. The model still holds a `Date`, so it cannot keep the original text.

[Use Date fields](/guide/dates#use-date-fields) shows the full rules.

## Step 4: Generate

```sh
npx golem generate
```

- Set `mobx: true` at the top level of `golem.yaml` ([Enable MobX](/guide/mobx#enable-mobx)). Validation is on by default.
- `golem build` generates again. It also rewrites the `parse` and `stringify` calls, and `tsc` does not ([Build your app](/guide/build)).

## Step 5: Parse the JSON

<<< ../../examples/models/src/order-json.ts#read-order

- `parse<Order>` returns an `Order`. For `"12.50"`, its `amount` is `1250`. For `"high"`, its `priority` is `3`.
- `parse<TOrder>` returns a plain object with the same fields.
- A wire value that fails its type makes `parse` throw a `LibError`. Examples are a word that is not in the list and a text that does not match the pattern ([Errors and issues](/guide/validation#errors-and-issues)).

## Step 6: Bind a form

### Bind a text input to a number field

The amount field of the payments editor binds an input to a model field, reads the error of that field and re-renders when the model changes. Its field holds text, so the input needs no draft:

<<< ../../examples/payments/web/src/App.tsx#observer-component

The instalments field holds a number, so its input keeps a draft string. The model has the number and an action:

<<< ../../examples/payments/web/src/split-editor.model.ts#split-model

The store converts the draft and calls the action only when the draft converts:

<<< ../../examples/payments/web/src/payment-store.ts#draft-conversion

<<< ../../examples/payments/web/src/payment-store.ts#draft-number

- Mark `partsDraft` observable, `partsDraftError` computed and `setPartsDraft` an action in `makeObservable`.

The input shows the draft, never the number. It also shows the message for a draft that does not convert:

<<< ../../examples/payments/web/src/App.tsx#number-input

### Show field errors

Validate the editor. The errors then appear in the validator that each field reads:

<<< ../../examples/payments/web/src/payment-store.ts#validate-and-save

- Import `getValidator` from `@exprtlabs/golem/validation` for a model that you generated with `mobx: true` and `validation: true`. Its validator is already observable.
- Import it from `@exprtlabs/golem/mobx-validation` for a model that you generated without `mobx: true`, when you still want a validator that React components observe.
- `validate({ failFast: false })` stores every error. A change to a field does not clear its old error, so validate again.
- `validator.error('priority')` returns the first message of a field. The other members are in [Stored validation state](/guide/validation#stored-validation-state).
- The tags of the number field check the number. A negative amount fails `Minimum<0>`. The text of the draft is your check.
- Wrap the component in `observer`. It re-renders when the errors change.

## Step 7: Write back with stringify

<<< ../../examples/models/src/order-json.ts#write-order

- `stringify` calls the first function of each `TSerde`. Priority `3` becomes `"high"`, and `1250` becomes `"12.50"`. A `Date` becomes UTC text with milliseconds.
- It checks the code value and the wire value. A model that is not valid makes it throw a `LibError`, so validate in the form first.
- `JSON.stringify(model)` does not convert the fields ([JSON conversion](/guide/serialization#model-value-and-json-value)).

## Look up the details

- [`TSerde`](/reference/runtime-api#tserde): the signature, the rules and the failures.
- [Change the JSON form](/guide/serialization#change-the-json-form): the usage and the checks.
- [MobX and React](/guide/mobx): observable models and `observer`.
- [Dates and times](/guide/dates): `Date` and Temporal fields.

Full examples: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models) and [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
