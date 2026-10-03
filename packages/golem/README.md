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

`parse<T>`, `stringify<T>`, `fromWireFormat<T>` and `toWireFormat<T>` need a
build that rewrites them: `golem build`, the `@exprtlabs/golem/vite` or
`@exprtlabs/golem/esbuild` plugin, or the Node loader
(`node --import @exprtlabs/golem/register`). They work on TypeScript 6 and 7
([installation](../../docs/guide/install.md)).

[Runtime API](../../docs/reference/runtime-api.md) lists every subpath, its
signature and its extra dependency. [Compatibility and
stability](../../docs/compatibility.md) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
