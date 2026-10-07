# Defining models

Declare fields as a type, generate validation and JSON conversion, and add behavior in your own class.

::: code-group

<<< ../../examples/models/src/task.model.ts#model-definition [task.model.ts]

<<< ../../examples/models/src/priority-word.ts#priority-word [priority-word.ts]

:::

`priority` is a number in your class and a word in JSON; `TSerde` converts between them ([Type tags](/guide/tags#convert-a-field-to-a-different-json-value)).

## IObject or IModel

Both declare fields. `IObject` stops there: values stay plain objects, and you call the generated validation and conversion as functions. `IModel` is an `IObject` plus a **generated class** (`TTaskBaseModel`) that **your class** (`Task`) extends.

<<< ../../examples/models/src/comment.model.ts#object-and-model

`TComment` is an `IObject`: `parse<TComment>` returns a plain object. `TThread` is an `IModel` nesting it: `parse<Thread>` builds a `Thread` whose `comments` array holds those plain objects.

| | `IObject` | `IModel` |
| --- | --- | --- |
| Generates | validation and JSON conversion | the same, plus a class (`TTaskBaseModel`) |
| Value from `parse` | plain object: `parse<TComment>(json)` | your class with `parse<Task>(json)`; a plain object with `parse<TTask>(json)` |
| Methods and getters | no | yes, on your class |
| [MobX](/guide/mobx) (`mobx: true`) | observable only as a field of a generated model | observable fields once your constructor calls `asGenObservable(this)` |
| Use it for | DTOs and nested data | domain objects with behavior |

## Declare fields

Put declarations in `src/**/*.model.ts` or `src/**/*.models.ts`. Set [`models.suffixes`](/reference/config#typescript-models) to use other endings, such as `.entity.ts`, and `models.sources` to name files directly. Generation writes the generated file `task.model.generated.ts` beside each declaration file, with these exports:

| Export | What it is |
| --- | --- |
| `TTaskBaseModel` | the generated class your `Task` extends |
| `TTaskFields` | constructed field values, with nested model instances |
| `TTaskInit` | constructor input, with optional fields and nested initializers |
| `TTaskJSON` | the plain data `toWireFormat` returns |

Each name is the exact type alias plus a suffix: nothing is dropped from the alias. `type TTask = IModel<…>` gives `TTaskBaseModel`, `TTaskFields`, `TTaskInit` and `TTaskJSON`; `type Task = IModel<…>` gives `TaskBaseModel`; `type TPermissionModel = IModel<…>` gives `TPermissionModelBaseModel`. The generated functions use the alias too, such as `parseTTask`.

Your class links to its model through `extends <Alias>BaseModel`, so it can have any name: `class PurchaseOrder extends TOrderBaseModel`. A file can export several classes that extend the generated class directly: each links to the model, and `parse<AdminPayment>` builds an `AdminPayment`. With one class, the model uses it as its default class. With several, the model has no default class, so decoding builds the generated class unless the type names one. A class that extends another linked class does not link.

The generated file puts `.generated` before the final extension of its source: `order.entity.ts` gets `order.entity.generated.ts`, and `order.entity.mts` gets `order.entity.generated.mts`. Don't edit the generated file; generation replaces it.

## Add behavior

Your class holds methods, getters, defaults and extra constructor state. The base constructor assigns the supplied values, so call `super(values)` before you read a field. With [MobX](/guide/mobx) on, call `asGenObservable(this)` right after `super(values)`.

`toWireFormat` emits declared fields only. Getters and other state on your class stay on the instance.

## Load the generated class before parse

A file that exports only types compiles to an empty module: TypeScript erases the type-only export, so nothing runs when another module imports it. Importing `task.model.ts` loads its generated file, because that file also imports the value `TTaskBaseModel`. A file that exports nothing but `export type TLabel = IObject<{ text: string }>` does not: add `import './label.model.generated.js';` beside the type-only import before calling `parse`, `stringify`, `validate` or a wire-format function on `TLabel`.

Skip that import and the call throws a `LibError` of kind `validation_unavailable`:

```
IObject codec "<id>" for model <model> is not registered. The generated file that registers it, the `.generated.js` file beside the model file (such as `order.entity.generated.js` for `order.entity.ts`), has not been loaded; a type-only import such as `import type { T<model> }` does not load it. Import that generated file, or a value from its model file, before calling parse, stringify, validate or the wire-format functions.
```

## Read and write JSON

`stringify` and `parse` work with JSON text; `toWireFormat` and `fromWireFormat` work with plain objects. The type argument picks the result: `parse<TTask>` returns a plain object, `parse<Task>` builds a `Task`.

<<< ../../examples/models/src/read-json.ts#read-json

Each call takes [serde options](/guide/serialization) such as `{ validate: false }`.

## Field names you can't use

Declared fields can't use names from `Object.prototype`, such as `__proto__`, `constructor`, `toString` or `hasOwnProperty`. Generation reports the field; rename it in the declaration or the OpenAPI schema.

## Field types

The field type decides construction, conversion and validation.

| TypeScript shape | Runtime and JSON |
| --- | --- |
| `string`, `number`, `boolean`, `null`, `undefined` | stored as is; an `undefined` property is left out of JSON |
| `bigint` | needs a [`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value) codec that writes it as JSON, such as a string; without one, `stringify` rejects it |
| string, number and boolean literals | kept and checked |
| arrays and tuples | items convert recursively; tuple length and optional or rest positions are checked |
| object types | known properties convert; extra properties fail validation unless [`{ exact: false }`](/guide/model-composition#strict-objects-and-any) |
| unions and intersections | intersections merge fields; [supported unions](/guide/model-composition#unions) |
| another type-only `IModel` | a nested plain object, still converted |
| your class (extends a `*Base`) | a nested instance of that class |
| `Date` | an ISO date-time string in JSON, restored with `Date` parsing; add format checks with [tags](/guide/tags) |
| `TemporalInstant`, `TemporalPlainDate` and the other [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal) types | an ISO 8601 string in JSON; needs a `Temporal` global ([Dates and times](/guide/dates)) |
| `unknown` | accepted without structural checks |

`any` is accepted only when `allowAny` is `true`, set in `golem.yaml` or per model ([strict objects](/guide/model-composition#strict-objects-and-any)).

## Regenerate

After you change a declaration, generate again:

```sh
npx golem generate
```

Generation type-checks the project first. It stops on a TypeScript error in a model source or in a file the job writes, reported as `file:line:column`. A type error in any other file does not stop generation; `tsc` and `golem build` report it. Generation then replaces every `*.model.generated.ts` file and the shared files under `models.output` (default `src/generated/models/`); your classes don't change. `golem build` generates first, so a build needs no separate `golem generate`. Run `npx golem check` in CI when you commit the generated files; otherwise run `golem build` ([Generate, watch and check](/guide/watch), [what to commit](/reference/generated-files#gitignore)).

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models)
