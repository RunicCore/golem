# Release notes

## 1.0.0

Golem 1.0.0 brings TypeScript models, NestJS controller contracts and OpenAPI clients into one generation workflow. Install the generators on their own, or combine them in one `golem.yaml`.

- Define [models](/guide/models) in TypeScript, extend the generated base class with your methods, and convert typed wire values with `fromWireFormat` and `toWireFormat` ([JSON conversion](/guide/serialization)).
- [Validate models](/guide/validation) with generated TypeScript validators that run without extra packages. [Tags](/guide/tags) add built-in constraints, predicates and conversion pairs.
- Compose nested models with `Pick`, `Omit` and `Partial` ([field types](/guide/field-types#nested-models-and-derived-types)).
- [Generate typed API clients](/guide/client) with authentication, cancellation, codecs and [streaming responses](/guide/streams).
- Generate an OpenAPI document from NestJS controllers without starting the application ([OpenAPI from controllers](/guide/nestjs)). [Convert requests](/guide/nestjs-requests) with `NestModelInterceptor`.
- Build with [`golem build`](/reference/cli#build), the Vite plugin, the esbuild plugin or the Node loader ([Build your app](/guide/build)).
- Keep generated files current with [`watch`](/guide/watch), or run the read-only `check` command in CI.
- [Share models between apps](/guide/shared-models). Each app generates its own copy.
- Enable [MobX](/guide/mobx) for reactive fields and nested SDK models.
- Run generation on TypeScript 6.0 and later or on 7.x ([Compatibility](/compatibility#ts)).
- Eight tooling subpaths of `@exprtlabs/golem` move under `internal/`, and a path under `internal/` has no stability promise ([public API](/compatibility#public-api)).

Read the [CHANGELOG](https://github.com/RunicCore/golem/blob/master/CHANGELOG.md#100) for every change. To move to this release, follow [Upgrade to 1.0](/migrating).
