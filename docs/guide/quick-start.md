# Quick start

Declare a model, generate its class, add a method, and run it.

## Install

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
npm install --save-dev @exprtlabs/golem-model@rc typescript@~7.0.2
```

Add `"type": "module"` to `package.json` and this to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": ".",
    "outDir": ".build"
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

## Declare your fields

`priority` is a number in your code and a word in JSON, so first write the two functions that convert it in `src/priority-word.ts`. The generated file imports them, so they cannot live in the model file ([`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value)):

<<< ../../examples/models/src/priority-word.ts#priority-word

Then mark a type with `IModel` in `src/task.model.ts`; `TSerde` ties `priority` to those functions:

<<< ../../examples/models/src/task.model.ts#task-declaration

The generator reads `src/**/*.model.ts` and `src/**/*.models.ts`; [`models.suffixes`](/reference/config#typescript-models) changes the endings and `models.sources` names the files.

An `IObject` gives plain objects with the same validation and conversion; an `IModel` also gives you a class ([IObject or IModel](/guide/models#iobject-or-imodel)).

## Generate the base

Add `golem.yaml` at the project root and run the generator. `golem build` starts from this file and builds the `tsconfig.json` beside it. `golem generate` writes the generated code your editor needs; `golem build` generates first on its own:

<<< ../../examples/models/golem.yaml

```sh
npx golem generate
```

```
Generated configured outputs.
```

You get `src/task.model.generated.ts` beside the declaration, with the generated class `TTaskBaseModel` and the `TTaskFields` type. Shared files go to `models.output` (default `src/generated/models/`). Golem also keeps its state in `.golem/`. Add the generated files and `.golem/` to `.gitignore`, or commit the generated files and `.golem/outputs.json` together ([what to commit](/reference/generated-files#gitignore)):

```text
.golem/
*.generated.ts
src/generated/
```

## Add methods

Extend the generated class in `src/task.model.ts`, below the declaration:

<<< ../../examples/models/src/task.model.ts#task-model

To add a field later, change `TTask` and generate again. Only `task.model.generated.ts` is replaced; `toggle()` stays.

## Use the model

Create `src/main.ts`:

<<< ../../examples/models/src/main.ts#use-task

`@exprtlabs/golem/serde` also exports `parse` and `stringify`. `parse<Task>(text)` builds a `Task`; `parse<TTask>(text)` returns a plain object. `stringify` returns JSON text.

## Run it

```sh
npx golem build && node .build/src/main.js
```

```
{ title: 'Review the draft', done: true, priority: 'normal' }
[]
```

`golem build` generates first, checks your sources, then writes JavaScript with `parse` and `stringify` calls rewritten into `.build/`. A bundler plugin or the Node loader can rewrite the calls instead ([TypeScript setup](/guide/install#typescript-setup)).

Your `main.ts` holds only the code above, so this is all it prints. The full example's `main.ts` continues with one line per feature; `npm start` in [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models) prints them all.
