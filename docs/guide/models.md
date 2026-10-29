# Define models

Declare fields as a type, generate the class, and add behavior in your own class.

::: code-group

<<< ../../examples/models/src/task.model.ts#model-definition [task.model.ts]

<<< ../../examples/models/src/priority-word.ts#priority-word [priority-word.ts]

:::

`priority` is a number in your class and a word in JSON. [`TSerde`](/guide/serialization#change-the-json-form) converts between them.

## IObject or IModel

Both declare fields. `IObject` stops there: values stay plain objects, and you call the generated validation and conversion as functions. `IModel` is an `IObject` plus a **generated class** (`TTaskBaseModel`) that **your class** (`Task`) extends.

<<< ../../examples/models/src/comment.model.ts#object-and-model

`TComment` is an `IObject`: `parse<TComment>` returns a plain object. `TThread` is an `IModel` that nests it: `parse<Thread>` builds a `Thread` whose `comments` array holds those plain objects.

| | `IObject` | `IModel` |
| --- | --- | --- |
| Generates | validation and JSON conversion | the same, plus a class (`TTaskBaseModel`) |
| Value from `parse` | plain object: `parse<TComment>(json)` | your class with `parse<Task>(json)`; a plain object with `parse<TTask>(json)` |
| Methods and getters | no | yes, on your class |
| [MobX](/guide/mobx) (`mobx: true`) | observable only as a field of a generated model | observable fields once your constructor calls `asGenObservable(this)` |
| Use it for | DTOs and nested data | domain objects with behavior |

## Declare fields

Put declarations in `src/**/*.model.ts` or `src/**/*.models.ts`. Set [`models.suffixes`](/reference/config#typescript-models) to use other endings, such as `.entity.ts`, and `models.sources` to name files directly. A field can have any of the [supported shapes](/guide/field-types) and carry [validation tags](/guide/tags).

## Set the validation level of a model

The second type argument of `IObject` and `IModel` takes `{ validation: true | false | 'sanity' }`. It sets the level of the checks that a call uses when it names none.

| Option | Default level of the model's calls |
| --- | --- |
| `true` | Every rule |
| `'sanity'` | The shape only ([what sanity checks](/reference/config#validation-profiles)) |
| `false` | No checks. Golem writes no validators for the model, so a call cannot check it. |

- Without the option, the model uses the project level.
- The model level is at or below the project level. A higher level stops generation with [`RUNM1089`](/reference/diagnostics#runm1089).
- A model over an SDK model sets no level. The level of the SDK applies, and the option stops generation with [`RUNM1090`](/reference/diagnostics#runm1090).
- A call can choose another level up to the project level ([Choose a level for one call](/guide/validation#choose-a-level-for-one-call)).

## Generated names

Generation writes the generated file `task.model.generated.ts` beside each declaration file. It exports these names:

| Export | What it is |
| --- | --- |
| `TTaskBaseModel` | the generated class your `Task` extends |
| `TTaskFields` | constructed field values, with nested model instances |
| `TTaskInit` | constructor input, with optional fields and nested initializers |
| `TTaskJSON` | the plain data `toWireFormat` returns |

Each name is the exact type alias plus a suffix. `type TTask = IModel<…>` gives `TTaskBaseModel`, `TTaskFields`, `TTaskInit` and `TTaskJSON`. `type Task = IModel<…>` gives `TaskBaseModel`. `type TPermissionModel = IModel<…>` gives `TPermissionModelBaseModel`. The generated functions use the alias too, such as `parseTTask`.

Your class links to its model through `extends <Alias>BaseModel`, so it can have any name: `class PurchaseOrder extends TOrderBaseModel`. A file can export several classes that extend the generated class directly. Each links to the model, and `parse<AdminPayment>` builds an `AdminPayment`.

With one class, the model uses it as its default class. With several, the model has no default class, so decoding builds the generated class unless the type names one. A class that extends another linked class does not link.

The generated file puts `.generated` before the final extension of its source: `order.entity.ts` gets `order.entity.generated.ts`, and `order.entity.mts` gets `order.entity.generated.mts`. Do not edit the generated file. Generation replaces it.

## Add behavior

Your class holds methods, getters, defaults and extra constructor state. The base constructor assigns the supplied values, so call `super(values)` before you read a field. With [MobX](/guide/mobx) on, call `asGenObservable(this)` right after `super(values)`.

`toWireFormat` emits declared fields only. Getters and other state on your class stay on the instance. A key on an instance that its model does not declare is program state, and codecs ignore it. The `exact` option of the model decides whether extra keys in input fail validation ([options `exact` and `allowAny`](/guide/field-types#the-options-exact-and-allowany)).

## Type-only model files

A file that exports only types, such as `export type TLabel = IObject<{ text: string }>`, needs no import of its generated file. The [build tool](/guide/build) loads the generated file of each model that one of these names:

- a `parse`, `stringify`, `validate`, `toWireFormat` or `fromWireFormat` call
- a Nest `@Body()` or `@Query()` parameter
- a Nest handler return

A codec that is still missing at run time throws an error that starts with `golem fault`. Run `golem generate`, then build again.

## Field names you cannot use

A declared field cannot use a name from `Object.prototype`, such as `__proto__`, `constructor`, `toString` or `hasOwnProperty`. Generation reports the field. Rename it in the declaration or the OpenAPI schema.

## Regenerate

After you change a declaration, generate again:

```sh
npx golem generate
```

Generation type-checks the project first, then writes the files:

- It stops on a TypeScript error in a model source or in a file the job writes. It reports the error in the compiler's form, `file(line,column): error TSnnnn: message`.
- A type error in any other file does not stop generation.
- It replaces every `*.model.generated.ts` file and the shared files under `models.output` (default `src/generated/models/`).
- Your classes do not change.

`golem build` generates first, so a build needs no separate `golem generate`. In CI, run `golem build`, or run `golem generate` and then `npx golem check` ([Generate and watch](/guide/watch)). You choose whether to [ignore or commit the generated files](/reference/generated-files#gitignore).

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models).
