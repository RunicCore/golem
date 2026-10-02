# MobX and React

Make generated models observable and use them in React components.

With `mobx: true`, generated model fields are MobX observables.

- Annotate your class's own fields, getters and actions with normal MobX annotations.
- Nested generated models are initialized recursively and keep their identity.

Create `src/payment-editor.model.ts`:

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-definition

MobX changes observability only. Construction, `fromWireFormat` / `toWireFormat`, `parse` / `stringify` and validation keep their normal behavior.

## Enable MobX

Install MobX in the application; your class constructors and the generated SDK models import it at runtime:

```sh
npm install mobx
```

Set the profile and regenerate:

<<< ../../examples/payments/web/golem.yaml

`mobx: true` applies to every generator in the configuration. The example also sets `validation: true`; validation is independent of MobX ([Validation](/guide/validation)). An OpenAPI client
also gains observable operation loading ([SDK loading state](/guide/client-usage#observe-loading-with-mobx)).

## Initialize your class

Call `asGenObservable(this, annotations)` once in your constructor, after `super(values)` and after your own field initializers. Later calls such as `getValidator(this).extend()` are fine; a second `asGenObservable` call on the same instance throws.

- Extra annotations are optional: `asGenObservable(this, { label: computed, toggle: action })`.
- Annotate writable state with `observable`, derived getters with `computed` and state-changing methods with `action`.
- Use `observable.ref`, `observable.shallow`, `observable.struct`, or `false` when a field should not be deeply observable.
- `asGenObservable` runs once per instance. An [SDK model class](/guide/models-and-client) such as `TMoneyModel`, created with `new` or with `fromWireFormat`, initializes itself. An empty `class Payment extends TPaymentBaseModel {}` is not observable until its constructor calls `asGenObservable(this)`.

## Observe a model

`autorun` runs once immediately and again when a value it reads changes. `summary` is the computed getter in the class above.

`src/summary.ts`:

<<< ../../examples/payments/web/src/summary.ts#observe-payment

Dispose the reaction when the observation is no longer needed.

## Nested generated models

When an observable generated model contains another generated model,
`asGenObservable` walks nested values through arrays, records, maps and sets.

One top-level `mobx: true` in `golem.yaml` applies to both the SDK and the model generator, building a [model with a client](/guide/models-and-client) as observables together. The `golem.yaml` above generates the SDK into `sdk/` from `../server/api/openapi.yaml`. In `src/payment-editor.model.ts`, `setAmount` edits the nested `money` model:

<<< ../../examples/payments/web/src/payment-editor.model.ts#nested-editing

Calling `setAmount('12.50')` changes `money.amount`, and the reaction above reports the new summary.

- The constructor turns the nested initializer into a generated `TMoneyModel`.
- `asGenObservable` initializes that nested model; no manual MobX call is needed for it.
- `setAmount` is an action. The reaction runs after it updates `money.amount`.

## Unions and your classes

Put annotations on your class, after `super`. When a union field holds one of your classes, construct it with `new YourClass(…)`; generated [union conversion](/guide/model-composition#unions) builds only generated classes. The runtime initializes each generated model once
and throws if an already initialized instance is initialized again.

With `mobx: false`, generated files omit MobX imports; all other model and validation settings continue to follow the profile.

## Use it in React

A React component imports a generated model or client like any other module. Wrap a component that reads observable fields in `observer` from `mobx-react-lite`; it re-renders when a field it read changes. Operation `loading` is in [SDK clients](/guide/client-usage#observe-loading-with-mobx).

The amount field in [`src/App.tsx`](https://github.com/RunicCore/golem/blob/master/examples/payments/web/src/App.tsx), which wraps every field of the form the same way:

<<< ../../examples/payments/web/src/App.tsx#observer-component

`getValidator` reads the editor's validation issues ([Validation](/guide/validation)) for the field to render; the field calls an action method, `setAmount`, on change. [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments) runs this editor against a local demo server.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
