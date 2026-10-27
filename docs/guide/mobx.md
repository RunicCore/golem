# MobX and React

Make generated models observable and use them in React components.

With `mobx: true`, generated model fields are MobX observables.

- Annotate your class's own fields, getters and actions with normal MobX annotations.
- Nested generated models are initialized recursively and keep their identity.

Create `src/payment-editor.model.ts`:

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-definition

MobX changes observability only. Construction, `fromWireFormat` / `toWireFormat`, `parse` / `stringify` and validation keep their normal behavior.

## Enable MobX

Install MobX in the application. Your class constructors and the generated SDK models import it at runtime:

```sh
npm install mobx
```

A React app also needs `mobx-react-lite`, which provides `observer` ([Use it in React](#use-it-in-react)):

```sh
npm install mobx-react-lite
```

Set the profile and regenerate:

<<< ../../examples/payments/web/golem.yaml

`mobx: true` applies to every generator in the configuration. The example also sets `validation: true`. Validation is independent of MobX ([Validate models](/guide/validation)). An OpenAPI client also gains observable operation loading ([Call operations](/guide/client-usage#observe-loading-with-mobx)).

## Initialize your class

Call `asGenObservable(this, annotations)` once in your constructor, after `super(values)` and after your own field initializers. Later calls such as `getValidator(this).extend()` are fine. A second `asGenObservable` call on the same instance throws.

- Extra annotations are optional: `asGenObservable(this, { label: computed, toggle: action })`.
- Annotate writable state with `observable`, derived getters with `computed` and state-changing methods with `action`.
- Use `observable.ref`, `observable.shallow`, `observable.struct`, or `false` when a field should not be deeply observable.
- An [SDK model class](/guide/models-and-client) such as `TMoneyModel`, created with `new` or with `fromWireFormat`, initializes itself. An empty `class Payment extends TPaymentBaseModel {}` is not observable until its constructor calls `asGenObservable(this)`.

## Observe a model

`autorun` runs once immediately and again when a value it reads changes. `summary` is the computed getter in the class above.

`src/summary.ts`:

<<< ../../examples/payments/web/src/summary.ts#observe-payment

Dispose the reaction when the observation is no longer needed.

## Nested models

When an observable generated model contains another generated model, `asGenObservable` walks nested values through arrays, records, maps and sets.

The `golem.yaml` above generates the SDK into `sdk/` from `../server/api/openapi.yaml`, so a [model that uses SDK types](/guide/models-and-client) is observable together with its SDK types. In `src/payment-editor.model.ts`, `setAmount` edits the nested `money` model:

<<< ../../examples/payments/web/src/payment-editor.model.ts#nested-editing

Calling `setAmount('12.50')` changes `money.amount`, and the reaction above reports the new summary.

- The constructor turns the nested initializer into a generated `TMoneyModel`.
- `asGenObservable` initializes that nested model, so it needs no manual MobX call.
- `setAmount` is an action. The reaction runs after it updates `money.amount`.

## Unions and your classes

Put annotations on your class, after `super`. When a union field holds one of your classes, construct it with `new YourClass(…)`. Generated [union conversion](/guide/field-types#unions) builds only generated classes.

With `mobx: false`, generated files import no MobX.

## Use it in React

A React component imports a generated model or client like any other module. Wrap a component that reads observable fields in `observer` from `mobx-react-lite`. It re-renders when a field it read changes. Operation `loading` is observable too ([Call operations](/guide/client-usage#observe-loading-with-mobx)).

The amount field in [`src/App.tsx`](https://github.com/RunicCore/golem/blob/master/examples/payments/web/src/App.tsx), which wraps every field of the form the same way:

<<< ../../examples/payments/web/src/App.tsx#observer-component

`getValidator` reads the editor's validation issues ([Validate models](/guide/validation)) for the field to render. The field calls an action method, `setAmount`, on change.

- Import `getValidator` from `@exprtlabs/golem/validation`. When the model is generated with `mobx: true` and `validation: true`, the validator it returns is already observable, so `observer` re-renders when its issues change.
- Import it from `@exprtlabs/golem/mobx-validation` when a model is generated without both settings and a component must still re-render on its issues. It returns the same validator for that instance, made observable.

### Bind a text input to a number field

A text input holds a string. The amount field above holds text, so its input needs no draft. The instalments field holds a number, so its input keeps a draft string. The model has the number and an action:

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

- `validate({ failFast: false })` stores every error. A change to a field does not clear its old error, so validate again.
- `validator.error('note')` returns the first message of a field. The other members are in [Stored validation state](/guide/validation#stored-validation-state).
- The tags of the number field check the number. A negative amount fails `Minimum<0>`. The text of the draft is your check.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments) runs this editor against a local demo server.
