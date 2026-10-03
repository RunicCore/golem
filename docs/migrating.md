# Migrating to 1.0

Each item names a breaking change and the action to take.

## Runtime

- `validateInstance(model)` and `getValidator(model).validate()` stop at the first issue. Pass `{ failFast: false }` to collect every field error.
- A `Date` field accepts only a parsable date-time string on the wire; an unparsable or non-string value throws `LibError` kind `deserialization` (HTTP 400 in Nest). Send ISO date-time strings, or model the field as `string`.
- A union value with an unknown or missing tag throws instead of serializing as `null` or passing through. Set a mapped tag before `toWireFormat` / `stringify`, and handle `LibError` on decode.
- Decoding no longer clones the input first. Getters run once per declared property, and a cycle is reported when conversion reaches it rather than before any decoder runs. `fromWireFormat` and `parse` still copy objects, maps and arrays, but a value typed `unknown` or `any`, including the undeclared properties of an open object, is the input's own object, so later changes to the input show in the result. `decodeGeneratedModel` does not copy: fields without conversion are the input's own values. Copy such a value before you change it, and regenerate.
- `LibErrorKind` gains `response`. Add a case to exhaustive `switch` statements over the kind.
- `NestModelInterceptor` answers input failures (`causedByInput`) with HTTP 400 instead of 500. A custom validation rule that rejects input returns `false` or a message instead of throwing.
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
- `ttsc` and the `@exprtlabs/golem/ttsc-plugin` and `@exprtlabs/golem-ts-openapi/ttsc-plugin` plugins are removed. Delete the `plugins` entry from `tsconfig.json` and the `ttsc` dependency, and build with [`golem build`](/reference/cli#build), the [Vite](/reference/runtime-api#vite) or [esbuild](/reference/runtime-api#esbuild) plugin, or the [Node loader](/reference/runtime-api#loader). `golem.yaml` gains [`tsconfig`](/reference/config#root-keys) and is the entry point for `golem build`; add `.golem/rewrites.json` and `.golem/build/` to `.gitignore`.
- Several pre-1.0 exports are removed with no replacement ([Removed APIs](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#removed-apis-pre-10)).
- The packages are renamed: `@exprtlabs/codegen` is `@exprtlabs/golem`, `@exprtlabs/model-codegen` is `@exprtlabs/golem-model`, `@exprtlabs/openapi-to-ts` is `@exprtlabs/golem-openapi` and `@exprtlabs/ts-to-openapi` is `@exprtlabs/golem-ts-openapi`. Subpaths are unchanged. Replace the dependencies and imports.
- A `TSerde` or `TValidation` function declared in a `*.model.ts` file is a generation error (RUNM1065). Move it to its own module.
- A `TSerde` or `TValidation` function in another package, including a sibling workspace package, is imported by its package name, so that package's `exports` must reach the file (RUNM1060). Add an `exports` entry for the codec file.
- The CLI is `golem` (was `runic-codegen`) and generator-API types are `Golem*` (was `Codegen*`, for example `GolemProvider`). Rename `runic-codegen.yaml` to `golem.yaml`, delete `.runic-codegen/` and run `npx golem generate`.

## Generated files

- Regenerate after upgrading. SDKs and OpenAPI documents change.
- Replace imports of the SDK's `client.js`, `models.js`, `validation.js` and `client-runtime.js` with `sdk/index.js`, `sdk/models/<Name>.js` or `sdk/operations/<name>.js`; the [generated files](/reference/generated-files) page lists the public paths.
- Code the SDK used to carry now lives in `@exprtlabs/golem/client` and `@exprtlabs/golem/validation`.
- `__Projection<N>` schemas get stable names. Add a named type alias to choose one.
- Install `@exprtlabs/golem` at or above the version the SDK was generated for, with the same major version.
- The identifiers of codecs in generated files change. A hand-written model and an SDK model with the same name and shape no longer share an id.
- `sdk/index.js` no longer exports `IOBJECT_PLUGIN_KEYS` or the schema helpers (`schemaRegistry`, `createRuntimeValidators`, …). No SDK has `schemas.ts`, and an `ajvStandalone` SDK has no root `validators.generated.js` or `validation-engine.ts`; `validation-schemas/` modules export only `schema`; `@exprtlabs/golem/validation` no longer exports `createRegistryValidators`, `createRegistryOperationValidators` or `SchemaRegistryData`. Validate with the generated `validate<Name>` functions or the client's validation engine.
- Generated names keep the exact type alias, with no leading `T` or trailing `Model` dropped: `type TPayment = IModel<…>` generates `TPaymentBaseModel`, `TPaymentFields`, `TPaymentJSON` and `TPaymentInit` (it was `PaymentBase`, `PaymentFields`, `PaymentJSON` and `PaymentInit`), and names of derived types keep the alias (`TMerchantOmitId`). Regenerate, then update `extends` clauses and imports.
- A class links to its model through `extends <Alias>BaseModel`, not through its name. Every class that extends the generated class directly links to the model; a class that extends another linked class does not.
- In an OpenAPI document built from TypeScript models, a model with one class is named by the class, and a model without one, with several, or an `IObject`, by its exact alias (`TPayment`). Models that share a name but not a schema are qualified by directory (`orders.Payment`). Update `$ref`s and generated-client code that used the alias without its `T`; `@ApiSchema({ name })` still sets a name.
- Generated `parse<Name>`, `fromWireFormat<Name>` and `assert<Name>` return `<Name>Fields`, and `stringify<Name>` and `toWireFormat<Name>` accept it, instead of `unknown`.
- `generate` and `check` stop when a file golem did not generate sits at an output path. Remove or rename it.
