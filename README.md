<img src="docs/public/golem.png" alt="Golem, the project mascot" width="160" align="right">

# ExprtLabs Golem

One toolchain for a TypeScript app's API contract. Write models as
TypeScript types, and Golem generates validation, JSON conversion, OpenAPI
documents and a typed SDK from them. Start from TypeScript models, an
OpenAPI document or NestJS controllers. A build tool rewrites the `parse<T>()`
calls into generated code.

**Documentation:** [runiccore.github.io/golem](https://runiccore.github.io/golem/)

## Install

Use npm with Node.js 22.15 or newer. Put the runtime in application
dependencies and the generator in development dependencies, with the peer
compiler:

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model typescript@~7.1.0-beta
```

Or, for an existing OpenAPI document:

```sh
npm install --save-dev @exprtlabs/golem-openapi-ts typescript@~7.1.0-beta
```

Or, for NestJS controllers only:

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi typescript@~7.1.0-beta
```

An app that registers `NestModelInterceptor` imports
`@exprtlabs/golem-ts-openapi/nest` at run time, so it installs that package
without `--save-dev` ([the `nest` extension](https://runiccore.github.io/golem/reference/config.html#nest-extension)).

An app with the `mobx` extension imports `@exprtlabs/golem-openapi-ts/mobx` at
run time, so it installs that package without `--save-dev`, with `mobx`
([the `mobx` extension](https://runiccore.github.io/golem/reference/config.html#mobx-extension)).

## Packages

| Package | What it does |
| --- | --- |
| [`@exprtlabs/golem`](packages/golem) | Runtime, the `golem` command and the build tools |
| [`@exprtlabs/golem-model`](packages/golem-model) | Models from TypeScript `IModel` and `IObject` types |
| [`@exprtlabs/golem-openapi-ts`](packages/golem-openapi-ts) | A typed SDK from an OpenAPI 3.1 or 3.2 document |
| [`@exprtlabs/golem-ts-openapi`](packages/golem-ts-openapi) | An OpenAPI document from NestJS controllers |

## Documentation

- [What is Golem](https://runiccore.github.io/golem/guide/)
- [Quick start](https://runiccore.github.io/golem/guide/quick-start.html)
- [Build tools](https://runiccore.github.io/golem/guide/build.html)
- [Configuration](https://runiccore.github.io/golem/reference/config.html)
- [Release notes](https://runiccore.github.io/golem/changelog.html)

Report a bug or ask for a feature in [GitHub issues](https://github.com/RunicCore/golem/issues).

MIT License. Copyright (c) 2026 exprtlabs.ai.
