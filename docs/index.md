---
layout: home
hero:
  name: Codegen
  text: 'Write the type once. <span class="clip">Generate the rest.</span>'
  tagline: One TypeScript-first toolchain for models, validation, JSON conversion, OpenAPI documents and typed API clients.
  actions:
    - theme: brand
      text: Quick start →
      link: /guide/quick-start
    - theme: alt
      text: What is Codegen
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/exprtlabs/codegen
features:
  - title: All in one
    details: One CLI, one <code>runic-codegen.yaml</code> and one runtime package cover models, validation, JSON, OpenAPI and clients.
    link: /reference/config
    linkText: Configuration
  - title: TypeScript is the schema
    details: Constraints are types, such as <code>string & MinLength&lt;2&gt;</code>. No decorators, no schema language, no second copy of your fields.
    link: /guide/tags
    linkText: Type tags
  - title: Fast
    details: Parsing, stringifying and validation run as generated code, with no decorator metadata or reflection at runtime.
    link: /guide/serialization
    linkText: Serialization
  - title: Your code survives regeneration
    details: Generation owns the generated class, <code>TaskBase</code>. Your class, <code>Task</code>, extends it and keeps its methods.
    link: /guide/models
    linkText: Defining models
  - title: Types end to end
    details: NestJS controllers produce the OpenAPI document. The client generator turns it back into typed operations and models.
    link: /guide/nestjs
    linkText: Generate OpenAPI
  - title: Validated by default
    details: Validation is on for models and for client requests and responses. Turn on MobX when React needs observable models.
    link: /guide/validation
    linkText: Validation
---

## One toolchain instead of a stack

A typical TypeScript API stack assembles a library for each job and keeps their declarations in sync by hand. Codegen reads the types you already write and generates every piece from them.

| Job | Usually | With Codegen |
| --- | --- | --- |
| Classes from JSON | class-transformer | `parse<Task>(text)` |
| Validation | class-validator decorators or a Zod schema | tags on the field type |
| Custom wire formats | hand-written mappers | a serde tag on the field type |
| OpenAPI from NestJS | `@ApiProperty` on every DTO field | read from the controller's types |
| API client | openapi-generator or orval | typed operations with validated models |

## Your types are the schema

`MinLength`, `Pattern` and `MaxLength` are types. Codegen turns them into validation, OpenAPI constraints and client-side checks. An `IObject` stays a plain object; an `IModel` also gets a generated class ([IObject or IModel](/guide/models#iobject-or-imodel)).

<<< ../examples/nest-openapi/src/payment.model.ts#payment-types

## One model, start to finish

Declare the fields, run `npx runic-codegen generate`, then extend the generated class. Generation rewrites `task.model.generated.ts` and never touches your class.

::: code-group

<<< ../examples/model/src/task.model.ts#model-definition [task.model.ts]

<<< ../examples/model/src/task-app.ts [task-app.ts]

:::

`priority` is a number in your class and a word in JSON. `TSerde` names the two functions that convert it, and validation checks the word before your decoder runs.

## One contract, backend to frontend

The controller returns plain types. One `generate` run writes the OpenAPI document, the SDK built from it and your models.

::: code-group

<<< ../examples/nest-openapi/src/payments.controller.ts#create-payment [payments.controller.ts]

<<< ../examples/nest-openapi/runic-codegen.yaml [runic-codegen.yaml]

<<< ../examples/nest-openapi/src/client.ts#payment-client [client.ts]

:::

`@ApiOperation` is optional. Without it, the operation ID is `PaymentsController_create` and the client method is `paymentsController_create()`.

## Get started

Codegen needs Node.js 22.12 or newer, TypeScript 7 and `ttsc` 0.30. The generator writes the JSON conversion code; the `ttsc` plugin points your `parse` and `toWireFormat` calls at it when you compile ([Installation](/guide/install)).

```bash
npm install @exprtlabs/codegen@rc ajv ajv-formats
npm install --save-dev @exprtlabs/model-codegen@rc typescript@~7.0.2 ttsc@~0.30.4
```

The [quick start](/guide/quick-start) takes one model from declaration to JSON.
