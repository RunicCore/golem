# What is Golem

Choose the Golem package you need and see how the parts work together.

## Which package you need

Each generator installs on its own and runs through the same `golem` command and `golem.yaml` file. The command and its configuration file are named `golem`. The packages are published under `@exprtlabs`.

| You have | Generator | You get |
| --- | --- | --- |
| TypeScript fields and app behavior | [`@exprtlabs/golem-model`](/guide/models) | A generated class with validation and JSON conversion |
| An OpenAPI document | [`@exprtlabs/golem-openapi`](/guide/client) | Typed operations, request and response models |
| NestJS controllers | [`@exprtlabs/golem-ts-openapi`](/guide/nestjs) | An OpenAPI document from routes and types |
| An OpenAPI document and app models | [`golem-openapi` and `golem-model`](/guide/models-and-client) | App models that reuse the SDK's types |

NestJS is not required. Every generated model and client imports the runtime package `@exprtlabs/golem` ([Install](/guide/install#packages-for-each-generator)).

## IObject or IModel

An `IObject` declares fields whose values stay plain objects. An `IModel` is an `IObject` plus a generated class, such as `TTaskBaseModel`, that your class extends to add methods ([Define models](/guide/models#iobject-or-imodel)).

## How it works

<HowItWorks />

1. The TypeScript type checker reads your `IObject` and `IModel` declarations, including tags such as `MinLength<3>`, `TValidation` and `TSerde`.
2. Golem turns those types into JSON Schema: the full model and JSON schemas, plus the smaller checks that run after conversion.
3. Golem compiles the schemas into validators, written as TypeScript beside the generated code.
4. Golem writes the generated class, its JSON conversion and its types beside your file.
5. A build host rewrites calls such as `parse<T>` to that generated conversion when you build or load your code ([Build your app](/guide/build)).

## How each generator uses these steps

| Generator | Reads | Then |
| --- | --- | --- |
| `@exprtlabs/golem-model` | Your `IObject` and `IModel` declarations | Runs steps 1 to 5 |
| `@exprtlabs/golem-openapi` | An OpenAPI 3.1 or 3.2 document | Resolves its `$ref`s across local files and the HTTPS hosts you allow, checks it against the official OpenAPI schema and the cross-field rules of the specification, then runs steps 2 to 4 to build a typed SDK |
| `@exprtlabs/golem-ts-openapi` | NestJS controllers and their types, without starting the app | Writes an OpenAPI document |

## What you need

Golem supports the Node.js and TypeScript versions in [Compatibility](/compatibility). Validation is on and MobX is off by default.
