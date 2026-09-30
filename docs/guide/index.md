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

You declare data in one of two ways. An `IObject` is a field declaration whose values stay plain objects; Golem generates validation and JSON conversion for it. An `IModel` is an IObject plus a generated class, such as `TaskBase`, that your class extends to add methods ([IObject or IModel](/guide/models#iobject-or-imodel)).

## How it works

<HowItWorks />

1. The TypeScript 7 type checker reads your `IObject` and `IModel` declarations, including tags such as `MinLength<3>`, `TValidation` and `TSerde`.
2. Golem turns those types into JSON Schema: the full model and JSON schemas, plus the smaller checks that run after conversion.
3. [Ajv](https://github.com/ajv-validator/ajv) compiles the schemas into validators, at run time or ahead of time. Ahead-of-time validators are bundled into the generated code.
4. Golem writes the generated class, its JSON conversion and its types beside your file.
5. The [ttsc](https://github.com/samchon/ttsc) plugin rewrites `parse<T>`, `stringify<T>`, `fromWireFormat<T>` and `toWireFormat<T>` calls to that generated conversion when you compile.

For an OpenAPI 3.1 or 3.2 document, Golem resolves its `$ref`s across local files (and allowed HTTPS hosts), checks it against the official OpenAPI schema and the specification's cross-field rules, then runs the same schema and Ajv steps. For NestJS, Golem reads controllers and their types without starting the app and writes an OpenAPI document.

## Requirements

You need Node.js 22.15 or newer, TypeScript 7 and `ttsc` ([requirements](/guide/install#requirements)). Validation is on and MobX is off by default.

## Planned features

- **Data structure catalog.** A structured document built from your `IObject` and `IModel` declarations, so you can browse and review the main data interfaces and classes in your code: DTOs, models, entities. A later step adds classification by Jev, a classifier model, and review by another AI reviewer.
- **Official TypeScript API.** Golem moves from the `ttsc` plugin to TypeScript's own code generation API once TypeScript supports it.

## Special thanks

- [ttsc](https://github.com/samchon/ttsc) runs the compiler plugin that connects your calls to the generated code.
- [Ajv](https://github.com/ajv-validator/ajv) compiles and runs every validator.

## Common questions

**Do I need NestJS?** No; each generator installs on its own.

**Can I compile with `tsc`?** Generated classes and `validateInstance` work, but `parse<T>`, `stringify<T>`, `fromWireFormat<T>` and `toWireFormat<T>` need the `ttsc` plugin; without it they throw at runtime.

**Why TypeScript 7?** The generators read your types with the TypeScript 7 type checker.
