# @exprtlabs/golem-model

Generate model bases from TypeScript `IModel` definitions. Keep methods and
defaults in your handwritten class; the generated base supplies fields,
conversion metadata and optional validation or MobX support. Generated files
are not committed: `golem build` generates first
([ignore generated files](../../docs/reference/generated-files.md#gitignore)).

## Install

In an ESM TypeScript project with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem@rc
npm install --save-dev @exprtlabs/golem-model@rc typescript@~7.0.2
```

[Defining models](../../docs/guide/models.md) walks through a declaration,
generation and the handwritten class. [Compatibility and
stability](../../docs/compatibility.md) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
