# Release notes

Read the highlights of each Golem release.

## 1.1.0

Golem 1.1.0 is a breaking release with a 1.x number. It supports TypeScript 6.0+ and 7.1+, and it drops TypeScript 7.0.

- **Breaking:** TypeScript 7.0 fails at load. Install TypeScript 7.1 or 6, or stay on Golem 1.0 with TypeScript 7.0 ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- Run generation on TypeScript 6.0+ and 7.1+, including 7.1.0-beta ([Compatibility](/compatibility#ts)).
- **Breaking:** each package registers one `golem.yaml` block. Write `model`, `ts-openapi` with `docs`, and `openapi-ts` with `sdks`, in place of `models`, `controllers`, `openapi` and `generators` ([Configuration](/reference/config#blocks), [Register a block](/reference/generator-api#register-a-block)).
- **Breaking:** golem derives the job order from what each job reads and writes ([Job order](/reference/config#job-order)).
- **Breaking:** the `model` block has no `root` key and scans from the folder of `golem.yaml`.
- **Breaking:** a `ts-openapi` docs job has no `root` key. It scans from the folder of `golem.yaml`. If you set another root, move `golem.yaml` there or list `sources` ([Configuration](/reference/config#ts-openapi-block)).
- **Breaking:** a `ts-openapi` docs job has no `framework` key. NestJS is the only framework ([Configuration](/reference/config#ts-openapi-block)).
- **Breaking:** the `openapi-ts` SDK job has no `allowRemoteRefs` key. A non-empty `remoteHosts` list turns on remote references for those hosts only. Without it, the job loads none ([Configuration](/reference/config#openapi-ts-block)).
- **Breaking:** `@exprtlabs/golem-openapi` is renamed `@exprtlabs/golem-openapi-ts`. Install and import it under the new name ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** `@exprtlabs/golem-openapi-ts` and `@exprtlabs/golem-ts-openapi` take `@exprtlabs/golem` as a peer, and `typescript` as an optional peer. Install `typescript` in your project.
- **Breaking:** `golem build` checks and emits inside the `golem` process and starts no `tsc`. It keeps no `.golem/build` stage ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a `golem.yaml` whose tsconfig is a solution file, with only `references`, stops `golem generate` and `golem check`. Name the app's tsconfig, such as `tsconfig.app.json` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** one `golem generate` from a clean tree passes when a model of a `controllers` root imports the SDK of an `openapi` job, and a controller that reaches such a model stops with `RUNM1084` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** golem prints a local file relative to the working directory, not as an absolute path, in errors, warnings and diagnostics ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a TypeScript error that stops generation prints in the compiler's plain form, `src/a.ts(3,7): error TS2322: ...`, as `tsc` prints it without `--pretty`. Before, it printed as `src/a.ts:3:7 - error TS2322: ...` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `FileRewrite` from `@exprtlabs/golem/rewrite` has a required `importsAt` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `@exprtlabs/golem/model` no longer exports `GeneratedModelFields`. Use the derived `T<Name>Fields` type ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `@exprtlabs/golem/manifest` no longer exports `manifestMarker` ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `getObjectCodec` and `getIModelClass` find a model only by its full id. A short model name no longer matches ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a registered codec holds no JSON Schema: `ObjectCodec` loses `schema`, `wireSchema`, `modelOnlySchema` and `wireOnlySchema`, and `@exprtlabs/golem/serde` no longer exports `resolveGeneratedModelSchemaRefs`. Generated model files are smaller, and a generated parse asks a validation context for `Id#wire` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a model class with `@ApiSchema({ name })` is the OpenAPI component of that name ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a route with no response decorator gets an empty description (`""`) on its default response, as Nest Swagger writes. Before, it got `Success`. Regenerate, and update a test that compares the generated document ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** an `allOf` with a property typed `format: date-time` in one member and as a `$ref` to an object in another stops generation. Give the property one type in every member ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a `@Body()` or `@Query()` parameter that `NestModelInterceptor` cannot convert, such as a union of models whose tag the union does not declare, stops generation with `RUNM1081`. To keep your own interceptor, set `nonModelInputs: warn` on the `nest` extension ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** the NestJS part of the rewrite and its `RUNM1081` checks run only when the `ts-openapi` block of `golem.yaml` holds `extensions: { nest: {} }`. A `docs` job alone does not turn them on ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** `NestModelInterceptor` comes from `@exprtlabs/golem-ts-openapi/nest`. `@exprtlabs/golem/nest` is gone. Install `@exprtlabs/golem-ts-openapi` in `dependencies` ([NestJS requests](/guide/nestjs-requests)).
- **Breaking:** MobX is the `mobx` extension of the `openapi-ts` block, `extensions: { mobx: {} }`, and the root key `mobx` is gone. `asGenObservable` and `getValidator` come from `@exprtlabs/golem-openapi-ts/mobx` and `@exprtlabs/golem-openapi-ts/mobx-validation`. `@exprtlabs/golem/mobx` and `@exprtlabs/golem/mobx-validation` are gone. Generated files import the MobX runtime from `@exprtlabs/golem-openapi-ts`, so list that package in `dependencies` ([MobX extension](/reference/config#mobx-extension)).
- **Breaking:** `golem build` and `golem check` also stop with `RUNM1081` on parameters of one handler that `NestModelInterceptor` cannot convert together: an optional one-field parameter or optional whole `@Body()`, a whole and a one-field parameter of one source, parameters that read the same value as different models, and a whole `@Query()` array. `nonModelInputs: warn` on the `nest` extension makes them warnings ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a decorator named `Body`, `Query`, `ApiProperty` or `ApiPropertyOptional` that does not come from `@nestjs/common` or `@nestjs/swagger` is no longer read as one, and neither is a `nestModelCodec`, `nestModelUnion` or `nestModelReturn` that does not come from golem. A NestJS decorator imported under another name or re-exported from another file now is read ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a `controllers` job writes only its OpenAPI document. `src/generated/operation-codecs.ts` is gone, and so are `RUNM1072` and `NEST1313`. Delete the file, and `.golem/outputs.json` too if golem stops on it ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a `TValidation` function that throws, or returns neither a boolean nor a string, makes every checked call throw `LibError` of kind `Validation` with the original error as `cause` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a number format such as `Format<'int64'>` on a `string` model field stops generation with `RUNM1051`. A `number` field now takes `int32`, `int64`, `float` and `double` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a `Map` or `Set` field of a Nest DTO needs an `@ApiProperty()` with `type`, `schema` or `additionalProperties`, or generation stops with `RUNM1086` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a `Map` or `Set` field of a model stops generation with `RUNM1004` also with validation off ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** `golem-openapi-ts` reads a schema with both `oneOf` and `anyOf` as both keywords, not one ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
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
- **Breaking:** an OpenAPI 3.1 document with `discriminator.defaultMapping` stops generation; the keyword is OpenAPI 3.2 only ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** two `@ApiHeader()` names of one operation that differ only in case stop generation with `NEST1312` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- The `controllers` job documents optional and mixed body and query parameters, such as `@Body('payment') payment?: TPayment` and a second whole `@Body()`, and the build tools report the run-time limits. `NEST1103` is removed ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** `int64` and `Integer` values beyond `Number.MAX_SAFE_INTEGER` are rejected, and `MultipleOf` compares exact decimal values ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** `encodeGeneratedModel` and `decodeGeneratedModel` are deleted. Use `toWireFormat<T>` and `fromWireFormat<T>`. `toWireFormat` validates the model when its profile does ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** `@exprtlabs/golem/conversion` and `@exprtlabs/golem/validation-runtime` are no longer public. `@exprtlabs/golem` has 15 public subpaths. The helpers that only generated code calls move to `internal/` runtime entries, so generate again after you update. `isGeneratedModel`, `isGeneratedModelConstructor`, `validateWith` and `ValidationResult` are deleted. `assertAcyclicValue` and `readRootFields` are no longer public; `stringify` and `toWireFormat` reject cyclic input themselves ([Package subpaths](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#package-subpaths)).
- **Breaking:** `golem` commands require `@exprtlabs/golem` at exactly the version of each built-in generator package. An extension package under `generators` keeps its own version. `@exprtlabs/golem/generator-api` stays public as the extension API ([Package subpaths](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#package-subpaths)).
- **Breaking:** a model field of an OpenAPI schema with `enum`, with or without `type`, accepts only the listed values, and the other keywords of the schema, such as `minimum`, `maxLength` and `pattern`, still apply. A field with `type: ['string', 'null']` rejects `null` unless the `enum` lists it, and an empty `enum` accepts no value. A required property whose schema is an empty `enum`, `not: true` or `false` stops generation with `OPENAPI_COMPOSITION_UNSATISFIABLE` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a generated client writes a `style: cookie` array or object parameter that sets no `explode` as one cookie for each item or key, as OpenAPI 3.2 sets `explode` to true for `style: cookie` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- **Breaking:** a model cannot turn validation on above its project. `{ validation: true }` on a model in a project with `validation: false` stops generation with `RUNM1089`, as does `'sanity'` in a project at `false` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** `GolemProfile.validation` has the type `boolean | 'sanity'`, and `resolveProfile` accepts `'sanity'`. A generator must treat `'sanity'` as a level that still validates ([Generation](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#generation)).
- **Breaking:** a `Date` field needs an RFC 3339 `date-time` text with an offset at every validation level, validation off included. A Temporal field accepts only its wire form too, on write as well: `stringify` and `toWireFormat` throw `Serialization` for a value outside it, where validation off once wrote text such as `2025-01-02[u-ca=gregory]` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** the model value of a `Date` or Temporal field is checked with `instanceof`. A value that fails reports an `instance` issue, where a `Date` field reported a `type` issue with `expected: ['Date']`. A `TSerde` class that a `*.model.ts` file declares stops generation with `RUNM1065` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- **Breaking:** a `TSerde` field whose JSON value is a string reads only a string, validation off included ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- `Date` and the Temporal classes are built-in `TSerde` types. A field typed `Date` or `Temporal.Instant` converts with no tag, and a `TSerde` tag on the type replaces the default ([Dates and times](/guide/field-types#dates-and-times)).
- `validation: sanity` checks the shape only. It takes `golem.yaml` and the options of a model, and a call chooses a level with `validate: true | 'sanity' | false` up to the project level. `validate<T>`, `assertValue<T>` and `NestModelInterceptor` take `validate: true | 'sanity'` ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models), [Validation profiles](/reference/config#validation-profiles)).
- Fix: a model with `{ validation: false }` that uses a validation function from its own file no longer stops generation. A shared unnamed object type validates for every model that holds it ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- A recursive model bounds input nesting with `maxDepth` (512 by default); the Nest interceptor answers 400 beyond it ([Models](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#models)).
- The `model-manifest.json` of a generated SDK no longer lists `modelReferences` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- An untagged `anyOf` whose branches state different JSON types checks a value only with the branches of its type.

- **Breaking:** a generated SDK has no model classes, in either mode, and no per-schema functions. The client checks and converts each request and response, and a response body is a plain object of the SDK type with converted dates. Your own `IModel<Charge>` gives a class with methods ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- An `openapi` job takes `mode: standalone | golem`. A standalone SDK (the default) runs alone with a bundled copy of the runtime. A golem mode SDK leaves checks and conversions to the `models` job ([SDK modes](/reference/config#sdk-modes)).
- **Breaking:** the `mobx` extension on a standalone SDK stops generation with `OPENAPI_MOBX_NEEDS_GOLEM_MODE`. Set `mode: golem` ([OpenAPI](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#openapi)).
- The generated client takes a `validate` option for each client and each call, with a level for requests and responses apart ([Lower the checks](/guide/client-usage#lower-the-checks)).

Move an SDK to 1.1 with this table, then generate again:

| Before | Now |
| --- | --- |
| `ChargeModel`, the class of the schema `Charge` | `Charge`, a plain type. For methods, declare your own model: `IModel<Charge>` |
| `ChargeFields` and `ChargeInit` | `Charge`. A request takes `InputSchemas.Charge` |
| `ChargeJSON` | None. The client holds the JSON form inside. For your own model, `WireFormat<T>` names it |
| `parseCharge`, `stringifyCharge`, `fromWireFormatCharge`, `toWireFormatCharge`, `validateCharge`, `assertCharge`, `encodeCharge` | None. The client checks and converts. For your own model, use `parse<T>`, `stringify<T>`, `fromWireFormat<T>`, `toWireFormat<T>`, `validate<T>` and `assertValue<T>` |
| `fromWireFormat<ChargeModel>(response.body)` | `response.body`, which is already a `Charge` with converted dates |
| `toWireFormat<ChargeModel>(charge)` to build a request body | Pass the object. The client writes the JSON form |
| `import { ChargeModel } from './sdk/models/Charge.js'` | `import type { Charge } from './sdk/index.js'` |
| `RUNM1090` for an SDK model in another model | Gone. `IModel<Charge>` and a field of type `Charge` are ordinary models |

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
