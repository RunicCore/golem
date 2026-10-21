# @exprtlabs/golem

`@exprtlabs/golem` is the runtime for generated models and SDKs, plus the
`golem` command that runs configured generators. Install it in the
application: generated code imports its runtime entry points, and the
observable profile also needs `mobx`.

## Install

Use npm with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem@rc
```

`parse<T>`, `stringify<T>`, `fromWireFormat<T>`, `toWireFormat<T>`, `validate<T>` and `assertValue<T>` need a
host that rewrites them: `golem build`, the `@exprtlabs/golem/vite` or
`@exprtlabs/golem/esbuild` plugin, or the Node loader
(`node --import @exprtlabs/golem/register`). `golem build` compiles your
project the way `tsc -p` does and rewrites the calls on the way; it generates
first. The plugins and the loader open your project from `golem.yaml` (the
`config` option or `GOLEM_CONFIG`, else `./golem.yaml`) and scan each file
themselves. All of them work on TypeScript 6 and 7
([installation](../../docs/guide/install.md)).

[Runtime API](../../docs/reference/runtime-api.md) lists every subpath, its
signature and its extra dependency. [Compatibility and
stability](../../docs/compatibility.md) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
