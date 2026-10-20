# Release notes

This release candidate brings TypeScript models, NestJS controller contracts
and OpenAPI clients into one generation workflow. Install the generators
independently, or combine them in one `golem.yaml` file.

## What you can build

- Define models in TypeScript, extend generated bases with application methods, and convert typed wire values with `fromWireFormat` / `toWireFormat`. JSON text uses IObject `stringify` / `parse`.
- Validate models before saving and display messages for individual fields. Golem generates the validators. Tags add built-in constraints, predicates and conversion pairs.
- Compose nested model values with TypeScript utilities such as `Pick`, `Omit` and `Partial`.
- Generated validators are TypeScript files that run without extra packages or dynamic compilation.
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

## TypeScript 6 and 7

Generation runs on TypeScript 6.0+ or 7.x, chosen from the `typescript` installed in your project, and writes the same files on both ([Compatibility](/compatibility)). `parse<T>`, `stringify<T>` and the other generic serde calls work on both. TypeScript 5 isn't supported.

- **Breaking:** `@exprtlabs/golem/ts` publishes Golem-owned types narrowed to what Golem uses. Its declarations no longer reference `typescript`, and it no longer exports the `API` class or the TypeScript 7 process-client types ([`ts`](/reference/runtime-api#ts)).
- Union members in generated types and schemas appear in a fixed order that doesn't depend on the compiler or locale. Regenerate once; member order changes, and so do the ids of generated codecs.
- Golem sorts names, keys and imports by code unit, so the same sources write byte-identical files under any machine locale. Regenerate once: an order that followed your locale changes. Fields such as `eTag` and `email` swap places, so the ids of generated codecs and the `_group-` file names of an SDK change too.
- On TypeScript 7, generation type-checks new files before writing them, so output that doesn't compile now fails with the compiler's message. Sibling model folders under one `tsconfig` no longer interfere.

## Validation

- **Breaking:** Ajv is removed. Remove `ajv` and `ajv-formats` from your dependencies. The `@exprtlabs/golem/ajv` and `@exprtlabs/golem/ajv-tooling` subpaths, `OpenApiAjvOptions` and the engine functions are gone, and `ajvStandalone` is now an unknown key in `golem.yaml`. golem checks `byte`, `json-pointer` and `relative-json-pointer`; `uri-template`, `url`, `iso-time` and `iso-date-time` now warn and are not checked. Regenerate every SDK from an older release, or remove it ([Migrating to 1.0](/migrating#validation)).
- **Breaking:** issue codes describe the kind of failure, such as `tooSmall`, `literal` and `unknownKey`, with typed fields and new default messages ([mapping](/migrating#issues)). `IssueCode` is a string-union type, no longer an enum, and the HTTP 400 body of a NestJS application carries the new issue shape.
- **Breaking:** `NestModelInterceptor` throws a `TypeError`, and Nest answers HTTP 500, for a `@Body()` or `@Query()` parameter that is not an `IModel` or `IObject`, whole or one field. A one-field parameter with a model type now converts that field, and HTTP 400 answers a missing or invalid field. An array `@Body()` of models now converts item by item (it answered HTTP 400 for every valid request), and `nestModelCodec(id, array?)` takes an optional `array` argument ([Migrating to 1.0](/migrating#runtime)).
- **Breaking:** validators are generated TypeScript files, `ValidationRuleResult` takes `{ message }`, `ModelValidationContext` is `{ resolve }`, and the client's `operationValidators` overrides are `Validator` functions ([Migrating to 1.0](/migrating#validation)).
- `golem.yaml` gains `unknownFormats: warn | error` ([configuration](/reference/config#root-keys)).

## golem build and the rewrite hosts

- **Breaking:** `ttsc` and the Go plugin are removed, with their subpaths and peer dependency. Replace `ttsc` with [`golem build`](/reference/cli#build), the [Vite](/reference/runtime-api#vite) or [esbuild](/reference/runtime-api#esbuild) plugin, or the [Node loader](/reference/runtime-api#loader), and delete the `plugins` entry from `tsconfig.json` ([Migrating to 1.0](/migrating)).
- **Breaking:** `golem.yaml` gains [`tsconfig:`](/reference/config#root-keys) and is the entry point for `golem build`.
- `golem build` generates first, type-checks your original sources so errors point at your lines, and emits like `tsc`: it emits after type errors unless `noEmitOnError` is set. It passes every other argument to `tsc` and rejects the few it sets itself ([build](/reference/cli#build)).
- **Breaking:** the codec keys of your models move to `.golem/codec-keys.json`, and the `model-manifest.json` of an SDK gains a `codecId` for each model. Regenerate your SDKs.
- Generated files need not be committed: ignore the generated files and `.golem/` together, or commit the generated files with `.golem/outputs.json` and `.golem/codec-keys.json` ([what to commit](/reference/generated-files#gitignore)). A second build with no change runs no job.
- The loader and the plugins open your project from `golem.yaml` (the `config` option, `GOLEM_CONFIG`, or `./golem.yaml`) and scan each file themselves, and `@exprtlabs/golem/rewrite` exports `applyRewrites` ([runtime API](/reference/runtime-api#rewrite)).
- **Breaking:** a shared folder works like an installed package. Golem generates only for model files inside `models.root` and writes nothing into a shared folder. The layer `models.generated.ts`, `#golem-models` and `.golem.lock` are gone, and each generated model file imports only its own validators. Regenerate once, and delete old generated files in shared folders by hand ([shared folder](/reference/config#a-folder-shared-by-several-apps)).
- `models.suffixes` and `controllers[].suffixes` set the file endings golem reads ([configuration](/reference/config#typescript-models)).
- Generation stops only on a type error in a model source or in a file it writes; `tsc` and `golem build` report the others.
- Known limits: a NestJS app needs a decorator-compiling loader after golem's when it runs through the Node loader; `preserveSymlinks` with a symlinked workspace package fails at run time; a generator that lists `watchInputs` it does not announce runs every time.
- A TypeScript 7 watch no longer loses a `tsconfig` edit made during a build.
- `golem --help`, and `generate` and `check` on a configuration with no `models` or `controllers` job, run without TypeScript installed.

## Known trade-offs

- Tagged-union encoding dispatches on the tag, measured about 6% slower than class-first dispatch.
- Generation always overwrites the files it owns and deletes stale inventoried outputs.
- A variant shared by two unions yields no union class.
