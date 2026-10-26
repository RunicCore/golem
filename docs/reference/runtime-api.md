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

Types of generated models:

| Type | Describes |
| --- | --- |
| `GeneratedModelFields<Model>` | The field types of a generated model. |
| `GeneratedModelResult<Constructor>` | The instance type of a generated class. |

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

- `ModelValidator.validate()` returns `false` for an invalid value. Checked serde calls and generated client checks throw `LibError` instead.
- A `TSerde` function that throws is wrapped once with its `cause`.
- A [`TValidation`](#tvalidation) predicate that throws is wrapped only by `validateInstance` and `ModelValidator.validate`. In `parse`, `fromWireFormat` and `validate<T>` its error reaches you unchanged.
- A thrown `LibError` passes through unchanged.

[Errors and issues](/guide/validation#errors-and-issues) shows how to read them.

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

### Generated client {#generated-client}

```ts
new <Client>Client(options: <Client>ClientOptions)
client.<operation>().execute(input, options?: <Client>RequestOptions): Promise<HttpResponse>
```

`<Client>` is the client name in `golem.yaml`. Each operation method returns an [`ApiOperation`](#client).

| Option | Present when the API has | Value |
| --- | --- | --- |
| `baseUrl` | always | The API address. It wins over `server`. Required when the document lists no `servers`. |
| `server` | `servers` in the document | A number is the index of a server. A string is its `name` or `description`; a `name` wins. The default is the first server. |
| `serverVariables` | `servers` in the document | A record of values for the `{variables}` in the URL of the chosen server. |
| `fetchImpl` | always | A `fetch` function. The default is the global `fetch`. |
| `headers` | always | `HeadersInit` that the client adds to every request. |
| `auth` | a security scheme that is not mutual TLS | Credentials by scheme name, or functions that return them ([Client authentication](#client-authentication)). |
| `mutualTls` | a mutual TLS security scheme | `{ fetchImpl }`, a transport that you configure with the certificate ([Mutual TLS](/guide/auth#mutual-tls)). |
| `bodyEncoders` | a request body | Request codecs by media type ([Codec options](/guide/codecs#codec-options)). |
| `responseDecoders` | response content | Response codecs by media type ([Codec options](/guide/codecs#codec-options)). |
| `parameterSerializers` | a parameter that uses `content`, or a `querystring` parameter | Parameter writers by media type. |
| `responseHeaderDecoders` | a response header that declares `content` | Header decoders by media type. |
| `streamDecoders` | a response that declares `itemSchema` | Framing decoders for streams other than NDJSON, JSON-seq and SSE ([Connect a custom stream decoder](/guide/streams#connect-a-custom-stream-decoder)). |
| `operationValidators` | `validation` turned on | A map of operation name to validators. Each entry replaces the generated validators of that operation ([Runtime validators](#runtime-validators)). |

| Request option | Value |
| --- | --- |
| `signal` | An `AbortSignal` that cancels the request. |

- The client type has the first three options always. It adds each other option only when the API needs it. A key that the type does not have is a type error.
- `baseUrl` loses its surrounding spaces and one trailing `/`. An empty value throws `Error` with the message `<Client>Client requires a non-empty baseUrl` when you create the client.
- A server URL is used as the document writes it, after the variables are filled. A variable that `serverVariables` leaves out uses its `default`. A value that is not in the `enum` of the variable, a variable that the server does not declare, or a `server` that the document does not list, throws `Error` when you create the client. A relative server URL such as `/api` is used as written, so it works where `fetch` accepts a relative URL, such as a browser. The client reads the `servers` of the document root.
- `mutualTls.fetchImpl` replaces `fetchImpl` for every request of the client, also for operations without a mutual TLS requirement.
- A codec map that you leave out is empty. A codec that you pass replaces the built-in one.
- Each `execute` call resolves with the response that the operation declares, as in the table below. A declared error status resolves too ([Read responses and handle failures](/guide/client-usage#read-responses-and-handle-failures)).

| `execute` result | Value |
| --- | --- |
| `matched` | `status` for an exact status code, `range` for a range such as `2XX`, `default` for the `default` response. |
| `status` | The HTTP status of the reply. |
| `contentType` | The declared media type that matched the reply, or `null` when the response declares no content. |
| `body` | The decoded body. A response that declares no content has no body. A stream response has an `AsyncIterable` ([Streaming responses](/guide/streams)). |
| `headers` | The declared response headers that the reply holds, decoded. |

- A stream body is lazy. With validation on, each item is checked when your loop reads it. A failed item throws from `for await`, not from `execute`.
- Selection follows [Response matching](/reference/openapi-support#response-matching).

| Failure | Result |
| --- | --- |
| A request input or a response breaks its schema | `LibError` of kind `Validation` with the message `API data validation failed.` The issues have source `openapi` and representation `wire`. `causedByInput` is `true`. The error does not hold the response body. |
| A validator crashes | `LibError` of kind `Validation` with `cause`, no issues and `causedByInput` `false`. |
| The generated validator of the request input is missing | `LibError` of kind `ValidationUnavailable`. |
| The reply has a status or media type that the operation does not declare | `LibError` of kind `Response` with `causedByInput` `true` and no issues. It also has `client`, `operation`, `status`, `headers` and `contentType` (the media type in lower case, without parameters). The message is `Undeclared OpenAPI response for <operation>: HTTP <status> <type>`. The runtime cancels the body. |
| The body is not valid JSON | `SyntaxError`, not a `LibError`. |
| No codec or decoder exists for the body, or the operation requires a custom codec you did not pass | A plain `Error` that names the media type or the missing option. |
| No security requirement has all its credentials | A plain `Error` whose message starts with `No configured credentials satisfy`. It rejects before `fetch` runs ([Client authentication](#client-authentication)). |
| The network fails | The rejection of `fetchImpl`, unchanged. |

- Test an undeclared response with the generated guard `is<Client>UndeclaredResponseError(error)`. It calls `isUndeclaredResponseError(error, client)`. Without `client`, that function accepts the error of any client.
- With validation off, the client checks no request or response. With it on, a response that declares no content has no body to check.

[Create a client](/guide/client-usage#create-a-client) shows the options in use. [Read responses and handle failures](/guide/client-usage#read-responses-and-handle-failures) and [Handle errors](/guide/client-usage#handle-errors) show how to read the result and the errors.

### Client authentication {#client-authentication}

```ts
auth?: <Client>Auth;
mutualTls?: { readonly fetchImpl: typeof fetch };
```

`<Client>Auth` has one optional key for each declared security scheme except mutual TLS. Each value is a `TokenAuthValue` or a `BasicAuthValue`. The client has `auth` when an operation requires a scheme that is not mutual TLS. It has `mutualTls` when an operation requires a mutual TLS scheme. [Authentication](/guide/auth) shows the usage.

| Type | Shape | Meaning |
| --- | --- | --- |
| `AuthContext` | `{ scheme, type, scopes, flows?, openIdConnectUrl? }` | The argument of an auth function. `scheme` is the scheme name, `type` its OpenAPI type and `scopes` the scopes of the requirement. `flows` is set for OAuth2. `openIdConnectUrl` is set for OpenID Connect. |
| `TokenAuthValue<Context = AuthContext>` | `string \| (context: Context) => string \| Promise<string>` | A token or an API key, or a function that returns one. |
| `BasicCredentials` | `{ username: string; password: string }` | The credentials of an HTTP Basic scheme. |
| `BasicAuthValue<Context = AuthContext>` | `BasicCredentials \| (context: Context) => BasicCredentials \| Promise<BasicCredentials>` | The credentials, or a function that returns them. |
| `MutualTlsTransport` | `{ readonly fetchImpl: typeof fetch }` | The value of `mutualTls`. |
| `RuntimeSecuritySchemes` | `Readonly<Record<string, RuntimeSecurityScheme>>` | The scheme metadata that a generated client gives to the runtime. You do not build it. |

Each SDK declares these types again with the client name, such as `<Client>Auth`, the type of the `auth` option. It also declares a context type for each scheme with narrowed fields.

| OpenAPI scheme | Auth value | What the client sends |
| --- | --- | --- |
| `apiKey` in `header` | `TokenAuthValue` | A header named by the scheme's `name`. The scheme key is the name when `name` is missing. |
| `apiKey` in `query` | `TokenAuthValue` | A query parameter with that name. |
| `apiKey` in `cookie` | `TokenAuthValue` | A cookie with that name. The value is percent-encoded. |
| `http` with `bearer` | `TokenAuthValue` | `Authorization: Bearer <token>`. |
| `http` with `basic` | `BasicAuthValue` | `Authorization: Basic <credentials>`, Base64 of `username:password` in UTF-8. |
| `oauth2` | `TokenAuthValue` | `Authorization: Bearer <access token>`. The context has `scopes` and `flows`. |
| `openIdConnect` | `TokenAuthValue` | `Authorization: Bearer <access token>`. The context has `openIdConnectUrl`. |
| `mutualTLS` | none: use `mutualTls` | No credential. The requirement holds when `mutualTls` is set. |

- A value is a string, a credentials object or a function. The client calls a function with an `AuthContext` on each `execute` and awaits it.
- An operation can list several security requirements. The client uses the first requirement for which every scheme has a value. It applies all schemes of that requirement together.
- A scheme with no key in `auth` has no value.
- An empty requirement allows a request without credentials. The client uses it only after every other requirement fails.
- Security on an operation replaces the security of the document. `security: []` on an operation asks for no credentials.
- The client resolves credentials before it calls `fetch`. A failure rejects `execute` and sends no request.

| Failure | Result |
| --- | --- |
| No requirement has all its credentials | A plain `Error` with the message `No configured credentials satisfy the operation security requirements`. |
| An auth function returns a value that is not a string or a credentials object | `TypeError` with the message `Authentication provider for <scheme> returned an invalid value`. A function that returns `undefined` counts as no value. |
| An auth function throws | `execute` rejects with that error, unchanged. |
| A Basic username contains `:` | `TypeError`. |
| An `http` scheme is not `basic` or `bearer` | A plain `Error` with the message `Unsupported HTTP authentication scheme: <scheme>`. |

[Authentication](/guide/auth) shows how to pass credentials, read a token for each request and use mutual TLS.

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

Every export is a type. Intersect a tag with a field type. Assignment is unchanged and generation never runs your code. A tag that is not intersected with a value type is an error ([RUNM1045](/reference/diagnostics#runm1045)).

| Member | Signature | Behavior |
| --- | --- | --- |
| Built-in constraints | `Integer`, `Minimum<N>`, `MinLength<N>`, `Pattern<S>`, `Format<S>`, … | JSON Schema keywords ([built-in tags](#built-in-tags)). |
| Short names | `Min`, `Max`, `ExclusiveMin`, `ExclusiveMax`, `MinProps`, `MaxProps` | Aliases of `Minimum`, `Maximum`, `ExclusiveMinimum`, `ExclusiveMaximum`, `MinProperties`, `MaxProperties`. |
| `TValidation` | `TValidation<typeof predicate>` | Runs an exported synchronous function that returns `true`, `false` or an error message ([`TValidation`](#tvalidation)). |
| `TSerde` | `TSerde<typeof serialize, typeof deserialize>` | Converts the field between model value and JSON value ([`TSerde`](#tserde)). |
| `TSerdeWire` | `TSerdeWire<Value>` | `[Wire]`, the deserializer's input type, or `[]` without `TSerde`. |
| `BuiltinModelTag` | union type | Every built-in constraint. |
| `ModelValidationFunction` | `(value: unknown) => boolean \| string` | The shape that `TValidation` accepts. |
| `ModelSerializeFunction`, `ModelDeserializeFunction` | `(value: unknown) => unknown` | The shapes that `TSerde` accepts. |

### `TSerde` {#tserde}

```ts
type TSerde<
  Serialize extends (...args: never[]) => unknown,
  Deserialize extends (...args: never[]) => unknown,
>;
```

| Part | Names | Rule |
| --- | --- | --- |
| `Serialize` | `typeof` an exported function from the model value to the JSON value | Its parameter accepts the model type of the field. Its return type is assignable to the parameter type of `Deserialize`. |
| `Deserialize` | `typeof` an exported function from the JSON value to the model value | Its parameter type is the JSON type of the field. Its return type is assignable to the model type of the field. |

- Each function has one call signature and one required parameter. It is synchronous: a function that returns a thenable is an error.
- Declare each function in its own module and export it. A function in a `*.model.ts` file stops generation ([RUNM1065](/reference/diagnostics#runm1065)).
- A function from an installed package needs a package `exports` entry that reaches its file ([RUNM1060](/reference/diagnostics#runm1060)).
- In a type alias, write `typeof` an exported function. A type parameter is an error ([RUNM1061](/reference/diagnostics#runm1061)).
- A field has one `TSerde` pair. Two different pairs on one field stop generation.
- The deserializer parameter type sets the JSON schema of the field. A tag on that type checks the JSON value. A plain `string` parameter drops the tags of an alias such as `string & MinLength<3>`.
- Tags on the field type check the model value, after decoding and before encoding. Tags on the return type of `Serialize` add no JSON check.
- A parameter of type `any` or `unknown` is an error unless `allowAny` is `true` ([RUNM1011](/reference/diagnostics#runm1011)).
- The JSON value is checked before decoding and after encoding. `{ validate: false }` skips the checks and keeps the functions.
- `Serialize` returns JSON-compatible data. A non-finite number or a cycle throws `Serialization`, also with `validate: false`.
- A field can hold a class instance or a `bigint`. The class needs a name and an export, and no type parameter without a default ([RUNM1063](/reference/diagnostics#runm1063)).
- The [Temporal](#temporal) tags are `TSerde` tags with their own functions.

| Failure | Where | Result |
| --- | --- | --- |
| A function throws | `parse`, `stringify`, `fromWireFormat`, `toWireFormat` | `LibError` of kind `Serialization` (`Serialize`) or `Deserialization` (`Deserialize`). `cause` holds the exception, `causedByInput` is `false`, and the issue has source `serde`. A `LibError` that a function throws passes through. |
| JSON or model value fails a check | the same calls | `LibError` of kind `Validation` with the issues. |
| A function is not usable | generation | [RUNM1040](/reference/diagnostics#runm1040), [RUNM1042](/reference/diagnostics#runm1042), [RUNM1046](/reference/diagnostics#runm1046), [RUNM1047](/reference/diagnostics#runm1047) |
| A type does not fit the pair | generation | [RUNM1049](/reference/diagnostics#runm1049) |

The usage is in [Change the JSON form](/guide/serialization#change-the-json-form). The declarations are compared in [Which type controls validation](/guide/serialization#which-type-controls-validation), and class fields are in [Class values](/guide/serialization#class-values).

### `TValidation` {#tvalidation}

```ts
type TValidation<Predicate extends (...args: never[]) => boolean | string>;
```

| Predicate result | Effect |
| --- | --- |
| `true` | The value passes. |
| `false` or `''` | The value fails with an issue of code `custom` and the default message. |
| A non-empty string | The value fails with an issue of code `custom`. `reason` and `message` hold the string. |
| Any other value | The check throws `TypeError`. |

- The predicate is an exported function with one required parameter. It is synchronous and returns `boolean`, `string` or a union of the two.
- Declare it in its own module. A predicate in a `*.model.ts` file stops generation ([RUNM1065](/reference/diagnostics#runm1065)). The package and alias rules of [`TSerde`](#tserde) apply ([RUNM1060](/reference/diagnostics#runm1060), [RUNM1061](/reference/diagnostics#runm1061)).
- The model type of the field is assignable to the predicate parameter ([RUNM1050](/reference/diagnostics#runm1050)).
- The predicate runs only after the built-in checks of the same value passed. It never sees a value of the wrong shape. Do not depend on the order of several predicates on one value.
- On a model type, it checks the model value. On the parameter type of a `TSerde` decoder, it checks the JSON value.
- `Money & TValidation<typeof extra>` adds a rule to an SDK type. The rule runs with the checks of that type.
- A predicate does not become part of an OpenAPI document. The document carries the JSON schema only.
- `validateInstance` and `ModelValidator.validate` wrap an exception from a predicate in a `LibError` of kind `Validation`. `cause` holds the exception and `causedByInput` is `false`.

| Failure | Where | Result |
| --- | --- | --- |
| The predicate rejects | any checked call | Issue with code `custom`, source `custom` and optional `reason` ([`Issue`](#errors)). |
| The function is not usable | generation | [RUNM1040](/reference/diagnostics#runm1040), [RUNM1041](/reference/diagnostics#runm1041), [RUNM1046](/reference/diagnostics#runm1046), [RUNM1047](/reference/diagnostics#runm1047), [RUNM1048](/reference/diagnostics#runm1048) |

[Add a custom field rule](/guide/tags#add-a-custom-field-rule) shows the usage.

### Built-in tags {#built-in-tags}

Each built-in tag writes one JSON Schema keyword. A tag that does not fit the field type stops generation ([RUNM1051](/reference/diagnostics#runm1051)).

| Group | Tag | JSON Schema keyword | Field types |
| --- | --- | --- | --- |
| Numbers | `Integer` | `type: integer` | `number` |
| Numbers | `Minimum<N>`, `Min<N>` | `minimum` | `number` |
| Numbers | `Maximum<N>`, `Max<N>` | `maximum` | `number` |
| Numbers | `ExclusiveMinimum<N>`, `ExclusiveMin<N>` | `exclusiveMinimum` | `number` |
| Numbers | `ExclusiveMaximum<N>`, `ExclusiveMax<N>` | `exclusiveMaximum` | `number` |
| Numbers | `MultipleOf<N>` | `multipleOf` | `number` |
| Strings | `MinLength<N>` | `minLength` | `string` |
| Strings | `MaxLength<N>` | `maxLength` | `string` |
| Strings | `Pattern<S>` | `pattern` | `string` |
| Strings | `Format<S>` | `format` | `string` |
| Arrays | `MinItems<N>` | `minItems` | array or tuple |
| Arrays | `MaxItems<N>` | `maxItems` | array or tuple |
| Arrays | `UniqueItems` | `uniqueItems` | array or tuple |
| Arrays | `Contains<T>` | `contains` | array or tuple |
| Arrays | `MinContains<N>` | `minContains` | array or tuple, with `Contains` |
| Arrays | `MaxContains<N>` | `maxContains` | array or tuple, with `Contains` |
| Objects | `MinProperties<N>`, `MinProps<N>` | `minProperties` | object |
| Objects | `MaxProperties<N>`, `MaxProps<N>` | `maxProperties` | object |
| Objects | `PropertyNames<T>` | `propertyNames` | object |
| Objects | `PatternProperties<Map>` | `patternProperties` | object |
| Objects | `AdditionalProperties<T>` | `additionalProperties` | object |
| Objects | `UnevaluatedProperties<T>` | `unevaluatedProperties` | object |
| Related fields | `DependentRequired<Map>` | `dependentRequired` | object |
| Related fields | `DependentSchemas<Map>` | `dependentSchemas` | object |
| Alternatives | `OneOf<Tuple>` | `oneOf` | any type |
| Alternatives | `Not<T>` | `not` | any type |
| Alternatives | `IfThenElse<Condition, Then, Else>` | `if`, `then`, `else` | any type |

- An object type is not an array, a tuple or a function type.
- A union fits when every member fits. `null`, `undefined`, `any` and `unknown` always fit, so an optional or nullable field keeps its tags.
- The same rules apply to the JSON value of a `TSerde` field.
- `N` is a finite numeric literal. Length, item, property and count limits are non-negative integers. `MultipleOf` is positive ([RUNM1043](/reference/diagnostics#runm1043)).
- `Pattern` is a valid Unicode regular expression. `Format` and the keys of `DependentRequired` are string literals ([RUNM1044](/reference/diagnostics#runm1044)).
- A schema-valued argument is a type that golem can describe as a schema ([RUNM1043](/reference/diagnostics#runm1043)).

The usage is in [Built-in validation constraints](/guide/tags#built-in-validation-constraints), and the format names are in [Formats](/guide/tags#formats). [Validation tags](/guide/tags) is the guide.

## `@exprtlabs/golem/temporal` {#temporal}

Temporal field types for models. Each converts to an ISO 8601 string on the wire. [Use Temporal fields](/guide/dates#use-temporal-fields) shows the setup.

| Tag | Model type | Wire string |
| --- | --- | --- |
| `TemporalInstant` | `Temporal.Instant` | `2025-01-02T03:04:05Z`, with fractional seconds only when the value has them |
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
`parse<T>`, `stringify<T>`, `assertValue<T>`, `toWireFormat<T>`, `fromWireFormat<T>` and `validate<T>` throw unless a [build host](/guide/build) rewrote them. `tsc` does not rewrite them.

The error is a `LibError` of kind `ValidationUnavailable`. Its message starts with the call, as in `parse<T> was not rewritten to a generated function`, and then lists the hosts that rewrite calls.
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

### Look up a codec

| Member | Signature | Behavior |
| --- | --- | --- |
| `getObjectCodec` | `(id): ObjectCodec \| undefined` | Returns the codec whose id is exactly `id`. A short model name finds nothing. |
| `getIModelClass` | `(id): class \| undefined` | Returns the `IModel` class registered under the exact id `id`. |

Types: `AllowGetterOptions`, `ObjectCodec`, `SerdeOptions`, `ValidateOptions`, `ValidationPlane`, `WireFormat`. `IssueRepresentation` and `IssueSource` are re-exported from [`errors`](#errors).

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

- It rewrites only `.ts`, `.mts` and `.cts` files outside `node_modules`. A workspace package that is linked into `node_modules` counts as outside it, also with `preserveSymlinks`. A `.tsx` file goes to Node unchanged.
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

The module also exports the metadata types that the generators and the runtime use. Generated files do not import them, and application code does not use them: `GeneratedModelDefinition`, `RegisteredGeneratedModelDefinition`, `GeneratedModelConversion`, `GeneratedModelProfile`, `GeneratedModelValidatorEnhancer`, `ModelTypeMetadata`, `ModelTypeDescriptor`, `ModelConstraint`, `ConstraintSchemaValue`, `UnionDiscriminator` and `DiscriminatorValue`.

### From `validation`

`operationValidators` resolves the input and response validators of an operation once per client. `validateOperationInput` checks a request input. `responseCheck` is the response check that `ClientRuntime.readResponse` runs on each decoded body or stream item.

### From `conversion`

`encodeGeneratedModel`, `decodeGeneratedModelTrusted`, `deserializeDate`, `serializeDate`, `convertModelField`, `convertModelItems`, `convertModelTupleItems`, `defineModelProperty`, `requireModelObject`, `assertAcyclicEncodeInput`, `assertPropertyAcyclic`, `assertWireAcyclic`, `beginDecode`, `endDecode`, `beginEncode`, `endEncode`, `decodeDetachedInput`, `decodeCheckedInput`, `unknownDiscriminatorValue`, `withDiscriminatorValue`, `jsonWithDiscriminator`.

### From `serde`

`createObjectCodec`, `requireObjectCodec`, `registerIModelClass`, `requireIModelClass`, `assertModelValue`, `isValidModelValue`, `modelValueIssues`, `parseJson`, `serdeValidates`, `validationUnavailable`, `withoutInstanceState` and the `stringifyJson*` writers.

The module exports more helpers for the runtime itself. Application code does not call them: `registerObjectCodec`, `findCodecIdForConstructor`, `resolveModelValidationContextValidator`, `validationFailure`, `serdeFailFast`, `resolveGeneratedModelSchemaRefs` and the type `ObjectCodecImpl`.

### From `nest`

| Member | Signature | Behavior |
| --- | --- | --- |
| `nestModelCodec` | `(id: string, array?: boolean): ParameterDecorator` | The rewrite inserts it on `@Body()` and `@Query()` parameters typed with a model or an array of one. It replaces the parameter type with a token that carries the codec and class of the model. |
| `nestModelUnion` | `(property: string, variants: readonly [values: readonly (string \| number \| boolean)[], id: string][]): ParameterDecorator` | The rewrite inserts it on a whole `@Body()` or `@Query()` typed as a union of models. `property` is the tag that every model requires, and each variant lists its tag values and the model it stands for. `NestModelInterceptor` converts the input with the model that the tag picks. |
| `nestModelReturn` | `(id: string, array?: boolean): MethodDecorator` | The rewrite inserts it on a handler that returns a model. `NestModelInterceptor` reads it. |

### From `client`

| Member | Behavior |
| --- | --- |
| `ClientRuntime` | Holds a client's options and sends its requests. `new ClientRuntime(client, options, servers?)`, where `servers` is the `servers` list of the document. `readResponse` selects the declared response, decodes it and runs the operation's response check. |
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
