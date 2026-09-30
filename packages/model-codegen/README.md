# @exprtlabs/model-codegen

Generate model bases from TypeScript `IModel` definitions. Keep methods and
defaults in your handwritten class; the generated companion supplies fields,
conversion metadata and optional validation or MobX support.

## Install

In an ESM TypeScript project with Node.js 22.15 or newer:

```sh
npm install @exprtlabs/codegen@rc ajv ajv-formats
npm install --save-dev @exprtlabs/model-codegen@rc typescript@~7.0.2 ttsc@~0.30.4
```

[Defining models](../../docs/guide/models.md) walks through a declaration,
generation and the handwritten class. [Compatibility and
stability](../../docs/compatibility.md) has supported versions.

MIT License. Copyright (c) 2026 exprtlabs.ai.
