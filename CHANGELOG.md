# Changelog

This file is the complete list of changes. The documentation site's
[release notes](docs/changelog.md) summarize the release.

## Migrating to 1.0

Every breaking change, one bullet per change, with the action to take:
[Migrating to 1.0](docs/changelog.md#migrating). Details for each package are
in the sections below.

## Release candidate

The first release candidate includes four independently installable packages:

| Package | Purpose |
| --- | --- |
| `@exprtlabs/golem-model` | Generate model bases from TypeScript declarations |
| `@exprtlabs/golem-openapi` | Generate typed clients and runtime models from OpenAPI |
| `@exprtlabs/golem-ts-openapi` | Generate OpenAPI from NestJS controllers |
| `@exprtlabs/golem` | Shared CLI, model runtime, validation and serialization |

### Models

- Type aliases of tags accept type parameters as tag arguments, such as `type Varchar<N extends number> = string & MaxLength<N>`.
- Tag aliases and `TSerde`/`TValidation` functions can come from an installed package; generated files import them through the package's `exports`.
- A `TSerde` field can hold a class instance, such as `Uint8Array`, or a `bigint`.
- `IModel` / `IObject` `exact` defaults to `true`. Opt out with `{ exact: false }`.
- Synchronous `parse` / `stringify` convert JSON text; `fromWireFormat` /
  `toWireFormat` convert the object plane. Type-only targets fill a plain
  IObject; class targets construct that class.
- `toWireFormat<T>` returns `WireFormat<T>` (exported from `@exprtlabs/golem/serde` and `/model`), which equals the generated `XJSON` type, instead of `unknown`; drop `as XJSON` casts. Generated `toWireFormatX` functions and `ObjectCodec.toWireFormat` report the same type.
- Validated conversion checks each rule once. `parse` / `fromWireFormat` check the full JSON, then only converted values and model `TValidation` rules; `stringify` / `toWireFormat` check the full model, then only the JSON written for converted fields. `IObject` `parse` now enforces those model rules too. Validation contexts resolve by reference (`resolve(reference, mode)`, with `Id`, `Id#wire`, `Id#model-only`, `Id#wire-only`); `registerCodecSchemas` fills an engine.
- `toWireFormat` and `encodeGeneratedModel` omit an optional field whose value is `undefined`, as `stringify` and `JSON.stringify` do. A nested plain object without a projection keeps an `undefined` key you set on it.
- Decoding nested models is faster: a nested model in the same companion reuses the input copy the outermost `fromWireFormat` made instead of copying its subtree again, and model fields are assigned directly unless the class or its prototype chain already has a property of that name (inherited setters are still never invoked).
- Generated `XJSON` and `XFields` types keep `readonly` from `Readonly<>` and other mapped types, and drop it under `-readonly`.
- Nested model conversion preserves model instances. Projected types such as `Pick` and `Omit` produce plain objects with the selected fields and keep their field conversion and constraints. `IModel` exposes declared field keys to TypeScript utilities.
- Root model unions such as `IModel<TEmail | TPhone>` are rejected (`RUNM1052`); keep the union in a field.
- Built-in constraint tags generate validation. `TValidation` references a custom predicate; `TSerde` references a pair of conversion functions.
- Serde validates by default when validation is generated. It stops at the first issue and leaves displayed field errors unchanged. `ObjectCodec.validate` is the wire plane.
- **Breaking:** `validateInstance(model)` and `getValidator(model).validate()` stop at the first issue by default, like serde. Pass `{ failFast: false }` to collect every field error (for example in a form).
- `getValidator(model)` and `validateInstance(model)` accept a model registered without a generation profile and validate its codec, schema or custom rules (previously they threw); with none of these, validation throws `ValidationUnavailable`. A generated model that disables validation, or enables it without conversion and codec metadata, still throws `ValidationUnavailable`.
- **Breaking:** decoding a `Date` field accepts only a parsable date-time string (or an existing `Date`); anything else throws a `LibError` of kind `deserialization` (`causedByInput: true`) instead of producing an invalid `Date`.
- `LibError.causedByInput` marks failures caused by the rejected value: validation, invalid JSON, an unknown discriminator tag, an unparsable date, cyclic input, and a non-object where a generated model expects an object. `NestModelInterceptor` answers those with HTTP 400; a throwing application converter (including a `TSerde` decoder), a throwing custom validation rule or message formatter, a failing validation engine, and missing generated metadata remain HTTP 500.
- Optional MobX integration includes nested generated models.
- Discriminated unions may use string, number or boolean tags and several tag values per variant. **Breaking:** serializing or initializing a union value whose tag is unknown or missing throws a `LibError` (previously an unknown tag serialized as `null` or passed through). An instance without its tag is written with its variant's first tag value.
- An unknown or missing tag in decoded input is an input error (`causedByInput: true`, HTTP 400 in Nest). With validation enabled, `parse` and `fromWireFormat` report it as kind `validation`; with validation disabled (profile `validation: false` or `{ validate: false }`) and in constructors, it is kind `deserialization` (`Unknown <tag> discriminator value`). Encoding an instance whose tag is unknown or contradicts its variant class throws kind `serialization` (`causedByInput: false`).
- Generation and `parse<T>` / `stringify<T>` require TypeScript 7 and `ttsc`. TypeScript 5 and 6 are not supported.

### OpenAPI

- **Breaking:** `ClientRuntime` no longer has `getOperationValidators`, `validateOperationInput`, `responseValidator` or `assertValid`. `@exprtlabs/golem/validation` exports `operationValidators`, `validateOperationInput` and `responseCheck`, and `readResponse` takes an optional response check in place of the validators. An SDK generated with validation off no longer bundles the validation runner. Regenerate the SDK.
- Client methods create reusable operation objects. `.execute(input, options)` sends the request.
- Clients support authentication, body codecs, cancellation and supported streaming responses.
- With MobX enabled, each operation exposes observable `loading`. Concurrent executions are allowed and produce a warning.
- Controller generation reads NestJS routes and TypeScript types without starting the application.
- Controller decorator metadata is read from literals, `const` declarations, enum members and whole enums, `const` objects, spreads and string templates. **Breaking:** a structural option (`type`, `enum`, `schema`, `format`, bounds, `required`, `nullable`, tags, security, status) that is not a compile-time constant fails generation with `NEST1504`; a non-constant documentation option (`description`, `summary`, `title`, `example`, `externalDocs`) is dropped with a `NEST1504` warning. `let` and `var` route constants are rejected.
- `getSchemaPath()` and `refs()` become component references and honor `@ApiSchema({ name })`. `@ApiProperty` accepts `type: 'integer'`, `Date` and enums, applies to array and optional nested DTOs, and keeps metadata for every nested property.
- Inherited routes from generic and mixin base controllers use the derived class's type arguments. `Observable<T>` returns are unwrapped like `Promise<T>`.
- **Breaking:** `@exprtlabs/golem-ts-openapi` declares `typescript` (`~7.0.2`) and `ttsc` (`~0.30.4`) as peer dependencies instead of dependencies; install them in the consuming project.
- **Breaking:** parameters decorated with `@Header()`, `@Cookie()`, `@Cookies()` or `ApiCookie` are no longer read as OpenAPI parameters. None is a `@nestjs/common` parameter decorator (`@Header()` sets a response header), and `@nestjs/swagger` exports no `ApiCookie`. Use `@Headers('name')` for request headers. No supported decorator produces a cookie parameter; `@ApiCookieAuth()` documents cookie authentication as a security scheme.
- Emitted paths and object keys are ordered by code unit instead of the host locale, so documents are identical on every machine.
- **Breaking:** controller security follows `@nestjs/swagger`: class-level security (including base controllers) and method-level security are concatenated; previously a method requirement replaced the class requirement. Class `@ApiTags` and security are also read from base controllers, including a decorated base wrapped by a mixin (`extends Timestamped(BaseController)`).
- **Breaking:** an `@ApiQuery()` or `@ApiParam()` without `required` marks its parameter required, including a declared optional `@Query('x') x?`, matching `@nestjs/swagger`; set `required: false` to keep it optional. A `@Query('limit') limit = 20` parameter with a default value is optional.
- **Breaking:** two parameters with the same name and location in one operation fail with `NEST1312`. In OpenAPI 3.2, a whole `@Query()` object (a `querystring` parameter) beside `@Query('name')`, an `@ApiQuery()` for a name that is not one of its fields, or a second `@Query()` object fails with `NEST1107`. An `@ApiQuery()` for one of its fields documents that field in the querystring schema, as OpenAPI 3.1 documents the flattened parameter.
- **Breaking:** `@Search`, `@QueryMethod`, WebDAV method decorators and `@RequestMapping` with `RequestMethod.ALL`, `SEARCH`, `QUERY` or a WebDAV method fail with `NEST1201`, as `@All`, `@Sse` and `@Redirect` already did, regardless of decorator order. `@RequestMapping` with an OpenAPI method is supported. Endpoints excluded with `@ApiExcludeEndpoint()` or `@ApiOperation({ hidden: true })` are skipped before their route is checked.
- **Breaking:** route paths with wildcards (`*`, `*splat`), regular-expression parameters (`:id(\d+)`) or quoted names fail with `NEST1207` instead of producing invalid paths. Optional segments (`:id?`, `{/:id}`) expand into one operation per path, with `__path_N` operationId suffixes; the paths without the segment omit its `@Param()`.
- `@ApiQuery`, `@ApiParam` and `@ApiHeader` overrides apply to the parameter with the same name *and* location. `@Header(name, value)` is documented as a header of the success response; `@Header('Content-Type', type)` sets the success response media type instead. `VERSION_NEUTRAL` is accepted in `@Controller({ version })`.
- An explicit Swagger `schema` that composes components (`$ref`, `oneOf`, `anyOf`, `allOf`, for example with `getSchemaPath()`) replaces the inline schema of an ordinary DTO response or body instead of being emitted beside it. `@ApiProperty({ enum, enumName })` emits one `components.schemas.<enumName>` and references it.
- `NEST1503` conflict messages name the schema keyword path and both values, and say which TypeScript declaration to change.
- A whole-object `@Query()` model decodes query strings to its declared number, integer, boolean, literal and array fields before validation.
- An OpenAPI `discriminator` on a `oneOf`/`anyOf` of `allOf` variant models selects the variant through explicit (reference or component name) and implicit mappings, including several values for one variant. Variant models keep their declared tag type. A discriminator on a base schema without `oneOf`/`anyOf` is reported as unsupported (see the OpenAPI support matrix).
- **Breaking:** every variant of a discriminated union must declare the discriminator property; generation rejects a variant that does not.
- **Breaking:** a variant shared by two discriminated unions now gives neither union a model class, with a generation warning; values typed by those unions still decode to the variant models. Previously the result depended on component declaration order.
- **Breaking:** `@exprtlabs/golem-openapi/generator` no longer exports `generateClient`, `generateInbound`, `generateLinks`, `generateSchemas`, `generateTypes`, `generateValidation`, `generatedFiles` or `generateModelManifest`; use `generate` or `writeSdk`.
- **Breaking:** decoding or initializing a union model with an unknown discriminator value throws a `LibError` (previously a `TypeError`): kind `validation` when the call validates, otherwise `deserialization`, as described under Models.
- A discriminated `anyOf` of component models now generates an abstract union model class, as `oneOf` does; without a discriminator, `anyOf` is unchanged.
- **Breaking:** an implicit discriminator value is the raw component name (`cat`), as OpenAPI specifies, not the generated type name (`Cat`). Generation warns when the two differ.
- **Breaking:** in OpenAPI 3.0, `nullable: true` admits `null` only beside `type` (OAS 3.0.3). Without `type`, including a `$ref` sibling or `allOf` wrapper, types, models and runtime schemas no longer admit `null`. In 3.1 and 3.2 documents `nullable` is ignored; use `type: [..., 'null']`.
- Reserved-word or client-member operation names (`delete`, `constructor`) receive a `_` suffix with a generation warning; operation modules that differ only by letter case are rejected.
- Component schemas named `Array` or `Blob` no longer shadow generated array and binary types.
- **Breaking:** a response the operation declares without content now resolves with an undefined body and cancels any body the server sends (previously a content type on it failed). An undeclared status or media type cancels the body and throws a `LibError` of the new kind `response` (`LibErrorKind.Response`) carrying `operation`, `status`, `headers` and `contentType`; `is<Client>UndeclaredResponseError` recognizes it (previously a plain `Error`).
- **Breaking:** `allowReserved` query values keep `#`, `[`, `]`, `&` and `+` percent-encoded and pass existing `%XX` escapes through unchanged (previously those characters were sent literally and `%` was re-encoded).
- Security requirements `[{}, {...}]` send configured credentials; the empty requirement is only the fallback. Basic credentials are UTF-8 encoded, and a username containing `:` is rejected (RFC 7617). Nested `deepObject` values serialize as `name[a][b]=v`; nested `null` and `undefined` members are skipped. Server-sent events no longer dispatch early on a CRLF split across chunks, an unterminated event at the end of the stream is discarded, and a data-less event no longer passes its `event` type to the next event.
- Cookie parameters and cookie API keys produce the `OPENAPI_BROWSER_COOKIE` generation warning: browsers do not let scripts set the Cookie header. Node behavior is unchanged.
- A caller-supplied `fetchImpl` is called without a receiver (`this` is `undefined`, previously the client), so a native browser `fetch` works.
- Generated TypeScript writes arrays as `T[]` instead of `Array<T>`.
- Fixed: an `allOf` variant decodes and validates fields it inherits from a referenced base, such as a `date-time` field decoded to `Date`, and a discriminated union's wire validation uses each variant's wire schema (a valid `createdAt` was rejected by `fromWireFormat`).
- Fixed: component names containing `~`, `/` or spaces generate type names, registry ids and discriminator mappings correctly (for example `a~cat` produced an undefined type `A0cat`).
- A non-object where a generated model expects an object is rejected as input (`LibError` of kind `deserialization`, `causedByInput`, HTTP 400 in Nest) instead of a `TypeError`.
- **Breaking:** OpenAPI 3.0 documents are rejected; convert them to 3.1 or 3.2.
- **Breaking:** `@redocly/openapi-core` is no longer a dependency. Golem resolves `$ref`s and validates documents itself.
- **Breaking:** a schema pulled in from another file is named after its path (`schemas/user.json` → `schemas.user`, model `SchemasUser`) instead of its file name with a numeric suffix. A root component that is only a `$ref` to an external file keeps its own name; a root component with a `$ref` plus other keys is not an alias, so its target still gets the path-based name and can collide with the root name. A name clash now fails generation, naming both locations.
- **Breaking:** an implicit discriminator value for a schema from another file is now its path-based component name (for example `schemas.dog`). Use an explicit `mapping`, or a root alias, to keep a chosen value.
- **Breaking:** the `spec-ref-siblings`, `path-not-include-query`, and `nullable-type-sibling` validation rules are gone; error lines name the file that contains the problem.
- **Breaking:** `collectLocalReferenceInputs` from `@exprtlabs/golem-openapi/generator` now returns a `Promise`.

See [OpenAPI client support](docs/reference/openapi-support.md) for supported versions and contract limitations.

### Generation

- **Breaking:** the packages, CLI and files are renamed to golem. `@exprtlabs/codegen` is `@exprtlabs/golem`, `@exprtlabs/model-codegen` is `@exprtlabs/golem-model`, `@exprtlabs/openapi-to-ts` is `@exprtlabs/golem-openapi` and `@exprtlabs/ts-to-openapi` is `@exprtlabs/golem-ts-openapi`; subpaths are unchanged. The CLI is `golem`, the config file `golem.yaml` and the inventory directory `.golem/`. Generator-API types are renamed from `Codegen*` to `Golem*` (for example `GolemProvider`, `GolemProfile`), and generated internal names from `__runic*` to `__golem*`. Rename `runic-codegen.yaml` to `golem.yaml`, delete `.runic-codegen/` and run `npx golem generate`.
- Generated files are replaced on regeneration; handwritten behavior belongs in source declarations and subclasses.
- Identical output keeps its modification time. `check` reports drift without writing files.
- Watch regenerates when a model imports a project file outside its job root.
- Model generation analyzes each model once per job, and a companion emits code only for the models its source declares; models from other sources are referenced by codec id and their companions are imported. Generation time and output size now grow linearly with chains of referencing models (80 chained models: 1.4 s and 4.8 MB, previously 36 s and 284 MB), and models that reference each other across files load in either import order. Companions of referenced models export internal `__golem*` helpers and an `XInit` type; do not import the helpers directly.
- Validation defaults to on; MobX and standalone Ajv default to off. `allowAny` defaults to false and can be overridden per model.
- Tooling requires Node.js 22.15 or newer.
- **Breaking:** `@exprtlabs/golem-model` declares `typescript` (`~7.0.2`) and `ttsc` (`~0.30.4`) as peer dependencies instead of dependencies, like `@exprtlabs/golem-ts-openapi`; install them in the consuming project. `ttsc` builds the Go plugin with its bundled Go toolchain.
- Packages no longer publish source maps, which referenced unpublished TypeScript sources. `@exprtlabs/golem` no longer publishes the Go plugin's tests or `go.work` files.
- **Breaking:** regenerate after upgrading. SDKs and OpenAPI documents change.
- **Breaking:** the SDK no longer writes `validation.ts`, `client-runtime.ts` or `models.ts`, and `client.ts` is internal. The code the SDK used to carry now lives in `@exprtlabs/golem/client` and `@exprtlabs/golem/validation`. Replace imports of `sdk/client.js`, `sdk/models.js`, `sdk/validation.js` and `sdk/client-runtime.js` with `sdk/index.js`, `sdk/models/<Name>.js` or `sdk/operations/<name>.js` ([generated files](docs/reference/generated-files.md)).
- **Breaking:** `__Projection<N>` schemas get stable names built from the type's shape. Add a named type alias to choose one.
- **Breaking:** install `@exprtlabs/golem` at or above the version the SDK was generated for, with the same major version. Generation commands fail before writing when it is older.
- **Breaking:** codec ids in generated files change. A hand-written model and an SDK model with the same name and shape no longer share an id.
- **Breaking:** the output inventory (`.golem/outputs.json`) records a `destination` and `destinationKind` for every file.

### Removed APIs (pre-1.0)

- `@exprtlabs/golem/validation`: `getModelValidator` (use `getValidator(model)`), `findCachedModelValidator`, `cacheModelValidator`, `validateGeneratedValue`, `preflightModelValidation`, `formatGeneratedIssues`, `evaluateModel`, `validationTagKey`, `validationTagSchemaDescriptor` and `validationTagGroups` (the first two tag helpers moved to `@exprtlabs/golem/schema`), and the structural validation helpers `fail`, `pushPath`, `popPath`, `enterActive`, `leaveActive`, `readOwn`, `runTag`, `runNestedModel`, `withNestedScope`, `childPath`, `continueStep`, `getProjection`, `rememberProjection`, `projectNestedModel`, `missingValidation` and `ensureNestedReady`. The `ModelValidator` constructor takes only the model.
- `@exprtlabs/golem/mobx-validation`: `getModelValidator` is renamed `getValidator`.
- `@exprtlabs/golem/model`: `TypeScriptGeneratedModelValidation`, the `Structural*` validation types, the `model` field of `OpenApiGeneratedModelValidation`, and the `ModelFields` alias.
- `@exprtlabs/golem/errors`: `errorOwnerChain`, `invocationOwners`, `attachErrorOwners` and `readErrorOwners`.
- `@exprtlabs/golem/serde`: `bindCodecIdToConstructor`, `lookupOperationCodec` and `PUBLIC_SERDE_CALLS` (the call table now lives with the docs).
- `@exprtlabs/golem/conversion`: `createJsonValue`.
- `@exprtlabs/golem/schema`: `constraintSchema`. `@exprtlabs/golem/schema-graph`: `jsonSchemaBundle` and `codecDeclarationKey`. Both entries are build-time tooling for the generators.
- `@exprtlabs/golem/type-analysis`: `isIModelReference` (use `isModelDeclarationReference(checker, node)`). `@exprtlabs/golem/ts`: `readConfigFile`, `parseConfigFileTextToJson`, `flattenDiagnosticMessageText`, `createSourceFile`, `createProgram` (use `createProgramFromSources`) and the `errors` result of `parseJsonConfigFileContent`. `@exprtlabs/golem/emitter`: `generatedVariant`.

See [installation](docs/guide/install.md) for npm commands and release availability.
