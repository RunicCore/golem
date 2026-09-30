# @exprtlabs/openapi-to-ts

`@exprtlabs/openapi-to-ts` turns an OpenAPI 3.1 or 3.2 document into a
TypeScript SDK: typed operations, request and response models, and a
`model-manifest.json` for `@exprtlabs/model-codegen` consumers. It works
independently of the other generators and does not start or host the API.

## Install

Use npm with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/codegen@rc ajv ajv-formats
npm install --save-dev @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4
```

[Generate a client](../../docs/guide/client.md) walks through calling the
generated SDK. [Compatibility and stability](../../docs/compatibility.md) has
supported versions. Feature support by OpenAPI version and profile is in
[MATRIX.md](MATRIX.md); third-party attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MIT License. Copyright (c) 2026 exprtlabs.ai.
