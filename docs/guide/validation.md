# Validate models

Check models and data, show field errors in a form, and read the errors that golem reports.

Generated validators check the [validation tags](/guide/tags) on your field types. `validateInstance(model)` returns an issue list. `getValidator(model)` stores field errors for an editor. Both stop at the first issue by default. Pass `{ failFast: false }` to collect every issue, for example to show all field errors in a form.

<<< ../../examples/models/src/task-input.model.ts#custom-rule

<<< ../../examples/models/src/task-input-checks.ts#validate-a-model

`validation` defaults to `true`. [Validation profiles](/reference/config#validation-profiles) set it in `golem.yaml`. `IObject` and `IModel` accept `{ validation: false }` to skip checks for that declaration. A nested `IObject` or `IModel` uses its own setting.

Constructors and field assignments do not validate. You can keep an incomplete model while someone edits it.

## Choose a check

| Task | Call |
| --- | --- |
| Check a model you built | `validateInstance(model)` |
| Show field errors in a form | `getValidator(model)` |
| Check untrusted data against a type | `validate<T>(value)` (type predicate) |
| Check while converting | the default in `parse` and `fromWireFormat` ([JSON conversion](/guide/serialization#checks-during-conversion)) |
| Check `@Body()` and `@Query()` in NestJS | `NestModelInterceptor` ([Convert requests](/guide/nestjs-requests)) |
| Call an API | a generated client validates the request and response ([Call operations](/guide/client-usage)) |

## Validate a model

The title rule in the check above is declared in [Validation tags](/guide/tags#add-a-custom-field-rule). `MinLength<1>` rejects an empty string. `TValidation<typeof notBlank>` also rejects a title that holds only spaces.

### Stored validation state

`getValidator(model)` returns the cached stateful validator for editor flows. Its type uses the generated declared fields. Methods and other properties that only your class adds are not validation fields.

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

Changing a field does not clear its old error. Validate again to refresh the result, or call `clear()` to remove the stored errors.

## Nested field errors

Pass a path array to read errors inside objects or arrays. Field names are strings. Array indexes are numbers.

<<< ../../examples/models/src/checklist-input.model.ts#nested-field-errors

Use `issues` when you need the code or source of an error as well as its message. The `errors` map keys messages by [escaped JSON Pointer](/reference/runtime-api#model-validator).

## Instance rules

Use `extend()` for a rule added to a particular model, including asynchronous checks. The callback receives the field value and the model, and returns `true` or an error message, directly or through a promise.

<<< ../../examples/models/src/title-rule.ts#instance-rules

- Generated checks run before instance rules.
- Register the rule in your class constructor when every instance needs it, including instances created by `fromWireFormat<TaskInput>()`.
- Use [`TValidation`](/guide/tags#add-a-custom-field-rule) for a reusable synchronous predicate attached to a field type.

## Errors from an API

`setErrors()` lets you display a server message beside local validation errors. It stores messages and does not add validation rules.

<<< ../../examples/models/src/server-errors.ts#server-errors

The next `validator.validate()` replaces these messages with its own results. The standalone `validateInstance(task)` leaves them unchanged. To customize messages for generated checks, use [`messages()`](/reference/runtime-api#validation) with the code of the issue, such as `tooSmall`.

## Errors and issues

An invalid value is an ordinary result for `validateInstance` and `validate()`. A call that converts a value throws a `LibError` instead: `parse`, `stringify`, `fromWireFormat`, `toWireFormat` and `assertValue`. A validator also throws `LibError` when validation cannot run, for example when the model was generated with `validation: false`, or when a rule or a converter throws.

<<< ../../examples/models/src/read-errors.ts#lib-error

A `LibError` from `@exprtlabs/golem/errors` has these members:

| Member | Holds |
| --- | --- |
| `kind` | the failure category: `validation`, `invalid_json`, `serialization`, `deserialization`, `validation_unavailable` or `response` |
| `issues` | a frozen list of failed checks |
| `causedByInput` | `true` when the rejected value is at fault, `false` for a program fault |
| `cause` | the exception that a `LibError` wraps, if any |

Each issue has a `code`, a `path`, a `message` and a `source`. Check `issue.code` and TypeScript narrows to the fields of that code, such as `issue.limit` after `issue.code === 'tooSmall'`. A `path` such as `['items', 0, 'amount']` names the field. Every kind, code and field is in the [runtime reference](/reference/runtime-api#errors).

Constraints on the models of a NestJS controller reach the OpenAPI document that golem writes. Constraints in an OpenAPI document reach the generated validators and clients. The supported keywords are in [OpenAPI support](/reference/openapi-support).

Full example: [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models)
