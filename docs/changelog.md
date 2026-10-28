# Release notes

Read the highlights of each Golem release.

## 1.1.0

Golem 1.1.0 is a breaking release with a 1.x number. It supports TypeScript 6.0+ and 7.1+, and it drops TypeScript 7.0.

- **Breaking:** TypeScript 7.0 fails at load. Install TypeScript 7.1 or 6, or stay on Golem 1.0 with TypeScript 7.0 ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- Run generation on TypeScript 6.0+ and 7.1+, including 7.1.0-beta ([Compatibility](/compatibility#ts)).
- **Breaking:** `golem build` checks and emits inside the `golem` process and starts no `tsc`. It keeps no `.golem/build` stage ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a `golem.yaml` whose tsconfig is a solution file, with only `references`, stops `golem generate` and `golem check`. Name the app's tsconfig, such as `tsconfig.app.json` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** one `golem generate` from a clean tree passes when a model of a `controllers` root imports the SDK of an `openapi` job, and a controller that reaches such a model stops with `RUNM1084` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** golem prints a local file relative to the working directory, not as an absolute path, in errors, warnings and diagnostics ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a TypeScript error that stops generation prints in the compiler's plain form, `src/a.ts(3,7): error TS2322: ...`, as `tsc` prints it without `--pretty`. Before, it printed as `src/a.ts:3:7 - error TS2322: ...` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `FileRewrite` from `@exprtlabs/golem/rewrite` has a required `importsAt` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `@exprtlabs/golem/model` no longer exports `GeneratedModelFields`. Use the derived `T<Name>Fields` type ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `@exprtlabs/golem/manifest` no longer exports `manifestMarker` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `getObjectCodec`, `getIModelClass`, `requireObjectCodec`, `requireIModelClass` and `registerIModelClass` find a model only by its full id. A short model name no longer matches ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a model class with `@ApiSchema({ name })` is the OpenAPI component of that name ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a route with no response decorator gets an empty description (`""`) on its default response, as Nest Swagger writes. Before, it got `Success`. Regenerate, and update a test that compares the generated document ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** an `allOf` with a property typed `format: date-time` in one member and as a `$ref` to an object in another stops generation. Give the property one type in every member ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a `@Body()` or `@Query()` parameter that `NestModelInterceptor` cannot convert, such as a union of models with no shared tag, stops generation with `RUNM1081`. To keep your own interceptor, set `nonModelInputs: warn` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a `TValidation` function that throws, or returns neither a boolean nor a string, makes every checked call throw `LibError` of kind `Validation` with the original error as `cause` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a number format such as `Format<'int64'>` on a `string` model field stops generation with `RUNM1051`. A `number` field now takes `int32`, `int64`, `float` and `double` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a `Map` or `Set` field of a Nest DTO needs an `@ApiProperty()` with `type`, `schema` or `additionalProperties`, or generation stops with `RUNM1086` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a `Map` or `Set` field of a model stops generation with `RUNM1004` also with validation off ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** `golem-openapi` reads a schema with both `oneOf` and `anyOf` as both keywords, not one ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a `security` requirement that names an undeclared scheme stops generation ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** the generated client rejects a numeric response header that is not a plain number ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** `parse<T>(...args)` of a model class with a spread before the options stops the build with `RUNM1079` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** with validation on, an object keyed by a template literal type rejects a key outside the template, and a key type that golem cannot state as one pattern stops generation with `RUNM1004` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** with validation on, a tuple with fixed elements after its rest element stops generation with `RUNM1021` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** template index signatures of different value types in one object stop generation with `RUNM1004` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** models of one name and different schemas in files or folders whose names read alike stop generation with `RUNM1005` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a model union of two or more objects declares its tag key with `Discriminator<'kind'>`; golem never looks for it. An untagged union stops with `RUNM1080` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** the controllers document writes a union's `discriminator` from the tag only, and a Nest union parameter needs the tag ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a template index signature beside a `string` index signature of another value type stops generation with `RUNM1004` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- The `model-manifest.json` of a generated SDK no longer lists `modelReferences` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- An untagged `anyOf` whose branches state different JSON types checks a value only with the branches of its type.

Read the [CHANGELOG](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#unreleased) for every change.

## 1.0.0

Golem 1.0.0 brings TypeScript models, NestJS controller contracts and an OpenAPI to TypeScript SDK into one generation workflow. Install the generators on their own, or combine them in one `golem.yaml`.

- Define [models](/guide/models) in TypeScript, extend the generated base class with your methods, and convert typed JSON values with `fromWireFormat` and `toWireFormat` ([Serialization](/guide/serialization)).
- [Validate models](/guide/validation) with generated TypeScript validators that run without extra packages. [Tags](/guide/tags) add built-in constraints, predicates and conversion pairs.
- Compose nested models with TypeScript utilities such as `Pick` and `Omit` ([field types](/guide/field-types#nested-models-and-derived-types)).
- [Generate a typed SDK from OpenAPI](/guide/client) with authentication, cancellation, codecs and [streaming responses](/guide/client-usage#streaming-responses).
- Generate an OpenAPI document from NestJS controllers without starting the application ([OpenAPI from controllers](/guide/nestjs)). [NestJS requests](/guide/nestjs-requests) with `NestModelInterceptor`.
- Build with [`golem build`](/reference/cli#build) or another build tool ([Build tools](/guide/build)).
- Keep generated files current with [`watch`](/guide/watch), or run the read-only `check` command in CI.
- [Share models between apps](/guide/shared-models). Each app generates its own copy.
- Enable [MobX](/guide/mobx) for reactive fields and nested SDK models.
- Run generation on TypeScript 6.x or 7.x ([Compatibility](/compatibility#ts)).
- The public subpaths of `@exprtlabs/golem` follow semver, and tooling lives under `internal/`. `@exprtlabs/golem/cli` is removed; run the `golem` command ([public API](/compatibility#public-api)).

Read the [CHANGELOG](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#100) for every change.
