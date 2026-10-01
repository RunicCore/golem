# @exprtlabs/golem

`@exprtlabs/golem` is the runtime for generated models and SDKs, plus the
`golem` command that runs configured generators. Install it in the
application: generated code imports its runtime entry points, and the
validated or observable profile also needs `ajv`/`ajv-formats` or `mobx`.

## Install

Use npm with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
```

`parse<T>`, `stringify<T>`, `fromWireFormat<T>` and `toWireFormat<T>` need
TypeScript 7 and `ttsc` 0.30, which run the `@exprtlabs/golem/ttsc-plugin`
compiler plugin ([installation](../../docs/guide/install.md)).

[Runtime API](../../docs/reference/runtime-api.md) lists every subpath, its
signature and its extra dependency. [Compatibility and
stability](../../docs/compatibility.md) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
