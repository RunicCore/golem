# @exprtlabs/golem

`@exprtlabs/golem` is the runtime for generated models and SDKs, plus the
`golem` command that runs configured generators. Install it in the
application: generated code imports its runtime entry points.

## Install

Use npm with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem
```

Six calls, such as `parse<T>` and `validate<T>`, need a build tool that
rewrites them ([Build tools](https://runiccore.github.io/golem/guide/build.html)).

[Runtime API](https://runiccore.github.io/golem/reference/runtime-api.html) lists every subpath, its
signature and its extra dependency. [Compatibility](https://runiccore.github.io/golem/compatibility.html)
has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
