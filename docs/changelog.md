# Release notes

This release candidate brings TypeScript models, NestJS controller contracts
and OpenAPI clients into one generation workflow. Install the generators
independently, or combine them in one `golem.yaml` file.

## What you can build

- Define models in TypeScript, extend generated bases with application methods, and convert typed wire values with `fromWireFormat` / `toWireFormat`. JSON text uses IObject `stringify` / `parse`.
- Validate models before saving and display messages for individual fields. Default validation uses runtime Ajv. Tags add built-in constraints, predicates and conversion pairs.
- Compose nested model values with TypeScript utilities such as `Pick`, `Omit` and `Partial`.
- Precompile model, object-codec and client validators with `ajvStandalone`. Generated checks run without Ajv runtime peers or dynamic compilation.
- Enable MobX for reactive fields and nested SDK models. Your classes initialize observability once in their constructors.
- Generate typed API clients with authentication, cancellation, codecs and streaming responses. Browser clients use native `fetch` by default.
- Keep generated files synchronized with `watch`, or use the read-only `check` command in CI.

The [examples](https://github.com/RunicCore/golem/tree/master/examples) cover each generator independently, combined
generation and optional MobX integration.

## Compatibility {#compatibility}

Supported versions and defaults: [Compatibility and stability](/compatibility).

## Controller contracts and model composition

`@exprtlabs/golem-ts-openapi` generates an OpenAPI document from NestJS
controllers without starting the application. Use it on its own, or pass its
document to the SDK and model generators in the same workflow
([configure controller jobs](/guide/nestjs#configure-and-generate)).

Nested model references keep their classes, and derived types such as
`Omit<TAddress, 'id'>` produce plain objects
([Composing models](/guide/model-composition#nested-models-and-derived-types)).

## Known trade-offs

- Tagged-union encoding dispatches on the tag, measured about 6% slower than class-first dispatch.
- Generation always overwrites the files it owns and deletes stale inventoried outputs.
- A variant shared by two unions yields no union class.
