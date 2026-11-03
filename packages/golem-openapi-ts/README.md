# @exprtlabs/golem-openapi-ts

`@exprtlabs/golem-openapi-ts` turns an OpenAPI 3.1 or 3.2 document into a
TypeScript SDK: typed operations, request and response models, and a
`model-manifest.json` for `@exprtlabs/golem-model` consumers. It works
independently of the other generators and does not start or host the API.

## Install

Use npm with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-openapi-ts typescript@~7.1.0-beta
```

MobX is the `mobx` extension of the `openapi-ts` block. An app that uses it
installs this package in `dependencies`, with `mobx`, and imports
`@exprtlabs/golem-openapi-ts/mobx`
([MobX extension](https://runiccore.github.io/golem/reference/config.html#mobx-extension)).

[Generate an SDK](https://runiccore.github.io/golem/guide/client.html) walks through calling the
generated SDK. [Compatibility](https://runiccore.github.io/golem/compatibility.html) has supported
versions. Feature support by OpenAPI version and profile is in
[MATRIX.md](MATRIX.md); third-party attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MIT License. Copyright (c) 2026 exprtlabs.ai.
