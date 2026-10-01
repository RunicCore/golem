# MobX and React

Make generated models observable and use them in React components.

With `mobx: true`, generated model fields are MobX observables.

- Annotate your class's own fields, getters and actions with normal MobX annotations.
- Nested generated models are initialized recursively and keep their identity.

Create `src/task.model.ts`:

<<< ../../examples/model-mobx/src/task.model.ts#model-definition

MobX changes observability only. Construction, `fromWireFormat` / `toWireFormat`, `parse` / `stringify` and validation keep their normal behavior.

## Enable MobX

Install MobX in the application; your class constructors and the generated SDK models import it at runtime:

```sh
npm install mobx
```

Set the profile and regenerate:

<<< ../../examples/model-mobx/golem.yaml

`mobx: true` applies to every generator in the configuration. The example also sets `validation: false`; validation is independent of MobX ([Validation](/guide/validation)). An OpenAPI client
also gains observable operation loading ([SDK loading state](/guide/client-usage#observe-loading-with-mobx)).

## Initialize your class

Call `asGenObservable(this, annotations)` once in your constructor, after `super(values)` and after your own field initializers. Later calls such as `getValidator(this).extend()` are fine; a second `asGenObservable` call on the same instance throws.

- Extra annotations are optional: `asGenObservable(this, { label: computed, toggle: action })`.
- Annotate writable state with `observable`, derived getters with `computed` and state-changing methods with `action`.
- Use `observable.ref`, `observable.shallow`, `observable.struct`, or `false` when a field should not be deeply observable.
- `asGenObservable` runs once per instance. An [SDK model class](/guide/models-and-client) such as `MoneyModel`, created with `new` or with `fromWireFormat`, initializes itself. An empty `class Payment extends TPaymentBaseModel {}` is not observable until its constructor calls `asGenObservable(this)`.

## Observe a model

`autorun` runs once immediately and again when a value it reads changes. `label` and `toggle` are the members in the class above.

`src/observe-task.ts`:

<<< ../../examples/model-mobx/src/observe-task.ts#observe-task

Dispose the reaction when the observation is no longer needed.

## Nested generated models

When an observable generated model contains another generated model,
`asGenObservable` walks nested values through arrays, records, maps and sets.

One top-level `mobx: true` in `golem.yaml` applies to both the SDK and the model generator, building a [model with a client](/guide/models-and-client) as observables together.

<<< ../../examples/combined-mobx/golem.yaml

It generates the SDK into `sdk/` from `api.yaml`.

`src/payment-editor.model.ts`:

<<< ../../examples/combined-mobx/src/payment-editor.model.ts#model-definition

`src/nested-editing.ts`:

<<< ../../examples/combined-mobx/src/nested-editing.ts#nested-editing

Calling `editPayment()` — its default `report` is `console.log` — prints the same two lines the reaction observes above.

- The constructor turns the nested initializer into a generated `MoneyModel`.
- `asGenObservable` initializes that nested model; no manual MobX call is needed for it.
- `setAmount` is an action. The reaction runs after it updates `money.amount`.

## Unions and your classes

Put annotations on your class, after `super`. When a union field holds one of your classes, construct it with `new Task(…)`; generated [union conversion](/guide/model-composition#unions) builds only generated classes. The runtime initializes each generated model once
and throws if an already initialized instance is initialized again.

With `mobx: false`, generated files omit MobX imports; all other model and validation settings continue to follow the profile.

## Use it in React

A React component imports a generated model or client like any other module. Wrap a component that reads observable fields in `observer` from `mobx-react-lite`; it re-renders when a field it read changes. Operation `loading` is in [SDK clients](/guide/client-usage#observe-loading-with-mobx).

`src/App.tsx`:

<<< ../../examples/react-mobx/src/App.tsx#observer-component

`getValidator` reads the editor's validation issues ([Validation](/guide/validation)) for the form to render; the form's fields call action methods such as `setAmount` on change. [`examples/react-mobx`](https://github.com/RunicCore/golem/tree/master/examples/react-mobx) runs this editor against a local demo server.

Full example: [`examples/model-mobx`](https://github.com/RunicCore/golem/tree/master/examples/model-mobx)
