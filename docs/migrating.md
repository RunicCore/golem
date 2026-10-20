# Migrating to 1.0

Each item names a breaking change and the action to take.

## Runtime

- `validateInstance(model)` and `getValidator(model).validate()` stop at the first issue. Pass `{ failFast: false }` to collect every field error.
- A `Date` field accepts only a parsable date-time string on the wire; an unparsable or non-string value throws `LibError` kind `deserialization` (HTTP 400 in Nest). Send ISO date-time strings, or model the field as `string`.
- A union value with an unknown or missing tag throws instead of serializing as `null` or passing through. Set a mapped tag before `toWireFormat` / `stringify`, and handle `LibError` on decode.
- Decoding no longer clones the input first. Getters run once per declared property, and a cycle is reported when conversion reaches it rather than before any decoder runs. `fromWireFormat` and `parse` still copy objects, maps and arrays, but a value typed `unknown` or `any`, including the undeclared properties of an open object, is the input's own object, so later changes to the input show in the result. `decodeGeneratedModel` does not copy: fields without conversion are the input's own values. Copy such a value before you change it, and regenerate.
- `LibErrorKind` gains `response`. Add a case to exhaustive `switch` statements over the kind.
- `NestModelInterceptor` answers input failures (`causedByInput`) with HTTP 400 instead of 500. A custom validation rule that rejects input returns `false` or a message instead of throwing.
- `NestModelInterceptor` throws a `TypeError`, and Nest answers HTTP 500, for a `@Body()` or `@Query()` parameter that is not an `IModel` or `IObject`, whole or one field such as `@Body('name')`. Declare the input as an `IModel` or `IObject`, or write your own interceptor with `objectCodecFromMetatype`.
- Removed exports: replace `getModelValidator` with `getValidator(model)` (also in `mobx-validation`), `isIModelReference` with `isModelDeclarationReference(checker, node)`, and `createProgram` with `createProgramFromSources`. `validationTagKey` and `validationTagSchemaDescriptor` moved to `@exprtlabs/golem/schema`.

## Controllers

- Class-level and method-level security are concatenated as alternatives, instead of a method requirement replacing the class requirement. Move class-level security onto the methods that need it, or move those methods to another controller.
- `@ApiQuery()` / `@ApiParam()` without `required` now mark the parameter required. Add `required: false` where it's optional.
- A structural decorator option that isn't a compile-time constant fails with [`NEST1504`](/reference/diagnostics#nest1504). Use literals, `const` declarations, enum members or `const` objects.
- Duplicate parameters with the same name and location fail with [`NEST1312`](/reference/diagnostics#nest1312). A whole `@Query()` object alongside named `@Query('name')` parameters, or a second whole-object `@Query()`, fails with [`NEST1107`](/reference/diagnostics#nest1107) on OpenAPI 3.2. Keep one binding per name and location.
- `@All`, `@Search`, `@QueryMethod`, `@Sse`, `@Redirect`, WebDAV methods and `@RequestMapping` with a non-OpenAPI method fail with [`NEST1201`](/reference/diagnostics#nest1201). Use `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, or `@RequestMapping` with one of those methods; or exclude the route with `@ApiExcludeEndpoint()`.
- Wildcard, regular-expression and quoted route paths fail with [`NEST1207`](/reference/diagnostics#nest1207). Use named `:param` segments, or exclude the route with `@ApiExcludeEndpoint()`.
- Optional segments (`:id?`, `{/:id}`) expand into one operation per path, with `__path_N` operationId suffixes. Update generated-client call sites and any tooling keyed on those operationIds.
- `@Header()`, `@Cookie()`, `@Cookies()` and `ApiCookie` are no longer read as parameters. Use `@Headers('name')` for request headers; document cookie authentication with `@ApiCookieAuth()`.

## OpenAPI clients

- `ClientRuntime` no longer has `getOperationValidators`, `validateOperationInput`, `responseValidator` or `assertValid`; use `operationValidators`, `validateOperationInput` and `responseCheck` from `@exprtlabs/golem/validation`. Regenerate the SDK.
- `@exprtlabs/golem-openapi/generator` no longer exports `generateClient`, `generateTypes` and the other per-artifact functions. Call `generate` or `writeSdk`.
- Every discriminated-union variant must declare the discriminator property. Add it to each variant schema.
- An implicit discriminator value is the raw component name (`cat`), not the generated type name (`Cat`). Add an explicit `discriminator.mapping` where senders use another value.
- A variant shared by two discriminated unions gives neither union a model class. Give each union its own variant schemas if code needs the union class.
- An undeclared response status or media type throws `LibError` kind `response`. Declare every status and media type the server sends, and catch the error with `is<Client>UndeclaredResponseError`.
- `allowReserved` query values keep `#`, `[`, `]`, `&` and `+` encoded and pass `%XX` escapes through. Stop pre-encoding values that already contain escapes.
- A caller-supplied `fetchImpl` is called without a receiver. Bind or wrap a function that relies on `this` before passing it.
- OpenAPI 3.0 documents are rejected. Convert the document to OpenAPI 3.1 or 3.2.
- `@redocly/openapi-core` is no longer a dependency; Golem resolves `$ref`s and validates documents itself. Remove any direct dependency your project took on it.
- A schema pulled in from another file is named after its path (`schemas/user.json` → `schemas.user`, model `SchemasUser`) instead of its file name with a numeric suffix. A root component that is only a `$ref` to an external file keeps its own name; one with a `$ref` plus other keys is not an alias, so its target still gets the path-based name and can collide with the root name. A name collision fails generation, naming both locations; rename the colliding schema in the source document.
- An implicit discriminator value for a schema from another file is its path-based component name (for example `schemas.dog`). Add an explicit `discriminator.mapping`, or a root alias, to keep a chosen value.
- The `spec-ref-siblings`, `path-not-include-query` and `nullable-type-sibling` validation rules are gone, and error lines name the file that contains the problem. A document that relied on their stricter checks to fail generation now passes; every other rule is unchanged.
- `collectLocalReferenceInputs` from `@exprtlabs/golem-openapi/generator` now returns a `Promise`. Await the call.

## Packages

- `typescript` (`>=6.0.0 <8`) is a peer dependency of both generators. Install it in the consuming project.
- `ttsc` and the `@exprtlabs/golem/ttsc-plugin` and `@exprtlabs/golem-ts-openapi/ttsc-plugin` plugins are removed. Delete the `plugins` entry from `tsconfig.json` and the `ttsc` dependency, and build with [`golem build`](/reference/cli#build), the [Vite](/reference/runtime-api#vite) or [esbuild](/reference/runtime-api#esbuild) plugin, or the [Node loader](/reference/runtime-api#loader). `golem.yaml` gains [`tsconfig`](/reference/config#root-keys) and is the entry point for `golem build`. Always ignore `.golem/build/` and `.golem/jobs.json`; choose how to treat the generated files ([what to commit](/reference/generated-files#gitignore)).
- The plugin options move out of `tsconfig.json`. `"nest": true` is a `controllers` job in `golem.yaml`: with one, the rewrite inserts the Nest codec decorators ([`rewrite`](/reference/runtime-api#rewrite)). `"serde": false`, which left the generic serde calls alone, has no replacement: the rewrite always replaces `stringify<T>`, `parse<T>` and the other generic calls it finds, so a call whose `T` has no generated code now fails the host, and `golem check`, instead of throwing at runtime.
- Generated files need not be committed. Ignore the generated files and `.golem/` together, or commit the generated files with `.golem/outputs.json` and `.golem/codec-keys.json` ([what to commit](/reference/generated-files#gitignore)).
- `golem generate` no longer stops on a type error in a handwritten file that is not a model source; `tsc` and `golem build` report it.
- The Node loader runs a NestJS app only with a second loader that compiles decorators, registered after golem's ([loader](/reference/runtime-api#register)). With `preserveSymlinks`, a `parse<T>()` call in a symlinked workspace package fails at run time.
- Several pre-1.0 exports are removed with no replacement ([Removed APIs](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#removed-apis-pre-10)).
- The packages are renamed: `@exprtlabs/codegen` is `@exprtlabs/golem`, `@exprtlabs/model-codegen` is `@exprtlabs/golem-model`, `@exprtlabs/openapi-to-ts` is `@exprtlabs/golem-openapi` and `@exprtlabs/ts-to-openapi` is `@exprtlabs/golem-ts-openapi`. Subpaths are unchanged. Replace the dependencies and imports.
- A `TSerde` or `TValidation` function declared in a `*.model.ts` file is a generation error (RUNM1065). Move it to its own module.
- A `TSerde` or `TValidation` function in another package, including a sibling workspace package, is imported by its package name, so that package's `exports` must reach the file (RUNM1060). Add an `exports` entry for the codec file.
- The CLI is `golem` (was `runic-codegen`) and generator-API types are `Golem*` (was `Codegen*`, for example `GolemProvider`). Rename `runic-codegen.yaml` to `golem.yaml`, delete `.runic-codegen/` and run `npx golem generate`.

## Validation

golem now validates with its own generated validators. Ajv is gone.

- Remove `ajv` and `ajv-formats` from your dependencies. golem no longer lists them as peers.
- The `@exprtlabs/golem/ajv` and `@exprtlabs/golem/ajv-tooling` subpaths are removed, with `OpenApiAjvOptions`, `createOpenApiAjvEngine`, `createOpenApiSyncAjvEngine`, `configureModelValidationEngine` and `registerModelValidationEngineFactory`. Delete any code that registers an engine. To supply your own checks for one call, pass a `validationContext` with a `resolve` function ([validation context](/reference/runtime-api#validation-context)).
- `ajvStandalone` in `golem.yaml` is removed and now fails with `Unknown configuration key: ajvStandalone.`. Delete the key. Validators are always generated, in one mode.
- `golem.yaml` gains [`unknownFormats`](/reference/config#root-keys): `warn` (the default) or `error`. Ajv checked `byte`, `uri-template`, `json-pointer`, `relative-json-pointer`, `url`, `iso-time` and `iso-date-time`. golem now checks `byte`, `json-pointer` and `relative-json-pointer`; `uri-template`, `url`, `iso-time` and `iso-date-time` report a warning and are not checked, or fail generation with `error`. Any other `format` golem does not check reports the same way.
- Validator files are TypeScript: `models.validators.generated.ts` for the models job and one `validators.generated.ts` for each SDK. They need no `allowJs` and ship no notices file. The next `golem generate` deletes the old `.js`, `.d.ts` and `.NOTICES.txt` outputs.
- A schema that uses `$dynamicRef` or `$dynamicAnchor` in an external OpenAPI document now fails generation with `VALIDATE_UNSUPPORTED_KEYWORD`.
- Every SDK generated by an older release fails generation in each project that uses its models, with validation on or off: its `model-manifest.json` no longer matches what this release reads. Regenerate the SDK, or remove the older generated SDK.
- A union of models of the same job, where each model has a required string tag with its own value, now validates by its tag. A wrong tag gives a `literal` issue at the tag, not a `union` issue with `matched: 0`; a known tag gives the issues of its model. Update code that reads the `union` issue of such a union. The OpenAPI document of golem-ts-openapi gets a `discriminator` with a `mapping` for it.

### Issues

An `Issue` now has one `code` for each kind of failure, with typed fields in place of `params`. The per-keyword codes are gone, and the default English messages changed. Update code that reads `issue.code` or `issue.params`, and any `messages()` key.

`IssueCode` was an exported enum and is now a string-union type. `IssueCode.Required` no longer compiles, and a JavaScript import of `IssueCode` fails. Write the string code, such as `'required'`.

A NestJS application's HTTP 400 response body carries the new issue shape: type-level codes, typed fields and no `params`. Update HTTP clients that read it.

| Old code | New code |
| --- | --- |
| `minLength`, `minItems`, `minimum`, `minProperties`, `minContains`, `contains` | `tooSmall` with `measure` `length`, `items`, `value`, `properties` or `matches` |
| `maxLength`, `maxItems`, `maximum`, `maxProperties`, `maxContains` | `tooBig` |
| `exclusiveMinimum`, `exclusiveMaximum` | `tooSmall`, `tooBig` with `inclusive: false` |
| `items`, `unevaluatedItems` (a closed tuple) | `tooBig` with `measure: 'items'` |
| `tupleLength` | `tooSmall` or `tooBig` with `measure: 'items'` |
| `const`, `enum`, `literal` | `literal` |
| `additionalProperties`, `unevaluatedProperties` | `unknownKey` |
| `propertyNames` | `invalidKey` |
| `dependentRequired`, `required` | `required` |
| `anyOf`, `oneOf`, `union` | `union` |
| `uniqueItems` | `unique` |
| `reference` | `instance` |
| `allOf`, `dependentSchemas`, `if`, `patternProperties` | the issues of the schema that failed, each with its own code and path |
| `invalid` | the specific code of the failed check |
| `type`, `format`, `pattern`, `multipleOf`, `not`, `never`, `custom`, `external`, `invalid_json`, `serialization`, `deserialization` | unchanged |
| `validation_unavailable` | no issue code; it remains the `LibErrorKind` of the thrown error |

- A `ValidationRule` returns `true`, a message, `{ message }` or nothing. It no longer returns a code: an issue from a rule has the code `custom`.
- `ModelValidationContext` is `{ resolve }`. The `engine` field is removed.
- A field is present only when it is an own enumerable property and its value is not `undefined`, as `JSON.stringify` writes it. This rule applies to validation, decode, constructors and `validateInstance`.
- A property whose value is `undefined`, a non-enumerable property and an inherited property are absent. `new Model({ a: undefined })` does not define `a`.
- A getter on your class does not supply a declared field to `validateInstance`. Set the field on the instance.
- In `const`, `enum` and `uniqueItems`, a key whose value is `undefined` is absent, and `[undefined]`, `[ , ]` and `[null]` are equal.
- The `source` of an issue from a nested model is the source of the model that holds it.

### Client validators

- `ClientRuntime` loses `defaults`, `createValidationEngine` and `validationEngine`. Create it with `new ClientRuntime(client, options)`.
- An `operationValidators` override is a `Validator`: `(value, all)`, returning an array of issues. A validator that does not return an array throws `TypeError`.
- `ValidationResult` is `{ valid, issues }`, not `{ valid, errors }`, and `validateWith` takes an `all` argument.

## Generated files

- Regenerate after upgrading. SDKs and OpenAPI documents change.
- Replace imports of the SDK's `client.js`, `models.js`, `validation.js` and `client-runtime.js` with `sdk/index.js`, `sdk/models/<Name>.js` or `sdk/operations/<name>.js`; the [generated files](/reference/generated-files) page lists the public paths.
- Code the SDK used to carry now lives in `@exprtlabs/golem/client` and `@exprtlabs/golem/validation`.
- `__Projection<N>` schemas get stable names. Add a named type alias to choose one.
- Install `@exprtlabs/golem` at or above the version the SDK was generated for, with the same major version.
- The codec keys of your own models move from `src/generated/models/iobject-plugin-keys.ts` to `.golem/codec-keys.json`, and the `model-manifest.json` of an SDK holds a `codecId` for each model. Regenerate your SDKs; golem still reads the tables of older ones.
- The identifiers of codecs in generated files change. A hand-written model and an SDK model with the same name and shape no longer share an id.
- `sdk/index.js` no longer exports `IOBJECT_PLUGIN_KEYS` or the schema helpers (`schemaRegistry`, `createRuntimeValidators`, …). No SDK has `schemas.ts`; `validation-schemas/` modules export only `schema`; `@exprtlabs/golem/validation` no longer exports `createRegistryValidators`, `createRegistryOperationValidators` or `SchemaRegistryData`. Validate with the generated `validate<Name>` functions or the client's `operationValidators` option.
- A shared folder works like an installed package: golem generates only for model files inside `models.root`. Declare your own top-level `IObject` or `IModel` over each plain type of the folder; a field or call that uses an outside model stops with RUNM1074. Delete the old `*.model.generated.ts` files in shared folders and any `.golem.lock`. Remove the `#golem-models` `imports` entry, alias or `paths` entry that earlier releases needed. Then regenerate ([shared folder](/reference/config#a-folder-shared-by-several-apps)).
- Generated names keep the exact type alias, with no leading `T` or trailing `Model` dropped: `type TPayment = IModel<…>` generates `TPaymentBaseModel`, `TPaymentFields`, `TPaymentJSON` and `TPaymentInit` (it was `PaymentBase`, `PaymentFields`, `PaymentJSON` and `PaymentInit`), and names of derived types keep the alias (`TMerchantOmitId`). Regenerate, then update `extends` clauses and imports.
- A class links to its model through `extends <Alias>BaseModel`, not through its name. Every class that extends the generated class directly links to the model; a class that extends another linked class does not.
- In an OpenAPI document built from TypeScript models, a model with one class is named by the class, and a model without one, with several, or an `IObject`, by its exact alias (`TPayment`). Models that share a name but not a schema are qualified by directory (`orders.Payment`). Update `$ref`s and generated-client code that used the alias without its `T`; `@ApiSchema({ name })` still sets a name.
- Generated `parse<Name>`, `fromWireFormat<Name>` and `assert<Name>` return `<Name>Fields`, and `stringify<Name>` and `toWireFormat<Name>` accept it, instead of `unknown`.
- `generate` and `check` stop when a file golem did not generate sits at an output path. Remove or rename it.
