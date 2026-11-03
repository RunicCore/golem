# @exprtlabs/golem-model

Generate model bases from TypeScript `IModel` definitions. Keep methods and
defaults in your handwritten class; the generated base supplies fields,
conversion metadata and optional validation. Generated files
are not committed: `golem build` generates first
([ignore generated files](https://runiccore.github.io/golem/reference/generated-files.html#gitignore)).

## Install

In an ESM TypeScript project with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model typescript@~7.1.0-beta
```

[Define models](https://runiccore.github.io/golem/guide/models.html) walks through a declaration,
generation and the handwritten class.
[Compatibility](https://runiccore.github.io/golem/compatibility.html) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
