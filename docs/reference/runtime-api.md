# Runtime API

Find every `@exprtlabs/golem` import your application, NestJS app or tool can use, with its signature and behavior.

| Subpath | Use | Extra dependency |
| --- | --- | --- |
| [`model`](#model) | `IModel`, `IObject`, generated-model types and guards | none |
| [`validation`](#validation) | `validate<T>`, `validateInstance`, `getValidator`, `ModelValidator` | none |
| [`ajv`](#ajv) | Runtime Ajv validation engines | `ajv`, `ajv-formats` |
| [`mobx`](#mobx) | `asGenObservable` and observable API operations | `mobx` |
| [`mobx-validation`](#mobx-validation) | Observable validator state | `mobx` |
| [`errors`](#errors) | `LibError`, `LibErrorKind` and the `Issue` type | none |
| [`client`](#client) | `ApiOperation` and `createApiOperation` | none |
| [`conversion`](#conversion) | Encode and decode a generated model | none |
| [`tags`](#tags) | Type-only validation constraints, `TValidation`, `TSerde` | none |
| [`temporal`](#temporal) | Temporal field types and their codecs | a `Temporal` global, such as `temporal-polyfill` |
| [`serde`](#serde) | `parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` | none |
| [`nest`](#nest) | `NestModelInterceptor` and the decorators the plugin inserts | `@nestjs/common`, `rxjs` |
| [`ttsc-plugin`](#ttsc-plugin) | The compile-time transform for the generic calls | `typescript` 7 (`~7.0.2`), `ttsc` 0.30 |
| [`generator-api`](#generator-api) | Contracts shared by the generators | none |
| [`manifest`](#manifest) | Read and find `model-manifest.json` files | none |

Internal subpaths used by the generators: `cli`, `emitter`, `schema`, `schema-graph`, `ajv-tooling`, `type-analysis`, `generated-paths`, `rewrite`, `loader`, `register`, `vite`, `esbuild`, [`ts`](#ts). Don't import them; they may change in any release.

Generated files import `ajv` only with `validation: true` and `ajvStandalone: false`. With `ajvStandalone: true` they import precompiled validators instead ([validation profiles](/reference/config#validation-profiles)).

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
| `ModelValidationContext` | `{ resolve?, engine? }` | Validator source for one call ([validation context](#validation-context)). |
| `isGeneratedModel` | `(value: unknown): value is GeneratedModel<unknown>` | Recognizes a generated instance, including instances of your class. |
| `isGeneratedModelConstructor` | `(value: unknown): value is GeneratedModelConstructor` | Recognizes a generated class or your class that extends it. |

| `IModelOptions` key | Default | Effect |
| --- | --- | --- |
| `exact` | `true` | `false` admits keys the declaration does not list. |
| `allowAny` | root `allowAny`, `false` | Permits `any` fields in this declaration; `false` tightens a root `true`. |
| `validation` | root `validation`, `true` | Generates checks for this named `IObject` or `IModel`. A nested declaration uses its own setting. |

`allowAny` does not change `unknown`, remove validation constraints or skip JSON checks.

Generation writes `task.model.generated.ts` with `TTaskBaseModel`, `TTaskFields` (field types), `TTaskJSON` (JSON shape) and `TTaskInit` (constructor values). The `TTaskBaseModel` constructor copies the values it receives and does not validate, so an incomplete draft is valid state.

Used by generated code: `registerGeneratedModel`, `findGeneratedModelDefinition`, `findGeneratedModelDefinitionForConstructor`, `GeneratedModel`, `GeneratedModelWire`, `GeneratedModelFields`, `GeneratedModelConstructor`, `GeneratedModelResult`, `GeneratedModelDefinition`, `RegisteredGeneratedModelDefinition`, `GeneratedModelConversion`, `GeneratedModelProfile`, `GeneratedModelValidation`, `GeneratedModelValidatorEnhancer`, `OpenApiGeneratedModelValidation`, `ModelRuntimeValidator`, `ModelRuntimeSyncValidator`, `ModelRuntimeValidationEngine`, `ModelConstraint`, `ModelTypeMetadata`, `ModelTypeDescriptor`, `UnionDiscriminator`, `DiscriminatorValue`, `ConstraintSchemaValue` and the `generatedModel*Brand` symbols.

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
| `validate` | `<T>(value: unknown, options?: ValidateOptions): value is T` | Checks a value against a named `IObject` or `IModel` and narrows it. Needs the [`ttsc-plugin`](#ttsc-plugin). |
| `ModelValidator` | `class ModelValidator<Fields, Owner = Fields>` | The stateful validator; members below. |

`validateInstance`, `validate` and `ModelValidator.validate` stop at the first issue unless you pass `{ failFast: false }`. An invalid value is an ordinary result. They throw `LibError` when validation can't run: the model was generated with `validation: false` (`ValidationUnavailable`), generated metadata is missing, or a converter or engine throws.

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
| `extend` | `(rules: ModelValidationRules<Fields, Owner>): this` | Adds rules for this instance. A rule returns `true`, a message, or a promise of either. |
| `messages` | `(messages: ValidationMessages<Fields>): this` | Replaces generated messages by code (`'minLength'`) or field and code (`'title.minLength'`). |
| `setErrors` | `(errors): void` | Stores messages from outside, such as a server response, as `external` issues. Takes a field map or `{ path, message }[]`. |
| `clear` | `(): void` | Removes stored issues and resets `pending`. |
| `setIssues` | `(issues: readonly Issue[]): void` | Replaces the stored issues. |
| `setPending` | `(pending: boolean): void` | Sets `pending`. |
| `formatIssue` | `(issue: Issue, explicit: boolean): Issue` | Applies `messages()` overrides unless `explicit`. Used by nested validation. |

Types for these members: `ModelValidationRules`, `ValidationRule`, `ValidationRuleResult`, `ValidationMessages`, `ValidationMessage`, `ValidationMessageKey`, `FieldValidationMessage`, `ExternalFieldError`, `ValidationMode`, `Issue` and `IssuePath`.

### Validation engine {#validation-engine}

```ts
function configureModelValidationEngine(registry: object, registryId: string, engine: ModelRuntimeValidationEngine): void;
function registerModelValidationEngineFactory(factory: () => ModelRuntimeValidationEngine): void;
```

`configureModelValidationEngine` adds the registry schema to `engine` if missing and uses that engine for models of that registry. `registerModelValidationEngineFactory` sets the engine created for a registry on its first validation; importing [`ajv`](#ajv) registers one. Register a factory during startup: a registry keeps the engine it already created.

Used by generated code: `runValidation`, `issuesFromErrors`, `getModelRuntimeValidator`, and in operation modules `operationValidators` (resolves an operation's input and response validators once per client), `validateOperationInput` and `responseCheck` (the response check `ClientRuntime.readResponse` runs on each decoded body or stream item).

### Runtime validators {#runtime-validators}

```ts
function validateWith(validator: RuntimeValidator, value: unknown): Promise<ValidationResult>;
```

`validateWith` runs one validator and returns `{ valid, errors }`.

Types: `RuntimeValidator`, `RuntimeValidationEngine`, `OperationRuntimeValidators` and `ValidationResult`. `RuntimeValidationEngine` is the two-method adapter that [`ajv`](#ajv) implements: `addSchema(schema, id)` and `getSchema(reference)`. `OperationRuntimeValidators` is the value type of a client's `operationValidators` option: the input validator and the response validators keyed `status:contentType`.

## `@exprtlabs/golem/ajv` {#ajv}

```ts
import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';
import { TasksClient } from '../sdk/index.js';

const client = new TasksClient({
  baseUrl: 'https://api.example.com',
  validationEngine: createOpenApiAjvEngine({ allErrors: false }),
});
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `createOpenApiAjvEngine` | `(options?: OpenApiAjvOptions): OpenApiRuntimeValidationEngine` | Ajv 2020-12 with `ajv-formats`. Accepts asynchronous schemas. |
| `createOpenApiSyncAjvEngine` | `(options?: OpenApiAjvOptions): OpenApiSyncRuntimeValidationEngine` | The same engine for synchronous calls. Resolving an `$async` schema throws `ValidationUnavailable`. Generated model files use it. |
| `configureModelValidationEngine` | re-export | [Validation engine](#validation-engine). |
| `OpenApiAjvOptions` | Ajv `Options` plus `validationBindings` | Your options override the defaults `allErrors: true`, `strict: false`, `validateSchema: false`, `discriminator: true`. `validationBindings` holds the `TValidation` predicates generated code passes. |

Importing the module registers `createOpenApiAjvEngine()` as the default model engine. A generated SDK creates one shared engine on first use. An engine passed to a client applies to that client's checks only; it does not change the generation profile or the model engine. With `ajvStandalone: true` the SDK uses its precompiled engine.

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

Models generated with `mobx: true` and `validation: true` register `enhanceValidatorWithMobX`, so `getValidator` from `validation` already returns an observable validator for them. The module also re-exports `configureModelValidationEngine`, `registerModelValidationEngineFactory` and the validation types.

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
| `Serialization` | `serialization` | A value can't be written as JSON, such as an invalid `Date`. |
| `Deserialization` | `deserialization` | JSON can't be decoded, such as an unparsable date. |
| `InvalidJson` | `invalid_json` | `parse` receives text that is not JSON. |
| `ValidationUnavailable` | `validation_unavailable` | Checks were not generated, the ttsc plugin did not rewrite a call, or a validation context lacks a validator. |
| `Response` | `response` | A generated client receives a status or media type the operation does not declare. |

`ModelValidator.validate()` returns `false` for an invalid value. Checked serde calls and generated client checks throw `LibError` instead. A predicate, codec or native call that throws is wrapped once with its `cause`; a thrown `LibError` passes through unchanged. Network failures reject with the `fetch` error.

| `Issue` field | Type | Meaning |
| --- | --- | --- |
| `code` | `IssueCode` | The failed check. |
| `message` | `string` | Display text. |
| `path` | `IssuePath` | String and number segments, such as `['items', 0, 'amount']`. |
| `source` | `IssueSource` | `typescript`, `openapi`, `custom`, `external`, `json` or `serde`. |
| `representation` | `IssueRepresentation` | Optional: `model` or `wire` (JSON) value. |
| `params` | `Readonly<Record<string, JsonValue>>` | Optional JSON details. |

`IssueCode` values are JSON Schema keyword names, such as `minLength` and `required`, plus `invalid`, `custom`, `external`, `invalid_json`, `serialization`, `deserialization` and `validation_unavailable`.

Used by generated code: `mapValidationCode`, `snapshotIssues`.

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
| `ClientRuntime` | Holds a client's options and sends its requests. `new ClientRuntime(client, options, defaults)`. `readResponse` selects the declared response, decodes it and runs the operation's response check. |
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

The module also exports the types these functions use, including `ClientOptions`, `RequestOptions`, `ClientRuntimeDefaults`, `ParameterSerializer`, `EncodedBody`, `BodyEncoder`, `MutualTlsTransport`, `ResponseHeaderDecoder`, `StreamDecoder`, `ResponseDecoder`, `UndeclaredResponseError`, `AuthContext`, `TokenAuthValue`, `BasicCredentials`, `BasicAuthValue` and `RuntimeSecuritySchemes`. Each SDK aliases the option types with its client name, such as `PaymentsClientOptions`.

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

Used by generated code: `decodeGeneratedModelTrusted`, `deserializeDate`, `serializeDate`, `convertModelField`, `defineModelProperty`, `requireModelObject`, `assertAcyclicValue`, `assertPropertyAcyclic`, `assertWireAcyclic`, `beginDecode`, `endDecode`, `decodeDetachedInput`, `decodeCheckedInput`, `unknownDiscriminatorValue`, `withDiscriminatorValue`, `jsonWithDiscriminator`.

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

The `TSerde` deserializer's parameter type sets the JSON schema of the field ([which type controls validation](/guide/tags#which-type-controls-validation)).

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

::: warning TypeScript 7 and ttsc
`parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` and `validate<T>` throw `ValidationUnavailable` unless the [`ttsc-plugin`](#ttsc-plugin) rewrites them. Compile with TypeScript 7 and `ttsc` 0.30; `tsc` does not run the plugin.
:::

`T` names a generated `IObject` or `IModel`. A type alias returns a plain object; your class returns an instance of it.

| Member | Signature | Behavior |
| --- | --- | --- |
| `parse` | `<T>(text: string, options?: SerdeOptions): T` | JSON text to a value. Checks the JSON, runs `TSerde` decoders, checks the result. |
| `stringify` | `<T>(value: T, options?: SerdeOptions): string` | Value to JSON text of the declared fields, with `TSerde` applied and both sides checked. |
| `fromWireFormat` | `<T>(wire: unknown, options?: SerdeOptions): T` | `parse` for a plain object instead of text. |
| `toWireFormat` | `<T>(value: T, options?: SerdeOptions): WireFormat<T>` | `stringify` that returns the plain object, such as `TTaskJSON`. |
| `assertValue` | `<T>(value: unknown, options?: ValidateOptions): T` | Checks the value and returns it unchanged, typed as `T`. Throws `LibError` `Validation` with the issues. |

| Option | In | Default | Effect |
| --- | --- | --- | --- |
| `validate` | `SerdeOptions` | `true` when generated | `false` skips the checks. `true` throws `ValidationUnavailable` if checks were not generated. |
| `failFast` | both | `true` | `false` reports every issue. It does not skip checks. |
| `validationContext` | both | none | Resolves validators from your engine ([validation context](#validation-context)). |

`ValidateOptions` has `failFast` and `validationContext`. The plugin also passes `construct` in `SerdeOptions` for a class `T`. The call order and checks per call are in [Validation during conversion](/guide/serialization#validation-during-conversion).

- `JSON.stringify(model)` does not convert or validate.
- A `Date` field decodes with ECMAScript `Date` parsing; a non-string or unparsable value throws `Deserialization` with `causedByInput: true`. Put format rules on `Format<'date-time'>` or `TValidation`.
- A `Date` encodes as UTC ISO text with milliseconds; years outside 0000–9999 throw `Serialization`.
- Conversion rejects non-finite numbers, `bigint`, functions, symbols, cycles, array holes and non-plain objects, except in a field whose [`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value) codec converts the value.

### Validation context {#validation-context}

Pass one `ModelValidationContext` to repeated serde, `validateInstance` and `ModelValidator.validate` calls to reuse resolved validators.

| Field | Behavior |
| --- | --- |
| `resolve(reference, mode)` | Returns the validator for a schema reference and `'first'` or `'all'` mode. Takes precedence over `engine`. |
| `engine` | A `ModelRuntimeValidationEngine` holding the schemas. Its own options decide how many errors it reports. |

| Reference | Checks | Used by |
| --- | --- | --- |
| `Id` | the model value | `validate`, `validateInstance`, and `stringify` / `toWireFormat` before encoding |
| `Id#wire` | the JSON value | `parse` / `fromWireFormat` before decoding |
| `Id#model-only` | converted fields and `TValidation` rules on the model value | `parse` / `fromWireFormat` after decoding |
| `Id#wire-only` | the JSON written for converted fields | `stringify` / `toWireFormat` after encoding |

- `registerCodecSchemas(addSchema, codec)` adds every schema of a codec and the codecs it references, each once.
- `objectCodecValidationReference(codec, plane)` returns the reference for one `ValidationPlane`.
- A context is authoritative: a missing validator throws `ValidationUnavailable` instead of using another engine.
- Resolved validators are cached per context object, reference and mode. Create a new context when schemas change.
- Synchronous serde calls reject a validator that returns a promise; `validateInstance` and `ModelValidator.validate` await it.

Types: `ObjectCodec`, `ObjectCodecImpl`, `SerdeOptions`, `ValidateOptions`, `ValidationPlane`, `WireFormat`; `IssueRepresentation` and `IssueSource` are re-exported from [`errors`](#errors).

Used by generated code: `createObjectCodec`, `registerObjectCodec`, `getObjectCodec`, `requireObjectCodec`, `registerIModelClass`, `getIModelClass`, `requireIModelClass`, `findCodecIdForConstructor`, `addNestedCodecSchema`, `resolveGeneratedModelSchemaRefs`, `resolveModelValidationContextValidator`, `runSynchronousValidation`, `lazyAjvSchema`, `requireAjvSchema`, `ajvIssues`, `ajvIssuesFromErrors`, `parseJson`, `serdeValidates`, `serdeFailFast`, `validationFailure`, `validationUnavailable` and the `stringifyJson*` writers.

## `@exprtlabs/golem/nest` {#nest}

```ts
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
```

<<< ../../examples/payments/server/src/application.ts#global-model-http

| Member | Signature | Behavior |
| --- | --- | --- |
| `NestModelInterceptor` | `class NestModelInterceptor implements NestInterceptor` | Runs `fromWireFormat` with fail-fast checks on a whole `@Body()` or `@Query()` model before the handler. Writes a declared `IModel` or `IObject` return, a `Promise` of one or an array of one with `stringify`. |
| `nestModelStringifyInterceptor` | `(codec: ObjectCodec): NestInterceptor` | Writes every non-null result with that codec's `stringify`, an array item by item. |
| `objectCodecFromMetatype` | `<T>(metatype: unknown): ObjectCodec<T> \| undefined` | The codec of a parameter token that `nestModelCodec` placed, such as the `design:paramtypes` entry of a `@Body()` parameter. `undefined` for a raw class. |
| `nestModelConstruct` | `(metatype: unknown)` | The class that token constructs, or `undefined`. |
| `nestModelCodec` | `(id: string): ParameterDecorator` | Inserted by the plugin on `@Body()` and `@Query()` parameters typed with a model. Replaces the parameter type with a token carrying the model's codec and class. |
| `nestModelReturn` | `(id: string, array?: boolean): MethodDecorator` | Inserted by the plugin on a handler that returns a model. `NestModelInterceptor` reads it. |

- A `LibError` with `causedByInput: true` becomes HTTP 400 with `{ issues }`. Other errors, such as missing generated metadata or a throwing converter, stay HTTP 500.
- `@Param()`, `@Body('field')` and `@Query('field')` stay as Nest received them.
- Query strings are decoded to the schema's scalar and array types before `fromWireFormat` ([query objects](/guide/nestjs-in-depth#query-objects)).

For inbound conversion in your own interceptor or pipe, get the codec with `objectCodecFromMetatype` and call its `fromWireFormat`. The request and response contract is in [NestModelInterceptor](/guide/nestjs-in-depth#nestmodelinterceptor).

## `@exprtlabs/golem/ttsc-plugin` {#ttsc-plugin}

```json
{
  "compilerOptions": {
    "plugins": [{ "transform": "@exprtlabs/golem/ttsc-plugin" }]
  }
}
```

The subpath is a CommonJS plugin descriptor (`ttsc-plugin.cjs`) that `ttsc` loads while compiling; application code does not import it. Install `typescript@~7.0.2` and `ttsc@~0.30.4` ([TypeScript setup](/guide/install#typescript-setup)).

| Call | Becomes |
| --- | --- |
| `stringify<T>(value)` | the generated `stringify` for `T` |
| `parse<T>(text)` | the generated `parse` for `T`, constructing your class when `T` is a class |
| `validate<T>(value)` | the generated `validate` for `T` |
| `assertValue<T>(value)` | the generated `assert` for `T` |
| `toWireFormat<T>(value)` | the generated `toWireFormat` for `T` |
| `fromWireFormat<T>(wire)` | the generated `fromWireFormat` for `T`, constructing your class when `T` is a class |

The build fails when `T` is not a single type name or `typeof` expression, or has no generated code.

Add `"nest": true` to the same entry in a NestJS app. The plugin then inserts [`nestModelCodec`](#nest) on `@Body()` and `@Query()` parameters and `nestModelReturn` on handlers that return a model. Listing `@exprtlabs/golem-ts-openapi/ttsc-plugin` has the same effect. Nest also needs `experimentalDecorators` and `emitDecoratorMetadata` ([Set up TypeScript](/guide/nestjs#set-up-typescript)).

Add `"serde": false` to an entry to leave the calls in the table unchanged; they then throw `ValidationUnavailable`. If you list both plugin entries, add it to each.

## `@exprtlabs/golem/generator-api` {#generator-api}

```ts
import type { GolemProvider, ModelContext } from '@exprtlabs/golem/generator-api';
```

The contracts, `resolveProfile` and `GolemDiagnosticSeverity` for tools that embed a generator are in the [generator API](/reference/generator-api).

Used by the generators: `discoverSources`, `isRecord`, `errorMessage`, `hasErrorCode`, `identifier`, `camelIdentifier`, `bindingName`, `propertyName`, `NameScope`, `assertPortableFilenames`, `assertUniquePublicExports`, `RESERVED_BINDING_NAMES`, `RESERVED_MODEL_MEMBERS`.

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
| `ModelManifest` | `{ profile, models, validationSchemaClosure? }` | The generation profile, one `ModelManifestEntry` per model, and schemas for `ajvStandalone` builds. |
| `MODEL_MANIFEST_FILENAME` | `'model-manifest.json'` | The file name. |

Used by the generators: `ModelManifestEntry`, `ModelManifestProvenance`, `MODEL_MANIFEST_MARKER`, `manifestMarker`, `modelManifestProfile`, `validateModelProfile`, `stableJson`, `stableIdentity`, `sourceDigest`.

## `@exprtlabs/golem/ts` {#ts}

```ts
import { typescriptVersion, SyntaxKind } from '@exprtlabs/golem/ts';
```

The generators use this subpath for type analysis and generation. Application code doesn't import it, and it may change in any release. It publishes types that Golem owns, narrowed to what Golem uses: its declarations don't reference `typescript`, and it exports only the value names Golem uses, not the compiler's `API` class or TypeScript 7 client types.

Golem uses your project's installed `typescript`. It looks for the package in the directory in `GOLEM_TYPESCRIPT_ROOT`, or from the current directory when the variable is unset, and falls back to the copy beside Golem. It selects the backend by version: `>=6.0.0 <7` or `>=7.0.0 <8`. Any other version fails at load:

```text
golem supports TypeScript 6.0+ and 7.x; found <version> at <path>.
```

Golem runs the TypeScript 6 backend on the install it resolved. The TypeScript 7 backend loads the TypeScript 7 beside Golem, so the project and Golem must resolve one install. When they differ, loading fails:

```text
golem loads TypeScript 7 (<version>) from <path> but the project uses <version> at <path>; install one TypeScript 7 for both.
```

When neither the project nor Golem has `typescript`, loading fails with `golem needs TypeScript 6.0+ or 7.x installed in <directory>.`

Both backends generate byte-identical files. A test lane enforces that.
