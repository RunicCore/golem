# Runtime API

Find every `@exprtlabs/golem` subpath that your application, NestJS app or build tool imports, with its signatures.

| Subpath | Use | Extra dependency |
| --- | --- | --- |
| [`model`](#model) | `IModel`, `IObject`, generated-model types and guards | none |
| [`validation`](#validation) | `validate<T>`, `validateInstance`, `getValidator`, `ModelValidator` | none |
| [`validation-runtime`](#validation-runtime) | Helpers that generated validators import | none |
| [`mobx`](#mobx) | `asGenObservable` and observable API operations | `mobx` |
| [`mobx-validation`](#mobx-validation) | Observable validator state | `mobx` |
| [`errors`](#errors) | `LibError`, `LibErrorKind` and the `Issue` type | none |
| [`client`](#client) | `ApiOperation` and `createApiOperation` | none |
| [`conversion`](#conversion) | Encode and decode a generated model | none |
| [`tags`](#tags) | Type-only validation constraints, `TValidation`, `TSerde` | none |
| [`temporal`](#temporal) | Temporal field types and their codecs | a `Temporal` global, such as `temporal-polyfill` |
| [`serde`](#serde) | `parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` | none |
| [`nest`](#nest) | `NestModelInterceptor` and the helpers for your own interceptor | `@nestjs/common`, `rxjs` |
| [`generator-api`](/reference/generator-api#generator-api) | Contracts shared by the generators | none |
| [`manifest`](/reference/generator-api#manifest) | Read and find `model-manifest.json` files | none |
| [`rewrite`](/reference/generator-api#rewrite) | Apply a file's rewrite edits to its text and get its source map | none |
| [`loader`](#loader) | Node `load` hook that rewrites TypeScript as Node loads it | none |
| [`register`](#register) | `node --import` entry that installs the loader | none |
| [`vite`](#vite) | Vite plugin that rewrites TypeScript before Vite strips its types | `vite` |
| [`esbuild`](#esbuild) | esbuild plugin that rewrites TypeScript before esbuild strips its types | `esbuild` |

A path that starts with `internal/` is for the generators and may change in any release. Do not import it ([Compatibility](/compatibility#public-api)).

With `validation: true`, generated files import their own validator modules and need no extra package ([validation profiles](/reference/config#validation-profiles)). Generated files also import the names in [Exports for generated code](#generated-code).

## `@exprtlabs/golem/model` {#model}

```ts
import type { IModel, IObject } from '@exprtlabs/golem/model';
```

<<< ../../examples/models/src/task.model.ts#model-definition

| Member | Signature | Behavior |
| --- | --- | --- |
| `IObject` | `IObject<Fields, Options = {}>` | Declares fields whose values stay plain objects. The type is `Fields`. |
| `IModel` | `IModel<Fields, Options = {}>` | An `IObject` plus a generated class, such as `TTaskBaseModel`, that your class extends. |
| `IModelOptions` | `{ exact?, allowAny?, validation? }` | The second type argument of `IObject` and `IModel`. |
| `ModelInit` | `ModelInit<Value>` | Constructor values: nested models or their initializers. |
| `WireFormat` | `WireFormat<Value>` | The JSON shape `toWireFormat<Value>` returns, such as `TTaskJSON` for `Task`. |
| `ModelField` | `ModelField<Model>` | String field names, without methods and `$`-prefixed keys. |
| `ModelValidationContext` | `{ resolve }` | Validator source for one call ([validation context](#validation-context)). |
| `isGeneratedModel` | `(value: unknown): value is GeneratedModel<unknown>` | Recognizes a generated instance, including instances of your class. |
| `isGeneratedModelConstructor` | `(value: unknown): value is GeneratedModelConstructor` | Recognizes a generated class or your class that extends it. |

| `IModelOptions` key | Default | Effect |
| --- | --- | --- |
| `exact` | root `exact`, `true` | Controls extra keys ([Objects and exact](/guide/field-types#objects-and-exact)). |
| `allowAny` | root `allowAny`, `false` | Controls `any` and `unknown` fields ([`any` and `unknown`](/guide/field-types#any-and-unknown)). |
| `validation` | root `validation`, `true` | Generates checks for this named `IObject` or `IModel`. A nested declaration uses its own setting. |

Generation also writes [derived type names](/reference/generated-files#derived-type-names), such as `TTaskFields`, `TTaskJSON` and `TTaskInit`.

Types that describe generated metadata:

| Type | Describes |
| --- | --- |
| `GeneratedModelFields<Model>` | The field types of a generated model. |
| `GeneratedModelResult<Constructor>` | The instance type of a generated class. |
| `GeneratedModelDefinition`, `RegisteredGeneratedModelDefinition`, `GeneratedModelConversion`, `GeneratedModelProfile`, `GeneratedModelValidatorEnhancer` | The metadata that a generated class registers. |
| `ModelTypeMetadata`, `ModelTypeDescriptor`, `ModelConstraint`, `ConstraintSchemaValue`, `UnionDiscriminator`, `DiscriminatorValue` | The type information that generation records for a field. |

## `@exprtlabs/golem/validation` {#validation}

```ts
import { getValidator, validate, validateInstance } from '@exprtlabs/golem/validation';

function getValidator<Fields extends object, Owner extends object>(
  model: Owner & { readonly [generatedModelFieldsBrand]: Fields },
): ModelValidator<Fields, Owner>;
```

<<< ../../examples/models/src/task-input-checks.ts#validate-a-model

| Member | Signature | Behavior |
| --- | --- | --- |
| `getValidator` | `(model): ModelValidator<Fields, Owner>` | Returns the same stateful validator for a model instance every time. `Fields` are the generated field types. |
| `validateInstance` | `(model, options?: ValidateOptions): Promise<readonly Issue[]>` | Returns the current issues without changing the stored state ([validation](/guide/validation)). |
| `validate` | `<T>(value: unknown, options?: ValidateOptions & AllowGetterOptions): value is T` | Checks a value against a named `IObject` or `IModel` and narrows it. Needs a [build that rewrites it](/guide/build). |
| `ModelValidator` | `class ModelValidator<Fields, Owner = Fields>` | The stateful validator. Members are below. |

`validateInstance`, `validate` and `ModelValidator.validate` stop at the first issue unless you pass `{ failFast: false }`. An invalid value is an ordinary result. They throw `LibError` when validation cannot run, for example when the model was generated with `validation: false` (`ValidationUnavailable`).

### `ModelValidator` members {#model-validator}

| Member | Signature | Behavior |
| --- | --- | --- |
| `constructor` | `(model, cache = true)` | Attaches a validator to a model instance. `cache: false` does not store it for `getValidator`. |
| `validate` | `(options?: ValidateOptions): Promise<boolean>` | Runs generated checks, then instance rules, and stores the issues. A newer call wins over an older one. |
| `issues` | `readonly Issue[]` | Stored issues, frozen. |
| `errors` | `Readonly<Record<string, readonly string[]>>` | Messages keyed by escaped JSON Pointer, such as `/items/0/sku`. |
| `valid` | `boolean` | `true` when no issues are stored. It does not track later edits. |
| `pending` | `boolean` | `true` while `validate` runs. |
| `error` | `(field): string \| undefined` | First message for a field name or path array such as `['items', 0, 'sku']`. |
| `errorsFor` | `(field): readonly string[]` | All messages for that field name or path. |
| `extend` | `(rules: ModelValidationRules<Fields, Owner>): this` | Adds rules for this instance ([instance rules](/guide/validation#instance-rules)). |
| `messages` | `(messages: ValidationMessages<Fields>): this` | Replaces generated messages by code (`'tooSmall'`) or field and code (`'title.tooSmall'`). |
| `setErrors` | `(errors): void` | Stores messages from outside, such as a server response, as `external` issues. Takes a field map or `{ path, message }[]`. |
| `clear` | `(): void` | Removes stored issues and resets `pending`. |
| `setIssues` | `(issues: readonly Issue[]): void` | Replaces the stored issues. |
| `setPending` | `(pending: boolean): void` | Sets `pending`. |
| `formatIssue` | `(issue: Issue, explicit: boolean): Issue` | Applies `messages()` overrides unless `explicit`. |

Types for these members: `ModelValidationRules`, `ValidationRule`, `ValidationRuleResult`, `ValidationMessages`, `ValidationMessage`, `ValidationMessageKey`, `FieldValidationMessage`, `ExternalFieldError`, `ValidationMode`, `Issue` and `IssuePath`.

### Runtime validators {#runtime-validators}

```ts
function validateWith(validator: Validator, value: unknown, all = true): Promise<ValidationResult>;
```

| Member | Behavior |
| --- | --- |
| `validateWith`, `runValidation` | Run one `Validator` and return `{ valid, issues }`. `all` defaults to `true`, which reports every issue. `false` stops at the first. A validator that does not return an array throws `TypeError`. |
| `Validator` | `(value, all) => readonly SchemaIssue[]`, empty when the value is valid. |
| `OperationRuntimeValidators` | The value type of a client's `operationValidators` option: the input validator and the response validators keyed `status:contentType`. |
| `ValidationResult`, `SchemaIssue`, `SchemaIssueDetail` | Result and issue types of a `Validator`. |

## `@exprtlabs/golem/validation-runtime` {#validation-runtime}

Generated validators import this subpath. Your code does not. Semver covers the names that generated validators import.

## `@exprtlabs/golem/mobx` {#mobx}

```ts
import { asGenObservable } from '@exprtlabs/golem/mobx';
```

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-definition

| Member | Signature | Behavior |
| --- | --- | --- |
| `asGenObservable` | `(model, annotations?: ModelAnnotations<Model>): void` | Makes every generated field observable, then nested generated models ([MobX](/guide/mobx#initialize-your-class)). A second call on the same instance throws. |
| `ModelAnnotations` | `AnnotationsMap<Model, never>` | MobX annotations for your class members. They override the field defaults. |
| `ObservableApiOperation` | `ApiOperation` plus `readonly loading: boolean` | `loading` is observable and stays `true` until every execution settles. |
| `createObservableApiOperation` | `(name: string, run): ObservableApiOperation` | [`createApiOperation`](#client) with `loading`. Generated clients with `mobx: true` return it. |

## `@exprtlabs/golem/mobx-validation` {#mobx-validation}

```ts
import { getValidator } from '@exprtlabs/golem/mobx-validation';
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `getValidator` | `(model): ModelValidator` | The validator [`validation`](#validation) returns for that instance, made observable. |
| `enhanceValidatorWithMobX` | `(validator): validator` | Makes `issues`, `errors`, `valid` and `pending` computed, and `setIssues`, `setPending`, `clear` and `setErrors` actions. Repeated calls change nothing. |
| `ModelValidator` | `class extends ModelValidator` | A validator that is observable from construction. |

The module re-exports the types `ModelField`, `ModelValidationRules`, `Issue`, `ValidationMessage` and `ValidationMessages`.

## `@exprtlabs/golem/errors` {#errors}

```ts
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
```

<<< ../../examples/payments/server/provider/charges.ts#invalid-charge

| `LibError` member | Type | Meaning |
| --- | --- | --- |
| `constructor` | `(kind, message, issues?, options?: LibErrorOptions)` | `options` takes `cause` and `causedByInput`. |
| `kind` | `LibErrorKind` | The failure category. |
| `issues` | `readonly Issue[]` | Frozen copy of the issues. |
| `causedByInput` | `boolean` | `true` when the rejected value is at fault, `false` for a program fault. Defaults to `true` for `Validation` and `InvalidJson`. |
| `cause` | `unknown` | The original exception a `LibError` wraps. |

| `LibErrorKind` | Value | Thrown when |
| --- | --- | --- |
| `Validation` | `validation` | A checked call rejects a value. |
| `Serialization` | `serialization` | A value cannot be written as JSON, such as an invalid `Date` or a value that holds itself. |
| `Deserialization` | `deserialization` | JSON cannot be decoded, such as an unparsable date. |
| `InvalidJson` | `invalid_json` | `parse` receives text that is not JSON. |
| `ValidationUnavailable` | `validation_unavailable` | Checks were not generated, no build rewrote a call, or a validation context lacks a validator. |
| `Response` | `response` | A generated client receives a status or media type the operation does not declare. |

`ModelValidator.validate()` returns `false` for an invalid value. Checked serde calls and generated client checks throw `LibError` instead. A predicate, codec or native call that throws is wrapped once with its `cause`. A thrown `LibError` passes through unchanged. [Errors and issues](/guide/validation#errors-and-issues) shows how to read them.

| `Issue` field | Type | Meaning |
| --- | --- | --- |
| `code` | `IssueCode` | The failed check. Each code adds the typed fields listed below. |
| `message` | `string` | Display text. |
| `path` | `IssuePath` | String and number segments, such as `['items', 0, 'amount']`. |
| `source` | `IssueSource` | `typescript`, `openapi`, `custom`, `external`, `json` or `serde`. |
| `representation` | `IssueRepresentation` | Optional: `model` or `wire` (JSON) value. |

`Issue` is a union keyed by `code`. Check `issue.code` and TypeScript narrows to that code's fields, such as `issue.limit` after `issue.code === 'tooSmall'`.

| `code` | Extra fields | Failed check |
| --- | --- | --- |
| `type` | `expected` | The value has another type. `expected` lists `string`, `number`, `integer`, `boolean`, `null`, `object`, `array` or `Date`. |
| `instance` | `model` | The value is not an instance of the model class. |
| `required` | `key` | A property is missing. `path` ends at the missing key. |
| `unknownKey` | `key` | The object has a property the schema does not allow. `path` ends at the key. |
| `invalidKey` | `key` | A property name is not allowed. `path` points at the object. |
| `literal` | `expected` | The value is not one of the allowed constants, including an `anyOf` or `oneOf` whose alternatives are all constants. |
| `union` | `matched` | The value matches no alternative (`0`) or more than one where one is required. |
| `tooSmall`, `tooBig` | `measure`, `limit`, `inclusive` | A limit is crossed. `measure` is `length`, `items`, `properties`, `value` or `matches`. `inclusive` is `false` for an exclusive bound. |
| `pattern` | `pattern` | A string does not match the pattern. |
| `format` | `format` | A string is not in the named format. |
| `multipleOf` | `divisor` | A number is not a multiple of `divisor`. |
| `unique` | `indexes` | Two items are equal. `indexes` gives their positions. |
| `not` | none | The value matches a shape that is excluded. |
| `never` | none | The schema allows no value here. |
| `custom` | `reason` (optional) | A `TValidation` function or an instance rule rejected the value. `reason` holds the message the rule returned. |
| `external` | none | A message from `setErrors()`. |
| `invalid_json`, `serialization`, `deserialization` | none | The failures of the matching `LibErrorKind`. |

The default `message` is golem's English text built from these fields. `messages()` overrides replace it by code.

Other exports: `toIssue(issue, source, representation?)` adds the default message to a validator's issue. `snapshotIssues(issues)` freezes a list of issues. `LibErrorOptions`, `IssueDetail`, `JsonValue` and the enums `IssueSource` and `IssueRepresentation` are exported too.

## `@exprtlabs/golem/client` {#client}

```ts
import { createApiOperation, type ApiOperation } from '@exprtlabs/golem/client';

interface ApiOperation<Input, Result, Options = unknown> {
  execute(input: Input, options?: Options): Promise<Result>;
}
```

<<< ../../examples/payments/server/provider/charges.ts#reuse-request

| Member | Signature | Behavior |
| --- | --- | --- |
| `ApiOperation` | `{ execute(input, options?) }` | Generated client methods return one. Creating it sends nothing. Each `execute` sends a new request. |
| `ApiOperationRun` | `(input, options?) => Promise<Result>` | The work `execute` runs. |
| `createApiOperation` | `(name: string, run: ApiOperationRun): ApiOperation` | Wraps your own asynchronous call in the same interface. |

- Overlapping `execute` calls all run. Each one after the first logs `Concurrent execute() invocation for <name>`.
- An operation caches no results or errors.

[Create a client](/guide/client-usage#create-a-client) shows the generated client options. Generated SDKs call the request runtime in [Exports for generated code](#generated-code).

## `@exprtlabs/golem/conversion` {#conversion}

```ts
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `encodeGeneratedModel` | `(model): GeneratedModelWire<Model>` | A detached JSON-shaped copy of a generated model. Does not validate. |
| `decodeGeneratedModel` | `(constructor, value: unknown): GeneratedModelResult<Constructor>` | Builds an instance from `value` without copying it first. Fields without conversion are the input's own values. Returns an existing instance unchanged. Does not validate. |
| `assertAcyclicValue` | `(value, kind?)` | Throws `LibError` when `value` holds a cycle. Shared references are allowed. `kind` is `LibErrorKind.Serialization` or `LibErrorKind.Deserialization` (the default). |
| `readRootFields` | `(value: unknown, fields: readonly string[]): unknown` | Copies the root of `value`, reading each listed field once through its getter. |

Use `encodeGeneratedModel` and `decodeGeneratedModel` when the type is known only at runtime:

```ts
import { isGeneratedModel } from '@exprtlabs/golem/model';
import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';

export function responseBody(value: unknown): unknown {
  return isGeneratedModel(value) ? encodeGeneratedModel(value) : value;
}
```

Both throw `LibError` for missing generated metadata or cyclic input. With a known type, use [`toWireFormat<T>`](#serde) and `fromWireFormat<T>`, which also validate.

## `@exprtlabs/golem/tags` {#tags}

```ts
import type { MinLength, TSerde, TValidation } from '@exprtlabs/golem/tags';
```

Every export is a type. Intersect a tag with a field type. Assignment is unchanged and generation never runs your code.

| Member | Signature | Behavior |
| --- | --- | --- |
| Built-in constraints | `Integer`, `Minimum<N>`, `MinLength<N>`, `Pattern<S>`, `Format<S>`, … | JSON Schema keywords ([built-in constraints](/guide/tags#built-in-validation-constraints)). |
| Short names | `Min`, `Max`, `ExclusiveMin`, `ExclusiveMax`, `MinProps`, `MaxProps` | Aliases of `Minimum`, `Maximum`, `ExclusiveMinimum`, `ExclusiveMaximum`, `MinProperties`, `MaxProperties`. |
| `TValidation` | `TValidation<typeof predicate>` | Runs an exported synchronous function that returns `true` or an error message ([custom rule](/guide/tags#add-a-custom-field-rule)). |
| `TSerde` | `TSerde<typeof serialize, typeof deserialize>` | Converts the field between model value and JSON value ([serialize formatter](/guide/serialization#change-the-json-form)). |
| `TSerdeWire` | `TSerdeWire<Value>` | `[Wire]`, the deserializer's input type, or `[]` without `TSerde`. |
| `BuiltinModelTag` | union type | Every built-in constraint. |
| `ModelValidationFunction`, `ModelSerializeFunction`, `ModelDeserializeFunction` | function types | The function shapes that `TValidation` and `TSerde` accept. |

The `TSerde` deserializer's parameter type sets the JSON schema of the field ([which type controls validation](/guide/serialization#which-type-controls-validation)).

## `@exprtlabs/golem/temporal` {#temporal}

Temporal field types for models. Each converts to an ISO 8601 string on the wire. [Use Temporal fields](/guide/dates#use-temporal-fields) shows the setup.

| Tag | Model type | Wire string |
| --- | --- | --- |
| `TemporalInstant` | `Temporal.Instant` | `2025-01-02T03:04:05.123Z` |
| `TemporalZonedDateTime` | `Temporal.ZonedDateTime` | `2025-01-02T03:04:05+01:00[Europe/Paris]` |
| `TemporalPlainDate` | `Temporal.PlainDate` | `2025-01-02` |
| `TemporalPlainDateTime` | `Temporal.PlainDateTime` | `2025-01-02T03:04:05` |
| `TemporalPlainTime` | `Temporal.PlainTime` | `03:04:05.123` |
| `TemporalDuration` | `Temporal.Duration` | `P1DT2H` |

The wire string has a four-digit year and no calendar annotation.

Each tag `TemporalX` has the functions `serializeTemporalX` and `deserializeTemporalX` and the type `TemporalXWire`. Its `TSerde` uses the two functions.

## `@exprtlabs/golem/serde` {#serde}

```ts
import { fromWireFormat, parse, stringify, toWireFormat } from '@exprtlabs/golem/serde';
```

<<< ../../examples/models/src/read-json.ts#read-json

::: warning Build with golem
`parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` and `validate<T>` throw `ValidationUnavailable` unless a [build host](/guide/build) rewrote them. `tsc` does not rewrite them.
:::

`T` names a generated `IObject` or `IModel`. A type alias returns a plain object. Your class returns an instance of it.

| Member | Signature | Behavior |
| --- | --- | --- |
| `parse` | `<T>(text: string, options?: SerdeOptions): T` | JSON text to a value. Checks the JSON, runs `TSerde` decoders, checks the result. |
| `stringify` | `<T>(value: T, options?: SerdeOptions & AllowGetterOptions): string` | Value to JSON text of the declared fields, with `TSerde` applied and both sides checked. |
| `fromWireFormat` | `<T>(wire: unknown, options?: SerdeOptions): T` | `parse` for a plain object instead of text. |
| `toWireFormat` | `<T>(value: T, options?: SerdeOptions & AllowGetterOptions): WireFormat<T>` | `stringify` that returns the plain object, such as `TTaskJSON`. |
| `assertValue` | `<T>(value: unknown, options?: ValidateOptions & AllowGetterOptions): T` | Checks the value and returns it unchanged, typed as `T`. Throws `LibError` `Validation` with the issues. |

| Option | In | Default | Effect |
| --- | --- | --- | --- |
| `validate` | `SerdeOptions` | `true` when generated | `false` skips the checks. `true` throws `ValidationUnavailable` if checks were not generated. |
| `failFast` | both | `true` | `false` reports every issue. It does not skip checks. |
| `validationContext` | both | none | Resolves validators from your own function ([validation context](#validation-context)). |
| `allowGetter` | `AllowGetterOptions` | `false` | `true` reads declared root fields through getters and inherited values ([below](#allow-getter)). |

`ValidateOptions` has `failFast` and `validationContext`. The rewrite also passes `construct` in `SerdeOptions` for a class `T`. Each call runs the checks in the table of [Checks during conversion](/guide/serialization#checks-during-conversion).

### `allowGetter` {#allow-getter}

`AllowGetterOptions` has `allowGetter?: boolean`. `stringify`, `toWireFormat`, `validate` and `assertValue` take it, and so do the same calls of an `ObjectCodec`.

```ts
stringify<TTask>(task, { allowGetter: true });
```

By default a field counts when it is an own enumerable property, as in `JSON.stringify`. With `allowGetter: true`, a declared field of the root object also counts when a getter or an inherited value supplies it.

- It applies to the root value of an `IObject` or `IModel` codec. Nested values are judged as without it.
- `parse`, `fromWireFormat`, `validateInstance` and `ModelValidator` do not take it.

### Validation context {#validation-context}

Pass one `ModelValidationContext` to repeated serde, `validateInstance` and `ModelValidator.validate` calls to reuse resolved validators.

| Field | Behavior |
| --- | --- |
| `resolve(reference, mode)` | Returns the `Validator` for a schema reference and `'first'` or `'all'` mode, or `undefined` when it has none. |

`objectCodecValidationReference(codec, plane)` returns the reference for one `ValidationPlane`.

| `ValidationPlane` | Checks | Used by |
| --- | --- | --- |
| `model` | the model value | `validate`, `validateInstance`, and `stringify` / `toWireFormat` before encoding |
| `wire` | the JSON value | `parse` / `fromWireFormat` before decoding |
| `model-only` | converted fields and `TValidation` rules on the model value | `parse` / `fromWireFormat` after decoding |
| `wire-only` | the JSON written for converted fields | `stringify` / `toWireFormat` after encoding |

- A context is authoritative. A missing validator throws `ValidationUnavailable` instead of using the generated one.
- Resolved validators are cached per context object, reference and mode. Create a new context when schemas change.
- A validator returns an array of issues, empty when the value is valid. Any other result throws `TypeError`. A promise throws `ValidationUnavailable` in synchronous serde calls.

### Codec registry

| Member | Signature | Behavior |
| --- | --- | --- |
| `registerObjectCodec` | `(codec: ObjectCodec): void` | Stores a codec under its id. |
| `getObjectCodec` | `(id): ObjectCodec \| undefined` | Returns the codec for an id. |
| `getIModelClass` | `(name): class \| undefined` | Returns the registered `IModel` class for a name. |
| `findCodecIdForConstructor` | `(constructor): string \| undefined` | Returns the id that the codec of a generated class is registered under. |
| `resolveModelValidationContextValidator` | `(context, reference, mode): Validator` | Returns the validator that a `ModelValidationContext` gives for a reference. Caches it per context. |
| `validationFailure` | `(issues): never` | Throws `LibError` `Validation` with the issues. |
| `serdeFailFast` | `(options): boolean` | Returns `false` only when `failFast` is `false`. |
| `resolveGeneratedModelSchemaRefs` | `(schema, plane): object` | Replaces the model `$ref` placeholders in a schema with registered schema ids. |

Types: `AllowGetterOptions`, `ObjectCodec`, `ObjectCodecImpl`, `SerdeOptions`, `ValidateOptions`, `ValidationPlane`, `WireFormat`. `IssueRepresentation` and `IssueSource` are re-exported from [`errors`](#errors).

## `@exprtlabs/golem/nest` {#nest}

```ts
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
```

<<< ../../examples/payments/server/src/application.ts#global-model-http

| Member | Signature | Behavior |
| --- | --- | --- |
| `NestModelInterceptor` | `class NestModelInterceptor implements NestInterceptor` | Converts model-typed `@Body()` and `@Query()` parameters before the handler and writes model returns ([request contract](/guide/nestjs-requests#what-happens-to-a-request)). |
| `nestModelStringifyInterceptor` | `(codec: ObjectCodec): NestInterceptor` | Writes every non-null result with that codec's `stringify`, an array item by item. |
| `objectCodecFromMetatype` | `<T>(metatype: unknown): ObjectCodec<T> \| undefined` | The codec of a parameter token that `nestModelCodec` placed, such as the `design:paramtypes` entry of a `@Body()` parameter. `undefined` for a raw class. |
| `nestModelConstruct` | `(metatype: unknown)` | The class that token constructs, or `undefined`. |

For inbound conversion in your own interceptor or pipe, get the codec with `objectCodecFromMetatype` and call its `fromWireFormat`.

## `@exprtlabs/golem/loader` {#loader}

A Node `load` hook that rewrites TypeScript files as Node loads them. Install it through [`register`](#register). Import `loader` only to call `module.register` yourself ([Node loader](/guide/build#node-loader)).

- It rewrites only `.ts`, `.mts` and `.cts` files outside `node_modules`. A `.tsx` file goes to Node unchanged.
- It needs ES modules. A `.cts` file, or a `.ts` file under a CommonJS `package.json`, that holds a call to rewrite throws `golem rewrites need ES modules`. The message names the file.
- A call that cannot be rewritten fails the load with the file, the line and the instruction to run `golem generate`.
- Without a `golem.yaml`, the load fails with `golem needs a golem.yaml to rewrite parse<T>() calls; set config or GOLEM_CONFIG`.

## `@exprtlabs/golem/register` {#register}

```sh
node --import @exprtlabs/golem/register src/main.ts
```

Every later import of the process goes through the loader. The loader opens your project from the file that `GOLEM_CONFIG` names, else `./golem.yaml` in the working directory ([Node loader](/guide/build#node-loader)).

## `@exprtlabs/golem/vite` {#vite}

```ts
import { golem } from '@exprtlabs/golem/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [golem()] });
```

| Option | Type | Behavior |
| --- | --- | --- |
| `config` | `string` | The `golem.yaml` to open, relative to Vite's `root`. Without it the plugin uses `GOLEM_CONFIG`, else `./golem.yaml` in `root`. |

The plugin rewrites TypeScript in memory before Vite strips its types ([Vite](/guide/build#vite)). Put `golem()` before plugins that transform TypeScript.

- An id with a query, such as `?raw`, is not rewritten.
- The dev server rewrites a module again when a file its rewrite depends on, or a generated model file, changes.
- The page reloads once for the file events of one run. The first event opens a 100 ms window, and the events in that window share one reload.
- Without a `golem.yaml`, or for a call that cannot be rewritten, the build fails with the same messages as the [loader](#loader).

## `@exprtlabs/golem/esbuild` {#esbuild}

```ts
import { golem } from '@exprtlabs/golem/esbuild';
import { build } from 'esbuild';

await build({ entryPoints: ['src/main.ts'], bundle: true, outfile: 'dist/main.js', plugins: [golem()] });
```

| Option | Type | Behavior |
| --- | --- | --- |
| `config` | `string` | The `golem.yaml` to open, relative to `absWorkingDir` (default: the current directory). Without it the plugin uses `GOLEM_CONFIG`, else `./golem.yaml` in `absWorkingDir`. |

The plugin rewrites TypeScript in memory before esbuild strips its types and chains the source map into the bundle's ([esbuild](/guide/build#esbuild)). A plugin that needs the TypeScript files goes before `golem()`.

- Watch mode builds a file again when a file its rewrite depends on changes.
- Without a `golem.yaml`, or for a call that cannot be rewritten, the build fails with the same messages as the [loader](#loader).

## Exports for generated code {#generated-code}

Generated files import these names. Application code does not call them. They follow semver ([Compatibility](/compatibility#public-api)).

### From `model`

`registerGeneratedModel`, `findGeneratedModelDefinition`, `findGeneratedModelDefinitionForConstructor`, `GeneratedModel`, `GeneratedModelWire`, `GeneratedModelConstructor`, `ModelInit` and the `generatedModel*Brand` symbols.

### From `validation`

`operationValidators` resolves the input and response validators of an operation once per client. `validateOperationInput` checks a request input. `responseCheck` is the response check that `ClientRuntime.readResponse` runs on each decoded body or stream item.

### From `conversion`

`encodeGeneratedModel`, `decodeGeneratedModelTrusted`, `deserializeDate`, `serializeDate`, `convertModelField`, `convertModelItems`, `convertModelTupleItems`, `defineModelProperty`, `requireModelObject`, `assertAcyclicEncodeInput`, `assertPropertyAcyclic`, `assertWireAcyclic`, `beginDecode`, `endDecode`, `beginEncode`, `endEncode`, `decodeDetachedInput`, `decodeCheckedInput`, `unknownDiscriminatorValue`, `withDiscriminatorValue`, `jsonWithDiscriminator`.

### From `serde`

`createObjectCodec`, `requireObjectCodec`, `registerIModelClass`, `requireIModelClass`, `assertModelValue`, `isValidModelValue`, `modelValueIssues`, `parseJson`, `serdeValidates`, `validationUnavailable`, `withoutInstanceState` and the `stringifyJson*` writers.

### From `nest`

| Member | Signature | Behavior |
| --- | --- | --- |
| `nestModelCodec` | `(id: string, array?: boolean): ParameterDecorator` | The rewrite inserts it on `@Body()` and `@Query()` parameters typed with a model or an array of one. It replaces the parameter type with a token that carries the codec and class of the model. |
| `nestModelReturn` | `(id: string, array?: boolean): MethodDecorator` | The rewrite inserts it on a handler that returns a model. `NestModelInterceptor` reads it. |

### From `client`

| Member | Behavior |
| --- | --- |
| `ClientRuntime` | Holds a client's options and sends its requests. `new ClientRuntime(client, options)`. `readResponse` selects the declared response, decodes it and runs the operation's response check. |
| `isUndeclaredResponseError` | `(error, client?)`: true for a status or media type the operation does not declare |
| `serializePath` | Writes a path parameter |
| `addQueryParameter` | Adds a query parameter |
| `setQueryString` | Sets a whole querystring parameter |
| `appendQuery` | Appends one encoded query pair |
| `serializeHeaderSimple` | Writes a header value |
| `serializeContentParameter` | Writes a parameter with a media type |
| `addCookieParameter` | Adds a cookie parameter |
| `addCookieStyleParameter` | Adds a cookie-style parameter |
| `encodeBody` | Encodes a request body for its media type |
| `applySecurity` | Adds credentials for the operation's security requirements |
| `encode` | Percent-encodes a value |

The module also exports the types these functions use: `ClientOptions`, `RequestOptions`, `ParameterSerializer`, `EncodedBody`, `BodyEncoder`, `MutualTlsTransport`, `ResponseHeaderDecoder`, `StreamDecoder`, `ResponseDecoder`, `UndeclaredResponseError`, `AuthContext`, `TokenAuthValue`, `BasicCredentials`, `BasicAuthValue` and `RuntimeSecuritySchemes`. Each SDK aliases the option types with its client name, such as `PaymentsClientOptions`.
