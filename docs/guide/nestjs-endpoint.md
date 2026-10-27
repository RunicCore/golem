# Add Golem to a NestJS API

Add Golem to a NestJS 11 API for a checked body, HTTP 400 for bad input and an OpenAPI document, while NestJS builds the endpoint.

## What golem does for an endpoint

You declare the body once, as a TypeScript type with tags. Golem uses that one type in three places:

| Place | What golem does |
| --- | --- |
| The request | `NestModelInterceptor` converts and validates `@Body()` before the handler runs. Bad input gets HTTP 400. |
| The handler | It receives a valid model, not raw JSON. |
| The OpenAPI document | The `controllers` job reads the controller and the type. It writes the document, and the tags become OpenAPI keywords. |

The steps build `POST /api/payments/transactions` from [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments). For your own `POST /orders`, use the names `OrdersController` and `TOrderInput`.

## Step 1: Install the packages

```sh
npm install @exprtlabs/golem @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/swagger reflect-metadata rxjs
npm install --save-dev @exprtlabs/golem-model @exprtlabs/golem-ts-openapi typescript@~7.1.0-beta
```

| Package | Why you need it |
| --- | --- |
| `@exprtlabs/golem` | The `golem` command, and the runtime that holds `NestModelInterceptor` |
| `@exprtlabs/golem-model` | Generates the files of your models |
| `@exprtlabs/golem-ts-openapi` | Generates the OpenAPI document from your controllers |
| `@nestjs/swagger` | The `Api…` decorators that the `controllers` job reads |
| `typescript` | The compiler that the generators and `golem build` use |

Check the [requirements](/guide/quick-start#requirements) and add `"type": "module"` to `package.json`.

## Step 2: Set up TypeScript

Use these options in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "rootDir": ".",
    "outDir": ".build"
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

- `experimentalDecorators` and `emitDecoratorMetadata` are the two options that NestJS needs.
- `outDir` is where `golem build` writes the JavaScript that Node runs ([what the tsconfig needs](/reference/cli#what-the-tsconfig-needs)).
- With `NodeNext`, relative imports end in `.js`, also for generated files.
- Import `reflect-metadata` first in the entry file, before any application module. Step 5 shows the line.
- To run the TypeScript files with the Node loader, use `experimentalDecorators` and `emitDecoratorMetadata`. The loader compiles the decorators ([run with the Node loader](/guide/nestjs-requests#run-with-the-node-loader)).

## Step 3: Declare the body model

Write the model in `src/payment.model.ts`. The generator reads files that end in `.model.ts`.

<<< ../../examples/payments/server/src/payment.model.ts#payment-types

- `TPaymentInput` is an `IObject`. The handler receives a validated plain object ([IObject or IModel](/guide/models#iobject-or-imodel)).
- A tag follows the type with `&`. `MinLength<2>`, `Pattern<'…'>` and `MaxLength<140>` are checked on each request and written into the document ([validation tags](/guide/tags)).
- A field with no tag still has its type checked, and a missing required field fails.

A named model such as `TPaymentInput` is exact. A request with an undeclared key gets HTTP 400 before the handler runs. The `exact` option, `golem.yaml` and an inline body type change this ([Extra properties](/guide/nestjs-requests#extra-properties)).

## Step 4: Write the controller

Type the `@Body()` parameter with the model. Write the return type too, because the build reads both annotations.

<<< ../../examples/payments/server/src/payments.controller.ts#create-payment

- The route is `payments/transactions` with `@Post()`. The example builds the path with a [route helper](/reference/nestjs#route-helpers). A string such as `@Controller('payments/transactions')` works too.
- `@Body() input: TPaymentInput` makes the interceptor validate the body. The handler never runs for a body that fails.
- `Promise<TPayment>` makes the interceptor write the response with the JSON form of `TPayment`.
- `@ApiOperation({ operationId: 'createPayment' })` names the client method `createPayment()`.
- `@ApiBadRequestResponse` writes the `400` response into the document. Golem does not add it for you.

## Step 5: Register the interceptor

Register `NestModelInterceptor` once, for the whole app:

<<< ../../examples/payments/server/src/application.ts#global-model-http

- `import 'reflect-metadata'` comes first.
- `controllers: [PaymentsController, …]` lists the controller in a module, as for any NestJS controller.
- `setGlobalPrefix('api')` sets the prefix that `globalPrefix` repeats in Step 6.
- `useGlobalInterceptors(new NestModelInterceptor())` turns on the conversion for every controller. It works with the Express and Fastify adapters.

The steps for each request and the rules for arrays and query objects are in [NestJS requests](/guide/nestjs-requests#what-happens-to-a-request).

## Step 6: Configure golem.yaml

Add `golem.yaml` at the project root. Start it with `version: 1`. The excerpts below leave out `version: 1` and the other jobs of the example. A `controllers` job writes the OpenAPI document:

<<< ../../examples/payments/server/golem.yaml#controllers-job

- `output` is the path of the document.
- `info` holds the `title` and the `version` of the API.
- `globalPrefix` must match `setGlobalPrefix()`. The generator reads controllers, not your bootstrap code ([controller jobs](/reference/config#controller-jobs)).

The `models` job is required. It writes the generated file of each model that your controllers use, and the build needs it to bind each `@Body()` model. Without it, the build reports `has no unique codec id; run golem generate`.

<<< ../../examples/payments/server/golem.yaml#models-job

## Step 7: Generate and build

```sh
npx golem generate
npx golem build
```

- `golem generate` writes the generated model files and the document. Your editor needs them now.
- `golem build` generates first, type-checks, and writes JavaScript with the request conversion in `.build/`.
- Run the compiled entry file under your `outDir` with `node` ([Build tools](/guide/build)).
- Ignore or commit the generated files and the document, as you choose ([ignore or commit generated files](/reference/generated-files#gitignore)). Ignore `.golem/` in both cases.

Send these bodies to the endpoint. The handler runs only for the first:

| Body | Result |
| --- | --- |
| Every field valid | HTTP 201 and the JSON of the new payment |
| `money.currency` is `"usd"` | HTTP 400. The issue path is `['money', 'currency']` |
| `money.amount` is the number `12.5` | HTTP 400. The type is a string with a `Pattern` |
| An extra key `tracking` | HTTP 400 with the issue code `unknownKey` |

## What the frontend gets

The frontend team gets `api/openapi.yaml`. It holds the operation `createPayment` with its request schema and its responses ([the document for this controller](/guide/nestjs#models-in-a-controller)).

- **Tags:** each validation tag of the model becomes one keyword. `MinLength<2>` becomes `minLength: 2`, and `Pattern<'…'>` becomes `pattern`. The table of all tags is in [tag keywords](/reference/nestjs#tag-keywords). `TSerde` and `TValidation` write no keyword.
- **The 400 response:** the document holds it because of `@ApiBadRequestResponse`. Without that decorator the document has no `400` response, although the interceptor still answers HTTP 400.

The frontend project sets the document as the `input` of an `openapi` job. This example reads the document of the server project:

<<< ../../examples/payments/web/golem.yaml

Then `npx golem generate` in the frontend project writes the client ([Generate an SDK](/guide/client)). How the document reaches another project, and what to run in CI, is in [generated files](/reference/generated-files#gitignore).

## Details in the reference

- [NestJS requests](/guide/nestjs-requests): parameter types, arrays, one-field parameters, query objects and responses.
- [OpenAPI from controllers](/guide/nestjs): the controller job and the document it writes.
- [NestJS controllers](/reference/nestjs): route helpers, tag keywords, component names, status codes and Swagger decorators.
- [Configuration](/reference/config#controller-jobs): every key of a `controllers` job.
- [Generated files](/reference/generated-files#gitignore): ignore or commit them, and how the document reaches other projects.
