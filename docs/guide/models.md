# Defining models

Declare fields as a type, generate validation and JSON conversion, and add behavior in your own class.

<<< ../../examples/model/src/task.model.ts#model-definition

`priority` is a number in your class and a word in JSON; `TSerde` converts between them ([Type tags](/guide/tags#convert-a-field-to-a-different-json-value)).

## IObject or IModel

Both declare fields. `IObject` stops there: values stay plain objects, and you call the generated validation and conversion as functions. `IModel` is an `IObject` plus a **generated class** (`TaskBase`) that **your class** (`Task`) extends.

<<< ../../examples/model/src/note.model.ts#object-and-model

`TNote` is an `IObject`: `parse<TNote>` returns a plain object. `TNotebook` is an `IModel` nesting it: `parse<Notebook>` builds a `Notebook` whose `notes` array holds those plain objects.

| | `IObject` | `IModel` |
| --- | --- | --- |
| Generates | validation and JSON conversion | the same, plus a class (`TaskBase`) |
| Value from `parse` | plain object: `parse<TNote>(json)` | your class with `parse<Task>(json)`; a plain object with `parse<TTask>(json)` |
| Methods and getters | no | yes, on your class |
| [MobX](/guide/mobx) (`mobx: true`) | observable only as a field of a generated model | observable fields once your constructor calls `asGenObservable(this)` |
| Use it for | DTOs and nested data | domain objects with behavior |

## Declare fields

Put declarations in `src/**/*.model.ts` or `src/**/*.models.ts`. Generation writes the generated file `task.model.generated.ts` beside each declaration file, with these exports:

| Export | What it is |
| --- | --- |
| `TaskBase` | the generated class your `Task` extends |
| `TaskFields` | constructed field values, with nested model instances |
| `TaskInit` | constructor input, with optional fields and nested initializers |
| `TaskJSON` | the plain data `toWireFormat` returns |

Don't edit the generated file; generation replaces it.

## Add behavior

Your class holds methods, getters, defaults and extra constructor state. The base constructor assigns the supplied values, so call `super(values)` before you read a field. With [MobX](/guide/mobx) on, call `asGenObservable(this)` right after `super(values)`.

`toWireFormat` emits declared fields only. Getters and other state on your class stay on the instance.

## Load the generated class before parse

A file that exports only types compiles to an empty module: TypeScript erases the type-only export, so nothing runs when another module imports it. Importing `task.model.ts` loads its generated file, because that file also imports the value `TaskBase`. A file that exports nothing but `export type TLabel = IObject<{ text: string }>` does not: add `import './label.model.generated.js';` beside the type-only import before calling `parse`, `stringify`, `validate` or a wire-format function on `TLabel`.

Skip that import and the call throws a `LibError` of kind `validation_unavailable`:

```
IObject codec "<id>" for model <model> is not registered. The generated file that registers it (the model file's .model.generated.js) has not been loaded; a type-only import such as `import type { T<model> }` does not load it. Import the model's .model.generated.js file, or a value from its model file, before calling parse, stringify, validate or the wire-format functions.
```

## Read and write JSON

`stringify` and `parse` work with JSON text; `toWireFormat` and `fromWireFormat` work with plain objects. The type argument picks the result: `parse<TTask>` returns a plain object, `parse<Task>` builds a `Task`.

<<< ../../examples/model/src/read-json.ts#read-json

Each call takes [serde options](/guide/serialization) such as `{ validate: false }`.

## Field names you can't use

Declared fields can't use names from `Object.prototype`, such as `__proto__`, `constructor`, `toString` or `hasOwnProperty`. Generation reports the field; rename it in the declaration or the OpenAPI schema.

## Field types

The field type decides construction, conversion and validation.

| TypeScript shape | Runtime and JSON |
| --- | --- |
| `string`, `number`, `boolean`, `null`, `undefined` | stored as is; an `undefined` property is left out of JSON |
| `bigint` | allowed in a model; `stringify` rejects it |
| string, number and boolean literals | kept and checked |
| arrays and tuples | items convert recursively; tuple length and optional or rest positions are checked |
| object types | known properties convert; extra properties fail validation unless [`{ exact: false }`](/guide/model-composition#strict-objects-and-any) |
| unions and intersections | intersections merge fields; [supported unions](/guide/model-composition#unions) |
| another type-only `IModel` | a nested plain object, still converted |
| your class (extends a `*Base`) | a nested instance of that class |
| `Date` | an ISO date-time string in JSON, restored with `Date` parsing; add format checks with [tags](/guide/tags) |
| `unknown` | accepted without structural checks |

`any` is accepted only when `allowAny` is `true`, set in `runic-codegen.yaml` or per model ([strict objects](/guide/model-composition#strict-objects-and-any)).

## Regenerate

After you change a declaration, generate again:

```sh
npx runic-codegen generate
```

Generation type-checks the whole project first and stops at the first TypeScript error, reported as `file:line:column`. It then replaces every `*.model.generated.ts` file and the shared files under `models.output` (default `src/generated/models/`); your classes don't change. Commit `.runic-codegen/outputs.json` with the generated files, and run `npx runic-codegen check` in CI ([Generate, watch and check](/guide/watch)).

Full example: [`examples/model`](https://github.com/exprtlabs/codegen/tree/main/examples/model)
