# Quick start

Declare a model, generate its class, add a method, and run it.

## Install

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
npm install --save-dev @exprtlabs/golem-model@rc typescript@~7.0.2 ttsc@~0.30.4
```

Add `"type": "module"` to `package.json` and this to `tsconfig.json` ([TypeScript setup](/guide/install#typescript-setup)):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": ".",
    "outDir": ".build",
    "plugins": [
      { "transform": "@exprtlabs/golem/ttsc-plugin" }
    ]
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

## Declare your fields

Mark a type with `IModel` in `src/task.model.ts`:

<<< ../../examples/model/src/quick-start/task.model.ts#task-declaration

The generator reads `src/**/*.model.ts` and `src/**/*.models.ts`; [`models.sources`](/reference/config#typescript-models) changes that.

An `IObject` gives plain objects with the same validation and conversion; an `IModel` also gives you a class ([IObject or IModel](/guide/models#iobject-or-imodel)).

## Generate the base

Add `golem.yaml` at the project root and run the generator:

<<< ../../examples/model/golem.yaml

```sh
npx golem generate
```

```
Generated configured outputs.
```

You get `src/task.model.generated.ts` beside the declaration, with the generated class `TTaskBaseModel` and the `TTaskFields` type. Shared files go to `models.output` (default `src/generated/models/`).

## Add methods

Extend the generated class in `src/task.model.ts`, below the declaration:

<<< ../../examples/model/src/quick-start/task.model.ts#task-model

To add a field later, change `TTask` and generate again. Only `task.model.generated.ts` is replaced; `toggle()` stays.

## Use the model

Create `src/main.ts`:

<<< ../../examples/model/src/quick-start/main.ts#use-task

`@exprtlabs/golem/serde` also exports `parse` and `stringify`. `parse<Task>(text)` builds a `Task`; `parse<TTask>(text)` returns a plain object. `stringify` returns JSON text.

## Run it

```sh
npx ttsc && node .build/src/main.js
```

```
{ title: 'Review the draft', done: true }
[]
```
