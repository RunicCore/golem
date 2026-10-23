<img src="docs/public/golem.png" alt="Golem, the project mascot" width="160" align="right">

# ExprtLabs Golem

One toolchain for a TypeScript app's API contract. Write models as
TypeScript types, and Golem generates validation, JSON conversion, OpenAPI
documents and typed API clients from them. Start from TypeScript models, an
OpenAPI document or NestJS controllers. A build host rewrites the `parse<T>()`
calls into generated code ([Build your app](docs/guide/build.md)).

## Install

Use npm with Node.js 22.15 or newer. Put the runtime in application
dependencies and the generator in development dependencies, with the peer
compiler:

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model typescript@~7.0.2
```

Or, for an existing OpenAPI document:

```sh
npm install --save-dev @exprtlabs/golem-openapi typescript@~7.0.2
```

Or, for NestJS controllers only:

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi typescript@~7.0.2
```

## Documentation

- [What is Golem](docs/guide/index.md)
- [Quick start](docs/guide/quick-start.md)
- [Install](docs/guide/install.md)
- [Build your app](docs/guide/build.md)
- [Configuration](docs/reference/config.md)

MIT License. Copyright (c) 2026 exprtlabs.ai.
