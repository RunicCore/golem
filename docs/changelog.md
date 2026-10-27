# Release notes

Read the highlights of each Golem release.

## 1.1.0

Golem 1.1.0 is a breaking release with a 1.x number. It supports TypeScript 6.0+ and 7.1+, and it drops TypeScript 7.0.

- **Breaking:** TypeScript 7.0 fails at load. Install TypeScript 7.1 or 6, or stay on Golem 1.0 with TypeScript 7.0.
- Run generation on TypeScript 6.0+ and 7.1+, including 7.1.0-beta ([Compatibility](/compatibility#ts)).
- **Breaking:** a TypeScript error that stops generation prints in the compiler's plain form, `src/a.ts(3,7): error TS2322: ...`, as `tsc` prints them without `--pretty`. Before, they printed as `src/a.ts:3:7 - error TS2322: ...`.
- An untagged `anyOf` whose branches state different JSON types checks a value only with the branches of its type.

Read the [CHANGELOG](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#unreleased) for every change.

## 1.0.0

Golem 1.0.0 brings TypeScript models, NestJS controller contracts and OpenAPI clients into one generation workflow. Install the generators on their own, or combine them in one `golem.yaml`.

- Define [models](/guide/models) in TypeScript, extend the generated base class with your methods, and convert typed wire values with `fromWireFormat` and `toWireFormat` ([Serialization](/guide/serialization)).
- [Validate models](/guide/validation) with generated TypeScript validators that run without extra packages. [Tags](/guide/tags) add built-in constraints, predicates and conversion pairs.
- Compose nested models with TypeScript utilities such as `Pick` and `Omit` ([field types](/guide/field-types#nested-models-and-derived-types)).
- [Generate typed API clients](/guide/client) with authentication, cancellation, codecs and [streaming responses](/guide/client-usage#streaming-responses).
- Generate an OpenAPI document from NestJS controllers without starting the application ([OpenAPI from controllers](/guide/nestjs)). [NestJS requests](/guide/nestjs-requests) with `NestModelInterceptor`.
- Build with [`golem build`](/reference/cli#build) or another build tool ([Build tools](/guide/build)).
- Keep generated files current with [`watch`](/guide/watch), or run the read-only `check` command in CI.
- [Share models between apps](/guide/shared-models). Each app generates its own copy.
- Enable [MobX](/guide/mobx) for reactive fields and nested SDK models.
- Run generation on TypeScript 6.x or 7.x ([Compatibility](/compatibility#ts)).
- The public subpaths of `@exprtlabs/golem` follow semver, and tooling lives under `internal/` ([public API](/compatibility#public-api)).

Read the [CHANGELOG](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#100) for every change.
