# @exprtlabs/golem

`@exprtlabs/golem` is the runtime for generated models and SDKs, plus the
`golem` command that runs configured generators. Install it in the
application: generated code imports its runtime entry points, and the
observable profile also needs `mobx`.

## Install

Use npm with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem
```

Six calls, such as `parse<T>` and `validate<T>`, need a build host that
rewrites them ([Build your app](../../docs/guide/build.md)).

[Runtime API](../../docs/reference/runtime-api.md) lists every subpath, its
signature and its extra dependency. [Compatibility](../../docs/compatibility.md)
has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
