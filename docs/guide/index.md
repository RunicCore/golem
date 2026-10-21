# What is Golem

Golem turns TypeScript declarations, OpenAPI documents and NestJS controllers into typed models, clients and API documents.

## Which generator you need

Each generator installs on its own and runs through the same `golem` command and `golem.yaml` file. The command and its configuration file are named `golem`; the packages are published under `@exprtlabs`.

| You have | Generator | You get |
| --- | --- | --- |
| TypeScript fields and app behavior | [`@exprtlabs/golem-model`](/guide/models) | A generated class with validation and JSON conversion |
| An OpenAPI document | [`@exprtlabs/golem-openapi`](/guide/client) | Typed operations, request and response models |
| NestJS controllers | [`@exprtlabs/golem-ts-openapi`](/guide/nestjs) | An OpenAPI document from routes and types |
| An OpenAPI document and app models | [`golem-openapi` and `golem-model`](/guide/models-and-client) | App models that reuse the SDK's types |

## IObject or IModel

You declare data in one of two ways. An `IObject` is a field declaration whose values stay plain objects; Golem generates validation and JSON conversion for it. An `IModel` is an IObject plus a generated class, such as `TTaskBaseModel`, that your class extends to add methods ([IObject or IModel](/guide/models#iobject-or-imodel)).

## How it works

<HowItWorks />

1. The TypeScript type checker reads your `IObject` and `IModel` declarations, including tags such as `MinLength<3>`, `TValidation` and `TSerde`.
2. Golem turns those types into JSON Schema: the full model and JSON schemas, plus the smaller checks that run after conversion.
3. Golem compiles the schemas into validators, written as TypeScript beside the generated code.
4. Golem writes the generated class, its JSON conversion and its types beside your file.
5. `golem build`, the Vite or esbuild plugin, or the Node loader rewrites `parse<T>`, `stringify<T>`, `fromWireFormat<T>`, `toWireFormat<T>`, `validate<T>` and `assertValue<T>` calls to that generated conversion when you build or load your code.

For an OpenAPI 3.1 or 3.2 document, Golem resolves its `$ref`s across local files (and allowed HTTPS hosts), checks it against the official OpenAPI schema and the specification's cross-field rules, then runs the same schema and validator steps. For NestJS, Golem reads controllers and their types without starting the app and writes an OpenAPI document.

## Requirements

You need Node.js 22.15 or newer and TypeScript 6 or 7 ([requirements](/guide/install#requirements)). Validation is on and MobX is off by default.

## Planned features

- **Data structure catalog.** A structured document built from your `IObject` and `IModel` declarations, so you can browse and review the main data interfaces and classes in your code: DTOs, models, entities. A later step adds classification by Jev, a classifier model, and review by another AI reviewer.

## Common questions

**Do I need NestJS?** No; each generator installs on its own.

**Can I compile with `tsc`?** Generated classes and `validateInstance` work, but `parse<T>`, `stringify<T>`, `fromWireFormat<T>`, `toWireFormat<T>`, `validate<T>` and `assertValue<T>` need a build that rewrites them (`golem build`, the Vite or esbuild plugin, or the Node loader); without one they throw at runtime.

**Which TypeScript?** The generators read your types with the TypeScript 6 or 7 type checker installed in your project, and write the same files on both.
