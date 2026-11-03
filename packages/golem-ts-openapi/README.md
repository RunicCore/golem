# @exprtlabs/golem-ts-openapi

`@exprtlabs/golem-ts-openapi` generates an OpenAPI document from NestJS
controllers without starting the application: controller decorators provide
the paths, and TypeScript field types provide the request and response
shapes.

## Install

Add the generator to an existing NestJS project:

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi typescript@~7.1.0-beta
```

An app that registers `NestModelInterceptor` imports `@exprtlabs/golem-ts-openapi/nest` at run time. Install the package in `dependencies` then, and add `extensions: { nest: {} }` to the `ts-openapi` block of `golem.yaml`
([the `nest` extension](https://runiccore.github.io/golem/reference/config.html#nest-extension)).

[OpenAPI from controllers](https://runiccore.github.io/golem/guide/nestjs.html) walks through a
controller.
[Compatibility](https://runiccore.github.io/golem/compatibility.html) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
