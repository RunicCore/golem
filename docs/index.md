---
layout: home
hero:
  name: Golem
  text: 'Write the type once. <span class="clip">Generate the rest.</span>'
  tagline: One toolchain for a TypeScript app's API contract, end to end. Models, validation, JSON conversion, OpenAPI documents and typed API clients come from the types you already write.
  actions:
    - theme: brand
      text: Quick start →
      link: /guide/quick-start
    - theme: alt
      text: What is Golem
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/RunicCore/golem
features:
  - title: All in one
    details: One CLI, one <code>golem.yaml</code> and one runtime package cover models, validation, JSON, OpenAPI and clients.
    link: /reference/config
    linkText: Configuration
  - title: TypeScript is the schema
    details: Tags on a field's type drive both its validation, such as <code>string & MinLength&lt;2&gt;</code>, and its JSON form, with <code>TSerde</code>. No decorators, no schema language, no second copy of your fields.
    link: /guide/tags
    linkText: Type tags
  - title: Fast
    details: Parsing, stringifying and validation run as generated code, with no decorator metadata or reflection at runtime.
    link: /guide/serialization
    linkText: Serialization
  - title: Your code survives regeneration
    details: Generation owns the generated class, <code>TTaskBaseModel</code>. Your class, <code>Task</code>, extends it and keeps its methods.
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

A typical TypeScript API stack assembles a library for each job and keeps their declarations in sync by hand. Golem reads the types you already write and generates every piece from them.

| Job | Usually | With Golem |
| --- | --- | --- |
| Classes from JSON | class-transformer | `parse<Task>(text)` |
| Validation | class-validator decorators or a Zod schema | tags on the field type |
| Custom wire formats | hand-written mappers | a serde tag on the field type |
| OpenAPI from NestJS | `@ApiProperty` on every DTO field | read from the controller's types |
| API client | openapi-generator or orval | typed operations with validated models |

## Start where you are

- Have TypeScript types? Generate [models](/guide/models) with validation and JSON conversion.
- Have an OpenAPI document? Generate a [typed client](/guide/client).
- Have NestJS controllers? Generate the [OpenAPI document](/guide/nestjs) from them, then the client.

Golem runs on TypeScript 6 or 7 and Node.js 22.15 or newer ([Installation](/guide/install)).

## Your types are the schema

`MinLength`, `Pattern` and `MaxLength` are types. Golem turns them into validation, OpenAPI constraints and client-side checks. An `IObject` stays a plain object; an `IModel` also gets a generated class ([IObject or IModel](/guide/models#iobject-or-imodel)).

<<< ../examples/payments/server/src/payment.model.ts#payment-types

## One model, start to finish

Declare the fields, run `npx golem generate`, then extend the generated class. Generation rewrites `task.model.generated.ts`, a file you can leave out of git, and never touches your class.

::: code-group

<<< ../examples/models/src/task.model.ts#model-definition [task.model.ts]

<<< ../examples/models/src/priority-word.ts#priority-word [priority-word.ts]

<<< ../examples/models/src/task-app.ts [task-app.ts]

:::

`priority` is a number in your class and a word in JSON. `TSerde` names the two functions that convert it, and validation checks the word before your decoder runs.

## One contract, backend to frontend

The controller returns plain types. The server configuration writes the OpenAPI document from the controller; the web configuration builds the SDK from it and your models.

::: code-group

<<< ../examples/payments/server/src/payments.controller.ts#create-payment [payments.controller.ts]

<<< ../examples/payments/server/golem.yaml#controllers-job [golem.yaml]

<<< ../examples/payments/web/src/submit-payment.ts#payment-client [submit-payment.ts]

:::

`@ApiOperation` is optional. Without it, the operation ID is `PaymentsController_create` and the client method is `paymentsController_create()`.

## Get started

Golem needs Node.js 22.15 or newer and TypeScript 6 or 7. `golem build` compiles your project the way `tsc -p` does and rewrites `parse<T>()` on the way; `golem generate` writes the generated code your editor and bundler need. The Vite or esbuild plugin, or the Node loader, can rewrite the calls instead ([Installation](/guide/install)).

```bash
npm install @exprtlabs/golem@rc
npm install --save-dev @exprtlabs/golem-model@rc typescript@~7.0.2
```

The [quick start](/guide/quick-start) takes one model from declaration to JSON.
