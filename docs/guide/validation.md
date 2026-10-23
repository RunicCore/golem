# Validation

Check models and API data, show field errors, and add your own rules.

Put validation constraints such as `MinLength`, `Minimum`, and `TValidation` on field types. Generated validators check them.

- `validateInstance(model)` returns an issue list.
- `getValidator(model)` stores field errors for an editor.

Both stop at the first issue by default. Pass `{ failFast: false }` to collect every issue, for example to show all field errors in a form.

<<< ../../examples/models/src/task-input.model.ts#custom-rule

<<< ../../examples/models/src/task-input-checks.ts#validate-a-model

`validation` defaults to `true`. `IObject` and `IModel` accept `{ validation: false }` to skip checks for that declaration. A nested `IObject` or `IModel` uses its own setting.

Constructors and field assignments do not validate. You can keep an incomplete model while someone edits it.

[Using NestJS? `@Body()` / `@Query()` convert through `NestModelInterceptor`.](/guide/nestjs-requests#nestmodelinterceptor)

## Choose a check

| Task | Call |
| --- | --- |
| Check a model you built | `validateInstance(model)` |
| Show field errors in a form | `getValidator(model)` |
| Check untrusted data against a type | `validate<T>(value)` (type predicate) |
| Check while converting | the default in `parse` / `fromWireFormat` |
| Call an API | a generated client validates the request and response ([Using the client](/guide/client-usage)) |

## Validate a model

The title rule in the check above is declared in [Type tags](/guide/tags#add-a-custom-field-rule). `MinLength<1>` rejects an empty string; `TValidation<typeof notBlank>` also rejects whitespace-only titles.

### Stored validation state

`getValidator(model)` returns the cached stateful validator for editor flows.
Its type uses the generated declared fields; methods and other properties added
only by your class are not validation fields.

| Property or method | Does |
| --- | --- |
| `await getValidator(model).validate()` | Returns `true` or `false` and replaces stored errors with the current results. Pass `{ failFast: false }` to store every field error. |
| `error('title')` | The first message for a field, or `undefined`. |
| `errorsFor('title')` | All messages for that field. |
| `issues` | Structured errors with paths, codes, sources, messages and the fields of each code, such as `limit` on a `tooSmall` issue. |
| `errors` | A map from each field's escaped path to its messages. |
| `pending` | Whether validation is in progress. |
| `valid` | Whether the stored issues are empty. It does not track unvalidated edits. |
| `clear()` | Removes the stored issues and resets `pending`. |
| `setErrors(map)` | Stores messages from outside generated or instance rules, such as a server response. |
| `extend(rules)` | Adds a rule for this model instance, including asynchronous checks. |
| `messages(overrides)` | Overrides the message for a generated check, by field and code, such as `'title.tooSmall'`. |

Changing a field does not clear its old error. Validate again to refresh the result, or call `clear()` to remove the stored errors. If a converter throws or validation cannot run, the stateful `getValidator(model).validate()` throws `LibError` instead of returning `false`.

## Nested field errors

Pass a path array to read errors inside objects or arrays. Field names are strings; array indexes are numbers.

<<< ../../examples/models/src/checklist-input.model.ts#nested-field-errors

Use `issues` when you need an error's code or source as well as its message: each [`Issue`](/reference/runtime-api#errors) carries both. The `errors` map keys messages by [escaped JSON Pointer](/reference/runtime-api#model-validator).

## Instance rules

Use `extend()` for a rule added to a particular model, including asynchronous checks. The callback receives the field value and the model, and returns `true` or an error message, directly or through a promise.

<<< ../../examples/models/src/title-rule.ts#instance-rules

- Generated checks run before instance rules.
- Register the rule in your class constructor when every instance needs it, including instances created by `fromWireFormat<TaskInput>()`.
- Use [`TValidation`](/guide/tags#add-a-custom-field-rule) for a reusable synchronous predicate attached to a field type.

## Errors returned by an API

`setErrors()` lets you display a server message alongside local validation errors. It stores messages; it does not add validation rules.

<<< ../../examples/models/src/server-errors.ts#server-errors

The next `validator.validate()` replaces these messages with its own results. The standalone `validateInstance(task)` leaves them unchanged. To customize messages for generated checks, use [`messages()`](/reference/runtime-api#validation) with the issue's code, such as `tooSmall`.

## Validation during conversion

`parse<T>(text)` validates the incoming JSON, then runs each field's `TSerde` decoder. `fromWireFormat<T>(value)` does the same for a plain object, without `JSON.parse`. `{ validate: false }` skips the check and does not update stored field errors.

<<< ../../examples/models/src/load-task.ts#validation-during-conversion

- After successful `parse` / `fromWireFormat` (validation on), you do not need another `validateInstance(model)` call unless you edit the instance. Use `getValidator(model).validate()` when you want all field errors stored for display.
- JSON values and model values are checked at separate stages.
- Typing a `TSerde` decoder parameter as plain `string` drops the [validation constraints on the JSON value](/guide/tags#which-type-controls-validation), not the ones on the model value.

## OpenAPI validation constraints in both directions

Supported OpenAPI validation constraints work whether you start from TypeScript models or an existing OpenAPI document.

| TypeScript validation constraint | OpenAPI schema rule | Generated validation |
| --- | --- | --- |
| `string & MinLength<3>` | `type: string`, `minLength: 3` | Rejects strings shorter than three characters. |
| `number & Minimum<0>` | `type: number`, `minimum: 0` | Rejects negative numbers. |
| `string & Pattern<'^[A-Z]+$'>` | `type: string`, `pattern: '^[A-Z]+$'` | Rejects strings that do not match. |

- `@exprtlabs/golem-ts-openapi` writes supported validation constraints from controller models into the OpenAPI schemas.
- `golem-openapi` uses supported schemas for model validation and automatic client request/response validation. The document can come from any OpenAPI producer.
- Custom predicates and converters remain TypeScript functions. Sharing them through imports is optional; OpenAPI does not carry executable code. For a field with a `TSerde` serialize formatter, the OpenAPI schema describes the JSON value, not the model value.

Supported keywords, versions and profiles are in [OpenAPI client support](/reference/openapi-support).

## Generation settings

Validation is enabled by default. [Validation profiles](/reference/config#validation-profiles) set it in `golem.yaml`.

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models)
