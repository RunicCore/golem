# Runtime API

Find every `@exprtlabs/golem` import your application, NestJS app or tool can use, with its signature and behavior.

| Subpath | Use | Extra dependency |
| --- | --- | --- |
| [`model`](#model) | `IModel`, `IObject`, generated-model types and guards | none |
| [`validation`](#validation) | `validate<T>`, `validateInstance`, `getValidator`, `ModelValidator` | none |
| [`mobx`](#mobx) | `asGenObservable` and observable API operations | `mobx` |
| [`mobx-validation`](#mobx-validation) | Observable validator state | `mobx` |
| [`errors`](#errors) | `LibError`, `LibErrorKind` and the `Issue` type | none |
| [`client`](#client) | `ApiOperation` and `createApiOperation` | none |
| [`conversion`](#conversion) | Encode and decode a generated model | none |
| [`tags`](#tags) | Type-only validation constraints, `TValidation`, `TSerde` | none |
| [`temporal`](#temporal) | Temporal field types and their codecs | a `Temporal` global, such as `temporal-polyfill` |
| [`serde`](#serde) | `parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` | none |
| [`nest`](#nest) | `NestModelInterceptor` and the decorators the rewrite inserts | `@nestjs/common`, `rxjs` |
| [`generator-api`](#generator-api) | Contracts shared by the generators | none |
| [`manifest`](#manifest) | Read and find `model-manifest.json` files | none |
| [`rewrite`](#rewrite) | Apply a file's rewrite edits to its text and get its source map | none |
| [`loader`](#loader) | Node `load` hook that rewrites TypeScript as Node loads it | none |
| [`register`](#register) | `node --import` entry that installs the loader | none |
| [`vite`](#vite) | Vite plugin that rewrites TypeScript before Vite strips its types | `vite` |
| [`esbuild`](#esbuild) | esbuild plugin that rewrites TypeScript before esbuild strips its types | `esbuild` |

Internal subpaths used by the generators: `cli`, `emitter`, `schema`, `schema-graph`, `type-analysis`, `generated-paths`, `validation-runtime`, `validator-compiler`, `validation-plan`, [`ts`](#ts). Don't import them; they may change in any release.

With `validation: true`, generated files import their own validator modules and need no extra package ([validation profiles](/reference/config#validation-profiles)).

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
| `exact` | root `exact`, `true` | `false` admits keys the declaration does not list; `true` tightens a root `false`. |
| `allowAny` | root `allowAny`, `false` | Permits `any` and `unknown` fields in this declaration; `false` tightens a root `true`. |
| `validation` | root `validation`, `true` | Generates checks for this named `IObject` or `IModel`. A nested declaration uses its own setting. |

`allowAny` does not remove validation constraints or skip JSON checks. A field typed `any` or `unknown` fails with [`RUNM1011`](/reference/diagnostics#runm1011) unless `allowAny` is `true`.

Generation writes `task.model.generated.ts` with `TTaskBaseModel`, `TTaskFields` (field types), `TTaskJSON` (JSON shape) and `TTaskInit` (constructor values). The `TTaskBaseModel` constructor copies the values it receives and does not validate, so an incomplete draft is valid state.

Used by generated code: `registerGeneratedModel`, `findGeneratedModelDefinition`, `findGeneratedModelDefinitionForConstructor`, `GeneratedModel`, `GeneratedModelWire`, `GeneratedModelConstructor`, `ModelInit` and the `generatedModel*Brand` symbols.

Also exported types: `GeneratedModelFields<Model>` is the field types of a generated model. `GeneratedModelResult<Constructor>` is the instance type of a generated class. `GeneratedModelDefinition`, `RegisteredGeneratedModelDefinition`, `GeneratedModelConversion`, `GeneratedModelProfile` and `GeneratedModelValidatorEnhancer` describe the metadata that `registerGeneratedModel` stores for a class. `ModelTypeMetadata`, `ModelTypeDescriptor`, `ModelConstraint`, `ConstraintSchemaValue`, `UnionDiscriminator` and `DiscriminatorValue` describe the type information that generation records for a field.

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
| `getValidator` | `(model): ModelValidator<Fields, Owner>` | Returns the same stateful validator for a model instance every time. `Fields` are the generated field types, so methods of your class are not fields. |
| `validateInstance` | `(model, options?: ValidateOptions): Promise<readonly Issue[]>` | Returns the current issues without changing the stored state ([validation](/guide/validation)). |
| `validate` | `<T>(value: unknown, options?: ValidateOptions & AllowGetterOptions): value is T` | Checks a value against a named `IObject` or `IModel` and narrows it. Needs a [build that rewrites it](/guide/install#typescript-setup). |
| `ModelValidator` | `class ModelValidator<Fields, Owner = Fields>` | The stateful validator; members below. |

`validateInstance`, `validate` and `ModelValidator.validate` stop at the first issue unless you pass `{ failFast: false }`. An invalid value is an ordinary result. They throw `LibError` when validation can't run: the model was generated with `validation: false` (`ValidationUnavailable`), generated metadata is missing, or a converter throws.

### `ModelValidator` members {#model-validator}

`new ModelValidator(model)` attaches a validator to a model instance; `getValidator(model)` does that once and caches it.

| Member | Signature | Behavior |
| --- | --- | --- |
| `validate` | `(options?: ValidateOptions): Promise<boolean>` | Runs generated checks, then instance rules, and stores the issues. A newer call wins over an older one. |
| `issues` | `readonly Issue[]` | Stored issues, frozen. |
| `errors` | `Readonly<Record<string, readonly string[]>>` | Messages keyed by escaped JSON Pointer, such as `/items/0/sku`. |
| `valid` | `boolean` | `true` when no issues are stored. It does not track later edits. |
| `pending` | `boolean` | `true` while `validate` runs. |
| `error` | `(field): string \| undefined` | First message for a field name or path array such as `['items', 0, 'sku']`. |
| `errorsFor` | `(field): readonly string[]` | All messages for that field name or path. |
| `extend` | `(rules: ModelValidationRules<Fields, Owner>): this` | Adds rules for this instance. A rule returns `true`, a message, `{ message }`, or a promise of any of them. A rejecting rule reports a `custom` issue. |
| `messages` | `(messages: ValidationMessages<Fields>): this` | Replaces generated messages by code (`'tooSmall'`) or field and code (`'title.tooSmall'`). |
| `setErrors` | `(errors): void` | Stores messages from outside, such as a server response, as `external` issues. Takes a field map or `{ path, message }[]`. |
| `clear` | `(): void` | Removes stored issues and resets `pending`. |
| `setIssues` | `(issues: readonly Issue[]): void` | Replaces the stored issues. |
| `setPending` | `(pending: boolean): void` | Sets `pending`. |
| `formatIssue` | `(issue: Issue, explicit: boolean): Issue` | Applies `messages()` overrides unless `explicit`. Used by nested validation. |

Types for these members: `ModelValidationRules`, `ValidationRule`, `ValidationRuleResult`, `ValidationMessages`, `ValidationMessage`, `ValidationMessageKey`, `FieldValidationMessage`, `ExternalFieldError`, `ValidationMode`, `Issue` and `IssuePath`.

Used by generated code, in operation modules: `operationValidators` (resolves an operation's input and response validators once per client), `validateOperationInput` and `responseCheck` (the response check `ClientRuntime.readResponse` runs on each decoded body or stream item).

Also exported: `runValidation(validator, value, all = true)` runs a `Validator` and returns a `Promise` of a `ValidationResult`. It throws `TypeError` when the validator does not return an array.

### Runtime validators {#runtime-validators}

```ts
function validateWith(validator: Validator, value: unknown, all = true): Promise<ValidationResult>;
```

`validateWith` runs one validator and returns `{ valid, issues }`. `all` defaults to `true`, which reports every issue; pass `false` to stop at the first. A validator that does not return an array throws `TypeError`.

Types: `OperationRuntimeValidators`, `ValidationResult`, `Validator`, `SchemaIssue` and `SchemaIssueDetail`. `OperationRuntimeValidators` is the value type of a client's `operationValidators` option: the input validator and the response validators keyed `status:contentType`. Each validator is a `Validator`: `(value, all) => readonly SchemaIssue[]`, empty when the value is valid.

## `@exprtlabs/golem/mobx` {#mobx}

```ts
import { asGenObservable } from '@exprtlabs/golem/mobx';
```

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-definition

| Member | Signature | Behavior |
| --- | --- | --- |
| `asGenObservable` | `(model, annotations?: ModelAnnotations<Model>): void` | Makes every generated field observable, then nested generated models. Extra MobX annotations override field defaults. A second call on the same instance throws. |
| `ModelAnnotations` | `AnnotationsMap<Model, never>` | MobX annotations for your class members. |
| `ObservableApiOperation` | `ApiOperation` plus `readonly loading: boolean` | `loading` is observable and stays `true` until every execution settles. |
| `createObservableApiOperation` | `(name: string, run): ObservableApiOperation` | [`createApiOperation`](#client) with `loading`. |

Call `asGenObservable(this)` in your class constructor after `super(values)` and your field initializers ([MobX](/guide/mobx#initialize-your-class)). Generated clients with `mobx: true` return `ObservableApiOperation`.

## `@exprtlabs/golem/mobx-validation` {#mobx-validation}

```ts
import { getValidator } from '@exprtlabs/golem/mobx-validation';
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `getValidator` | `(model): ModelValidator` | The validator [`validation`](#validation) returns for that instance, made observable. |
| `enhanceValidatorWithMobX` | `(validator): validator` | Makes `issues`, `errors`, `valid` and `pending` computed, and `setIssues`, `setPending`, `clear` and `setErrors` actions. Repeated calls change nothing. |
| `ModelValidator` | `class extends ModelValidator` | A validator that is observable from construction. |

Models generated with `mobx: true` and `validation: true` register `enhanceValidatorWithMobX`, so `getValidator` from `validation` already returns an observable validator for them. The module also re-exports the validation types.

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
| `causedByInput` | `boolean` | `true` when the rejected value is at fault; `false` for a program fault. Defaults to `true` for `Validation` and `InvalidJson`. `NestModelInterceptor` returns HTTP 400 when it is `true`. |
| `cause` | `unknown` | The original exception a `LibError` wraps. |

| `LibErrorKind` | Value | Thrown when |
| --- | --- | --- |
| `Validation` | `validation` | A checked call rejects a value. |
| `Serialization` | `serialization` | A value can't be written as JSON, such as an invalid `Date` or a value that holds itself. |
| `Deserialization` | `deserialization` | JSON can't be decoded, such as an unparsable date. |
| `InvalidJson` | `invalid_json` | `parse` receives text that is not JSON. |
| `ValidationUnavailable` | `validation_unavailable` | Checks were not generated, no build rewrote a call, or a validation context lacks a validator. |
| `Response` | `response` | A generated client receives a status or media type the operation does not declare. |

`ModelValidator.validate()` returns `false` for an invalid value. Checked serde calls and generated client checks throw `LibError` instead. A predicate, codec or native call that throws is wrapped once with its `cause`; a thrown `LibError` passes through unchanged. Network failures reject with the `fetch` error.

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
| `tooSmall`, `tooBig` | `measure`, `limit`, `inclusive` | A limit is crossed. `measure` is `length`, `items`, `properties`, `value` or `matches`; `inclusive` is `false` for an exclusive bound. |
| `pattern` | `pattern` | A string does not match the pattern. |
| `format` | `format` | A string is not in the named format. |
| `multipleOf` | `divisor` | A number is not a multiple of `divisor`. |
| `unique` | `indexes` | Two items are equal; `indexes` gives their positions. |
| `not` | none | The value matches a shape that is excluded. |
| `never` | none | The schema allows no value here. |
| `custom` | `reason` (optional) | A `TValidation` function or an instance rule rejected the value. `reason` holds the message the rule returned. |
| `external` | none | A message from `setErrors()`. |
| `invalid_json`, `serialization`, `deserialization` | none | The failures of the matching `LibErrorKind`. |

The default `message` is golem's English text built from these fields. `messages()` overrides replace it by code.

`toIssue(issue, source, representation?)` adds the default message to a validator's issue, and `snapshotIssues` freezes a list of issues.

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
| `ApiOperation` | `{ execute(input, options?) }` | Generated client methods return one. Creating it sends nothing; each `execute` sends a new request. |
| `ApiOperationRun` | `(input, options?) => Promise<Result>` | The work `execute` runs. |
| `createApiOperation` | `(name: string, run: ApiOperationRun): ApiOperation` | Wraps your own asynchronous call in the same interface. |

- Overlapping `execute` calls all run; each one after the first logs `Concurrent execute() invocation for <name>`.
- An operation caches no results or errors.

Generated SDKs call the request runtime. Application code rarely does.

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

The module also exports the types these functions use, including `ClientOptions`, `RequestOptions`, `ParameterSerializer`, `EncodedBody`, `BodyEncoder`, `MutualTlsTransport`, `ResponseHeaderDecoder`, `StreamDecoder`, `ResponseDecoder`, `UndeclaredResponseError`, `AuthContext`, `TokenAuthValue`, `BasicCredentials`, `BasicAuthValue` and `RuntimeSecuritySchemes`. Each SDK aliases the option types with its client name, such as `PaymentsClientOptions`.

Generated client options are in [Create a client](/guide/client-usage#create-a-client).

## `@exprtlabs/golem/conversion` {#conversion}

```ts
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `encodeGeneratedModel` | `(model): GeneratedModelWire<Model>` | A detached JSON-shaped copy of a generated model. Does not validate. |
| `decodeGeneratedModel` | `(constructor, value: unknown): GeneratedModelResult<Constructor>` | Builds an instance from `value` without copying it first; fields without conversion are the input's own values. Returns an existing instance unchanged. Does not validate. |

Use them when the type is known only at runtime:

```ts
import { isGeneratedModel } from '@exprtlabs/golem/model';
import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';

export function responseBody(value: unknown): unknown {
  return isGeneratedModel(value) ? encodeGeneratedModel(value) : value;
}
```

Both throw `LibError` for missing generated metadata or cyclic input. With a known type, use [`toWireFormat<T>`](#serde) and `fromWireFormat<T>`, which also validate.

Used by generated code: `encodeGeneratedModel`, `decodeGeneratedModelTrusted`, `deserializeDate`, `serializeDate`, `convertModelField`, `convertModelItems`, `convertModelTupleItems`, `defineModelProperty`, `requireModelObject`, `assertAcyclicEncodeInput`, `assertPropertyAcyclic`, `assertWireAcyclic`, `beginDecode`, `endDecode`, `beginEncode`, `endEncode`, `decodeDetachedInput`, `decodeCheckedInput`, `unknownDiscriminatorValue`, `withDiscriminatorValue`, `jsonWithDiscriminator`.

Also exported: `assertAcyclicValue(value, kind?)` throws `LibError` when `value` holds a cycle. Shared references are allowed. `kind` is `LibErrorKind.Serialization` or `LibErrorKind.Deserialization` (the default).

## `@exprtlabs/golem/tags` {#tags}

```ts
import type { MinLength, TSerde, TValidation } from '@exprtlabs/golem/tags';
```

Every export is a type. Intersect a tag with a field type; assignment is unchanged and generation never runs your code.

| Member | Signature | Behavior |
| --- | --- | --- |
| Built-in constraints | `Integer`, `Minimum<N>`, `MinLength<N>`, `Pattern<S>`, `Format<S>`, … | JSON Schema keywords ([built-in constraints](/guide/tags#built-in-validation-constraints)). |
| Short names | `Min`, `Max`, `ExclusiveMin`, `ExclusiveMax`, `MinProps`, `MaxProps` | Aliases of `Minimum`, `Maximum`, `ExclusiveMinimum`, `ExclusiveMaximum`, `MinProperties`, `MaxProperties`. |
| `TValidation` | `TValidation<typeof predicate>` | Runs an exported synchronous function that returns `true` or an error message ([custom rule](/guide/tags#add-a-custom-field-rule)). |
| `TSerde` | `TSerde<typeof serialize, typeof deserialize>` | Converts the field between model value and JSON value ([serialize formatter](/guide/tags#convert-a-field-to-a-different-json-value)). |
| `TSerdeWire` | `TSerdeWire<Value>` | `[Wire]`, the deserializer's input type, or `[]` without `TSerde`. |
| `BuiltinModelTag` | union type | Every built-in constraint. |

The `TSerde` deserializer's parameter type sets the JSON schema of the field ([which type controls validation](/guide/tags#which-type-controls-validation)). A parameter typed `unknown` fails with [`RUNM1011`](/reference/diagnostics#runm1011) unless `allowAny` is `true`.

Also exported: `ModelValidationFunction`, `ModelSerializeFunction`, `ModelDeserializeFunction`.

## `@exprtlabs/golem/temporal` {#temporal}

Temporal field types for models. Each converts to an ISO 8601 string on the wire.

| Tag | Model type | Wire string |
| --- | --- | --- |
| `TemporalInstant` | `Temporal.Instant` | `2025-01-02T03:04:05.123Z` |
| `TemporalZonedDateTime` | `Temporal.ZonedDateTime` | `2025-01-02T03:04:05+01:00[Europe/Paris]` |
| `TemporalPlainDate` | `Temporal.PlainDate` | `2025-01-02` |
| `TemporalPlainDateTime` | `Temporal.PlainDateTime` | `2025-01-02T03:04:05` |
| `TemporalPlainTime` | `Temporal.PlainTime` | `03:04:05.123` |
| `TemporalDuration` | `Temporal.Duration` | `P1DT2H` |

- Add `"esnext.temporal"` to `compilerOptions.lib`.
- Load a `Temporal` before converting, for example `import 'temporal-polyfill/global'`. Without one, conversion fails with "Temporal is not available".
- Calendar annotations such as `[u-ca=japanese]` and years outside 0000-9999 are rejected.

## `@exprtlabs/golem/serde` {#serde}

```ts
import { fromWireFormat, parse, stringify, toWireFormat } from '@exprtlabs/golem/serde';
```

<<< ../../examples/models/src/read-json.ts#read-json

::: warning Build with golem
`parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` and `validate<T>` throw `ValidationUnavailable` unless a build rewrote them: run `golem generate`, then [`golem build`](/reference/cli#build), the [Vite](#vite) or [esbuild](#esbuild) plugin, or the [Node loader](#loader). `tsc` does not rewrite them. They work on TypeScript 6 and 7.
:::

`T` names a generated `IObject` or `IModel`. A type alias returns a plain object; your class returns an instance of it.

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

`ValidateOptions` has `failFast` and `validationContext`. The rewrite also passes `construct` in `SerdeOptions` for a class `T`. The call order and checks per call are in [Validation during conversion](/guide/serialization#validation-during-conversion).

### `allowGetter` {#allow-getter}

`AllowGetterOptions` has `allowGetter?: boolean`. `stringify`, `toWireFormat`, `validate` and `assertValue` take it, and so do the same calls of an `ObjectCodec`.

```ts
stringify<TTask>(task, { allowGetter: true });
```

By default a field counts when it is an own enumerable property, as in `JSON.stringify`. With `allowGetter: true`, a declared field of the root object also counts when a getter or an inherited value supplies it.

- It applies to the root value of an `IObject` or `IModel` codec. Nested values are judged as without it.
- `parse`, `fromWireFormat`, `validateInstance` and `ModelValidator` do not take it.
- With `allowGetter`, a field can also come from a polluted `Object.prototype`.

- `JSON.stringify(model)` does not convert or validate.
- A `Date` field decodes with ECMAScript `Date` parsing; a non-string or unparsable value throws `Deserialization` with `causedByInput: true`. Put format rules on `Format<'date-time'>` or `TValidation`.
- A `Date` encodes as UTC ISO text with milliseconds; years outside 0000–9999 throw `Serialization`.
- Conversion rejects non-finite numbers, `bigint`, functions, symbols, cycles, array holes and non-plain objects, except in a field whose [`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value) codec converts the value.

### Validation context {#validation-context}

Pass one `ModelValidationContext` to repeated serde, `validateInstance` and `ModelValidator.validate` calls to reuse resolved validators.

| Field | Behavior |
| --- | --- |
| `resolve(reference, mode)` | Returns the `Validator` for a schema reference and `'first'` or `'all'` mode, or `undefined` when it has none. |

| Reference | Checks | Used by |
| --- | --- | --- |
| `Id` | the model value | `validate`, `validateInstance`, and `stringify` / `toWireFormat` before encoding |
| `Id#wire` | the JSON value | `parse` / `fromWireFormat` before decoding |
| `Id#model-only` | converted fields and `TValidation` rules on the model value | `parse` / `fromWireFormat` after decoding |
| `Id#wire-only` | the JSON written for converted fields | `stringify` / `toWireFormat` after encoding |

- `objectCodecValidationReference(codec, plane)` returns the reference for one `ValidationPlane`.
- A context is authoritative: a missing validator throws `ValidationUnavailable` instead of using the generated one.
- Resolved validators are cached per context object, reference and mode. Create a new context when schemas change.
- A validator must return an array of issues, empty when the value is valid. Any other result throws `TypeError`, and a promise throws `ValidationUnavailable` in synchronous serde calls.

Types: `AllowGetterOptions`, `ObjectCodec`, `ObjectCodecImpl`, `SerdeOptions`, `ValidateOptions`, `ValidationPlane`, `WireFormat`; `IssueRepresentation` and `IssueSource` are re-exported from [`errors`](#errors).

Used by generated code: `createObjectCodec`, `requireObjectCodec`, `registerIModelClass`, `requireIModelClass`, `assertModelValue`, `isValidModelValue`, `parseJson`, `serdeValidates`, `validationUnavailable`, `withoutInstanceState` and the `stringifyJson*` writers.

Also exported: `registerObjectCodec(codec)` stores an `ObjectCodec` under its id. `getObjectCodec(id)` returns the codec for an id, or `undefined`. `getIModelClass(name)` returns the registered `IModel` class for a name, or `undefined`. `findCodecIdForConstructor(constructor)` returns the id that the codec of a generated class is registered under, or `undefined`. `resolveModelValidationContextValidator(context, reference, mode)` returns the `Validator` that a `ModelValidationContext` gives for a reference, and caches it per context. `validationFailure(issues)` throws `LibError` `Validation` with the issues. `serdeFailFast(options)` returns `false` only when `failFast` is `false`. `resolveGeneratedModelSchemaRefs(schema, plane)` replaces the model `$ref` placeholders in a schema with registered schema ids.

## `@exprtlabs/golem/nest` {#nest}

```ts
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
```

<<< ../../examples/payments/server/src/application.ts#global-model-http

| Member | Signature | Behavior |
| --- | --- | --- |
| `NestModelInterceptor` | `class NestModelInterceptor implements NestInterceptor` | Runs `fromWireFormat` with fail-fast checks on a whole `@Body()` or `@Query()` model before the handler. Converts a model-typed one-field `@Body('field')` or `@Query('field')` the same way. Throws a `TypeError` for a `@Body()` or `@Query()` parameter that has no model type. Writes a declared `IModel` or `IObject` return, a `Promise` of one or an array of one with `stringify`. |
| `nestModelStringifyInterceptor` | `(codec: ObjectCodec): NestInterceptor` | Writes every non-null result with that codec's `stringify`, an array item by item. |
| `objectCodecFromMetatype` | `<T>(metatype: unknown): ObjectCodec<T> \| undefined` | The codec of a parameter token that `nestModelCodec` placed, such as the `design:paramtypes` entry of a `@Body()` parameter. `undefined` for a raw class. |
| `nestModelConstruct` | `(metatype: unknown)` | The class that token constructs, or `undefined`. |
| `nestModelCodec` | `(id: string, array?: boolean): ParameterDecorator` | Inserted by the rewrite on `@Body()` and `@Query()` parameters typed with a model or an array of one (`array` is `true`). Replaces the parameter type with a token carrying the model's codec and class. |
| `nestModelReturn` | `(id: string, array?: boolean): MethodDecorator` | Inserted by the rewrite on a handler that returns a model. `NestModelInterceptor` reads it. |

- A `LibError` with `causedByInput: true` becomes HTTP 400 with `{ issues }`. Other errors, such as missing generated metadata or a throwing converter, stay HTTP 500.
- An array of models in `@Body()` or `@Body('field')` converts item by item; HTTP 400 answers an invalid item or a value that is not an array. Each issue path starts with the field name, if any, and the item index.
- A one-field `@Body('field')` or `@Query('field')` with a model type converts that field, and HTTP 400 answers a missing or invalid field. A one-field `@Query` model needs a nested query parser, for example Express `query parser` set to `extended`. A handler cannot take a whole and a one-field parameter of the same source. The interceptor throws a `TypeError`.
- A `@Body()` or `@Query()` parameter, whole or one field such as `@Body('name')`, that is not an `IModel` or `IObject` throws a `TypeError` that names the controller, the method and the parameter. Nest answers HTTP 500. For plain types, write your own interceptor.
- `@Param()` and `@Headers()` stay as Nest received them.
- Query strings are decoded to the schema's scalar and array types before `fromWireFormat` ([query objects](/guide/nestjs-in-depth#query-objects)).

For inbound conversion in your own interceptor or pipe, get the codec with `objectCodecFromMetatype` and call its `fromWireFormat`. The request and response contract is in [NestModelInterceptor](/guide/nestjs-in-depth#nestmodelinterceptor).

## `@exprtlabs/golem/rewrite` {#rewrite}

```ts
import { applyRewrites } from '@exprtlabs/golem/rewrite';
```

Every host scans each TypeScript file it compiles or loads with your project's own TypeScript, and edits the file's text before its types are stripped. The edits are:

| Call | Becomes |
| --- | --- |
| `stringify<T>(value)` | the generated `stringify` for `T` |
| `parse<T>(text)` | the generated `parse` for `T`, constructing your class when `T` is a class |
| `validate<T>(value)` | the generated `validate` for `T` |
| `assertValue<T>(value)` | the generated `assert` for `T` |
| `toWireFormat<T>(value)` | the generated `toWireFormat` for `T` |
| `fromWireFormat<T>(wire)` | the generated `fromWireFormat` for `T`, constructing your class when `T` is a class |

A host fails with the file, the line and what to run when `T` is not a single type name or `typeof` expression, or has no generated code. `golem check` reports the same sites. With a `controllers` job in `golem.yaml`, the rewrite also inserts [`nestModelCodec`](#nest) on `@Body()` and `@Query()` parameters and `nestModelReturn` on handlers that return a model. Nest also needs `experimentalDecorators` and `emitDecoratorMetadata` ([Set up TypeScript](/guide/nestjs#set-up-typescript)).

`golem build`, [`loader`](#loader), [`vite`](#vite) and [`esbuild`](#esbuild) use this subpath to apply their edits.

| Member | Signature | Behavior |
| --- | --- | --- |
| `applyRewrites` | `(text: string, rewrite: FileRewrite, file?: string): { code: string; map: SourceMapV3 }` | Applies the edits and the imports they need to the file's `text`, and returns the new `code` with its source `map`. Offsets are UTF-16 units of the text without a leading byte order mark, which the output keeps. The map has one source, named `''`; set `sources` on it when you know the file name. Throws an error that names `file` and the line when an edit is out of range, overlaps another edit, or no longer matches the text it expects. |
| `REWRITE_IMPORT_PREFIX` | `'__golem_'` | The prefix of the names that the rewrite imports. Each name is imported as `__golem_<name>`, so edit text cannot clash with an import of your file. |

Types: `FileRewrite` (`{ edits, imports }`), `RewriteEdit` (`{ start, end, expect, text }`) and `RewriteImport` (`{ from, names }`).

## `@exprtlabs/golem/loader` {#loader}

A Node `load` hook that rewrites TypeScript files as Node loads them. Install it through [`register`](#register); import `loader` only to call `module.register` yourself.

## `@exprtlabs/golem/register` {#register}

```sh
node --import @exprtlabs/golem/register src/main.ts
```

Every later import of the process goes through the loader. The loader needs a `golem.yaml`: it opens your project from the file that `GOLEM_CONFIG` names, else `./golem.yaml` in the working directory. With neither, a TypeScript file outside `node_modules` fails to load with a message that says so. It scans each file itself, so no `golem generate` run refreshes anything for it; run `golem generate` once so the generated files exist.

- Node before 22.18 needs `--experimental-strip-types` as well: Node strips the types after the loader rewrites the file. Node 22.18 and later, including Node 24, strip types by default.
- A call that cannot be rewritten fails the load with the file and the line.
- A workspace package symlinked into `node_modules` loads from its real path, and its calls are rewritten wherever that path lies, inside the directory of your tsconfig or outside it. With `preserveSymlinks` in TypeScript or in your bundler, the package keeps its `node_modules` path, so the host skips it, and the call fails at run time with `parse<T> was not rewritten`.
- Rewrites need ES modules. A `.cts` file, or a `.ts` file under a CommonJS `package.json`, that holds a call to rewrite fails with a message that names the file. Use `.mts`, `"type": "module"`, or `golem build`.
- `.tsx` is not supported: Node cannot strip it.
- Only `.ts`, `.mts` and `.cts` files are rewritten.
- A NestJS app needs a second loader. Node's type stripping rejects parameter decorators, so a loader that compiles decorators must run after golem's: register it later, as in `node --import @exprtlabs/golem/register --import ./decorators.mjs src/main.ts`. Its `load` hook calls `nextLoad` to get the file as golem rewrote it, then compiles the decorators.

## `@exprtlabs/golem/vite` {#vite}

```ts
import { golem } from '@exprtlabs/golem/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [golem()] });
```

The plugin rewrites TypeScript in memory before Vite strips its types, in the dev server and in builds.

| Option | Type | Behavior |
| --- | --- | --- |
| `config` | `string` | The `golem.yaml` to open, relative to Vite's `root`. Without it the plugin uses `GOLEM_CONFIG`, else `./golem.yaml` in `root`. |

- Put `golem()` before plugins that transform TypeScript. It runs first (`enforce: 'pre'`) and must see the file text as it is on disk.
- Without a `golem.yaml`, a TypeScript file outside `node_modules` fails the build. A call that cannot be rewritten fails with the file and the line; if its model has no generated code, run `golem generate`. An id with a query, such as `?raw`, passes through.
- Vite does not strip `.cts` files.
- The dev server watches the files each rewrite depends on, and a build adds them to its watch set. When one changes, or a generated model file of the project does, the plugin scans again and transforms only the modules whose rewrite came out different.
- A workspace package symlinked into `node_modules` follows the rule of the [loader](#register), including the `preserveSymlinks` limit.

## `@exprtlabs/golem/esbuild` {#esbuild}

```ts
import { golem } from '@exprtlabs/golem/esbuild';
import { build } from 'esbuild';

await build({ entryPoints: ['src/main.ts'], bundle: true, outfile: 'dist/main.js', plugins: [golem()] });
```

The plugin rewrites TypeScript in memory before esbuild strips its types and chains the source map into the bundle's.

| Option | Type | Behavior |
| --- | --- | --- |
| `config` | `string` | The `golem.yaml` to open, relative to `absWorkingDir` (default: the current directory). Without it the plugin uses `GOLEM_CONFIG`, else `./golem.yaml` in `absWorkingDir`. |

- Its `onLoad` takes every TypeScript file outside `node_modules`, so a plugin that needs those files must come before `golem()` in `plugins`. A file with no rewrite goes on to the plugins after it.
- Without a `golem.yaml`, a TypeScript file outside `node_modules` fails the build with an error located at the file. A call that cannot be rewritten does the same, with the line.
- The files a rewrite depends on are watched, so esbuild's watch mode builds again when one changes. A failed file watches the key tables that `golem generate` writes, so the build runs again when they appear.
- A workspace package symlinked into `node_modules` follows the rule of the [loader](#register), including the `preserveSymlinks` limit.

## `@exprtlabs/golem/generator-api` {#generator-api}

```ts
import type { GolemProvider, ModelContext } from '@exprtlabs/golem/generator-api';
```

The contracts, `resolveProfile` and `GolemDiagnosticSeverity` for tools that embed a generator are in the [generator API](/reference/generator-api).

Used by the generators: `discoverSources`, `compareText`, `isRecord`, `errorMessage`, `hasErrorCode`, `identifier`, `camelIdentifier`, `bindingName`, `propertyName`, `NameScope`, `assertPortableFilenames`, `assertUniquePublicExports`, `RESERVED_BINDING_NAMES`, `RESERVED_MODEL_MEMBERS`.

## `@exprtlabs/golem/manifest` {#manifest}

```ts
import { discoverModelManifests, readModelManifest } from '@exprtlabs/golem/manifest';
```

An OpenAPI job writes `model-manifest.json` beside its SDK; a model job reads it to use the SDK models in your declarations.

| Member | Signature | Behavior |
| --- | --- | --- |
| `discoverModelManifests` | `(root = process.cwd(), onInput?): string[]` | Sorted absolute paths of `model-manifest.json` files below `<root>/src`, skipping `dist` and `build`. |
| `readModelManifest` | `(filename: string, onInput?): ModelManifest` | Reads and checks one manifest. Throws with the file name when it is unreadable or invalid. |
| `validateModelManifest` | `(manifest: unknown, filename?): ModelManifest` | Checks a parsed manifest. |
| `ModelManifest` | `{ profile, models, validationSchemaClosure? }` | The generation profile, one `ModelManifestEntry` per model, and the schemas a project needs to validate those models. |
| `MODEL_MANIFEST_FILENAME` | `'model-manifest.json'` | The file name. |

Used by the generators: `ModelManifestEntry`, `ModelManifestProvenance`, `MODEL_MANIFEST_MARKER`, `manifestMarker`, `modelManifestProfile`, `validateModelProfile`, `stableJson`, `stableIdentity`, `sourceDigest`.

## `@exprtlabs/golem/ts` {#ts}

```ts
import { typescriptVersion, SyntaxKind } from '@exprtlabs/golem/ts';
```

The generators use this subpath for type analysis and generation. Application code doesn't import it, and it may change in any release. It publishes types that Golem owns, narrowed to what Golem uses: its declarations don't reference `typescript`, and it exports only the value names Golem uses, not the compiler's `API` class or TypeScript 7 client types.

Golem uses your project's installed `typescript`: the package that resolves from the directory of the tsconfig your `golem.yaml` names. The `golem` command and every host (the [Vite](#vite) and [esbuild](#esbuild) plugins and the [Node loader](#loader)) look there, wherever the process runs from. Set `GOLEM_TYPESCRIPT_ROOT` to a directory to use the `typescript` installed there instead; it overrides every project. Library use outside a host looks in `GOLEM_TYPESCRIPT_ROOT`, or from the current directory when the variable is unset. Every lookup falls back to the copy beside Golem. A process loads one TypeScript: when a host opens a second project whose `typescript` is a different install from the one the process holds, it fails and says to run one host per TypeScript install. Projects that share one install, through a link or a hoisted `node_modules`, can open in one process. It selects the backend by version: `>=6.0.0 <7` or `>=7.0.0 <8`. Any other version fails at load:

```text
golem supports TypeScript 6.0+ and 7.x; found <version> at <path>.
```

Golem runs the TypeScript 6 backend on the install it resolved. The TypeScript 7 backend loads the TypeScript 7 beside Golem, so the project and Golem must resolve one install. When they differ, loading fails:

```text
golem loads TypeScript 7 (<version>) from <path> but the project uses <version> at <path>; install one TypeScript 7 for both.
```

When neither the project nor Golem has `typescript`, loading fails with `golem needs TypeScript 6.0+ or 7.x installed in <directory>.`

Both backends generate byte-identical files. A test lane enforces that.
