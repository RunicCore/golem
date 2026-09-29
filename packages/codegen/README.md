# @exprtlabs/codegen

`@exprtlabs/codegen` is the runtime for generated models and SDKs, plus the
`runic-codegen` command that runs configured generators. Install it in the
application: generated code imports its runtime entry points, and the
validated or observable profile also needs `ajv`/`ajv-formats` or `mobx`.

## Install

Use npm with Node.js 22.12 or newer:

```sh
npm install @exprtlabs/codegen@rc ajv ajv-formats
```

[Runtime API](../../docs/reference/runtime-api.md) lists every subpath, its
signature and its extra dependency. [Compatibility and
stability](../../docs/compatibility.md) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
