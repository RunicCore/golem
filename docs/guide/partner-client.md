# Call a partner's API

Turn a partner's OpenAPI 3.1 document into a typed client for a Node.js service, with bearer auth, Temporal dates, checked and converted responses and your own model class.

## What golem gives you

Golem reads the partner's document and writes a TypeScript client from it. The examples use a payment provider. Its document is `provider.yaml`, and `name: Provider` makes the client `ProviderClient`.

| You want | Golem gives you |
| --- | --- |
| To call an operation such as `getCharge` | A `ProviderClient` method for each operation, with typed input and a typed response |
| To send a bearer token | An `auth` option on the client, keyed by the name of the security scheme |
| To use a schema such as `Charge` | A TypeScript type for each schema. The client returns plain objects of that type |
| Dates as dates | `Temporal.Instant` and `Temporal.PlainDate` values in the response, from `format: date-time` and `format: date` |
| To know when the partner breaks the contract | A check of each request and response, and a `LibError` when one fails. You can lower the checks per client or per call |
| Your own rules on the partner's data | Your own model over the SDK types, with methods |

## Step 1: Install

```sh
npm install @exprtlabs/golem temporal-polyfill
npm install --save-dev @exprtlabs/golem-openapi @exprtlabs/golem-model typescript@~7.1.0-beta
```

- `@exprtlabs/golem-model` is for your own model in Step 8. Leave it out when you do not write one.
- A standalone SDK (the default) carries the golem runtime that it uses. Generated code imports nothing from `@exprtlabs/golem`. You need the package to run `golem generate`, and to build your own models.
- Check the [requirements](/guide/quick-start#requirements) and the [project settings](/guide/quick-start#project-settings), such as `"type": "module"`.
- Add `"esnext.temporal"` to `compilerOptions.lib` in `tsconfig.json`. Or set `skipLibCheck: true`. The SDK types name the global `Temporal` when you set `dates: temporal`.
- Include the output directory of the job in the TypeScript program, for example `provider/sdk/**/*.ts`, so it holds the generated client.

## Step 2: Add the document and the job

- Save the partner's document in your project, as YAML or JSON. The example keeps it in `provider/provider.yaml`.
- Add `golem.yaml` at the project root. Start it with `version: 1`. Paths in it are relative to the file.

<<< ../../examples/payments/server/golem.yaml#openapi-dates-job

| Key | Meaning |
| --- | --- |
| `input` | The partner's document |
| `output` | The directory that golem fills with the client |
| `name` | The prefix of the client, so `Provider` gives `ProviderClient` |
| `dates: temporal` | Temporal values for dates and times in place of `Date` ([the `openapi-ts` block](/reference/config#openapi-ts-block)) |
| `mode` | Leave it out for a standalone SDK, which runs alone. `golem` leaves checks and conversions to the models job ([SDK modes](/reference/config#sdk-modes)) |

The models job lets your own model class use the SDK types (Step 8):

<<< ../../examples/payments/server/golem.yaml#models-job

Golem reads OpenAPI 3.1 and 3.2 documents ([OpenAPI support](/reference/openapi-support)).

## Step 3: Generate the client

```sh
npx golem generate
```

The command writes `provider/sdk/`. You choose whether to ignore or commit the generated files ([ignore or commit them](/reference/generated-files#gitignore)). Run the command again when the partner publishes a new version of the document.

Import from `sdk/index.js`. Each schema in `components.schemas` gives a type. The schema `Charge` gives the type `Charge`. The SDK has no model classes. The other names are in [Generated SDK names](/reference/generated-files#generated-sdk-names).

<<< ../../examples/payments/server/provider/charges.ts#client-imports

## Step 4: Create the client with bearer auth

<<< ../../examples/payments/server/provider/client.ts#send-payment

- `bearerAuth` is the name of the security scheme in the document.
- The client sends `Authorization: Bearer <token>` with each request.
- Pass a function instead of a string when the token changes while the client lives. The client calls it for each request.

The client has an `auth` option only when the document declares the security scheme and requires it. Other schemes, a document that lacks the security scheme, and mutual TLS are in [Authentication](/guide/auth).

## Step 5: Call an operation and read the response

<<< ../../examples/payments/server/provider/charges.ts#request-arguments

- `client.listCharges()` makes an operation. `.execute(input)` sends the request.
- The input has a group for each kind of parameter that the operation declares: `path`, `query`, `header`, `cookie` and `body`. Pass `{}` when nothing is required.

<<< ../../examples/payments/server/provider/charges.ts#read-charge

- A response holds `status` and the decoded `body`. The client has checked and converted the body: it is a plain object of the SDK type.
- A status that the document declares, such as `404`, gives you a response, not an error. Check `status` before you read `body`.

Reuse, shared headers and cancel are in [Call operations](/guide/client-usage).

## Step 6: Read dates as Temporal values

- `dates: temporal` in Step 2 makes `format: date-time` a `Temporal.Instant`, `format: date` a `Temporal.PlainDate` and `format: duration` a `Temporal.Duration`.
- A `Temporal` must exist when golem converts a value. Install `temporal-polyfill` and import `temporal-polyfill/global` once, before the first conversion. A runtime that has a global `Temporal` needs no polyfill. Without any, conversion fails with "Temporal is not available".
- The JSON form stays an ISO 8601 string. The client converts it for you, so the response `body` holds the Temporal values:

| Schema `format` | JSON text | In your code |
| --- | --- | --- |
| `date-time` | `2025-01-02T03:04:05Z` | `Temporal.Instant` |
| `date` | `2025-02-01` | `Temporal.PlainDate` |
| `duration` | `PT1H30M` | `Temporal.Duration` |

<<< ../../examples/payments/server/provider/settlement.ts#temporal-imports

<<< ../../examples/payments/server/provider/settlement.ts#read-dates

The client writes a Temporal value in a request as its ISO 8601 string. A `Temporal.Instant` is written with `Z`. A model of your own writes the strings back with `toWireFormat<T>` ([Dates and times](/guide/field-types#use-temporal-values-in-a-client)).

## Step 7: Handle a reply that breaks the contract

A request or a response that breaks its schema rejects `.execute()`. This catch block handles both. The example sends an amount that breaks a `pattern`:

<<< ../../examples/payments/server/provider/charges.ts#invalid-charge

A request or a response that breaks its schema gives a `LibError` of kind `Validation`. To lower or switch off the checks for one client or one call, use the [`validate` option](/guide/client-usage#lower-the-checks). An undeclared status or media type gives kind `Response`. A network failure rejects with the error of `fetch`. Each failure, the guard [`isProviderUndeclaredResponseError`](/guide/client-usage#handle-errors) and the issue fields are in [Read responses and handle failures](/guide/client-usage#read-responses-and-handle-failures).

<<< ../../examples/payments/server/provider/charges.ts#handle-errors

Every failure and its result are in the [generated client reference](/reference/runtime-api#generated-client). The issue codes are in the [errors reference](/reference/runtime-api#errors).

## Step 8: Add your own model

The SDK has no model classes. Put your rules in a model of your own, over the SDK type:

- `IModel<Charge>` makes a model with the fields of `Charge`.
- Your class extends the generated base class of your model and adds methods.
- The model is yours. The client still returns the plain `Charge`.

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-record-declaration

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-record-class

- The field `charge: Charge` holds a plain `Charge`. Its `settlesOn` is a `Temporal.PlainDate`.
- `isOverdue` takes today's date as an argument, so a test can fix the date. The settlement day itself is not overdue.
- The `temporal-polyfill/global` import gives the global `Temporal` ([Step 6](/guide/partner-client#step-6-read-dates-as-temporal-values)).
- Golem links a class to its model through `extends <Alias>BaseModel` ([generated names](/reference/generated-files#generated-names)). Keep methods in that class.
- Run `golem generate` before you write the class. It writes the base class that the class extends.

Build the model from the body of a response with the constructor. The client has checked the body, so the constructor runs no second check:

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-view

[SDK types in your models](/guide/models-and-client) shows custom constructors, golem mode and the whole flow, with validation and sending.

## Step 9: Run with Node

`fromWireFormat<T>`, `toWireFormat<T>` and four more calls need a build tool that rewrites them ([Build tools](/guide/build)). Choose one:

| Build tool | Command |
| --- | --- |
| Build, then run the JavaScript | `npx golem build`, then `node` on the compiled entry file under your `outDir` |
| Let Node load the TypeScript | `node --import @exprtlabs/golem/register src/main.ts` |

- Node.js 22.15 or newer. Before 22.18, add `--experimental-strip-types` to the loader command ([Node versions](/guide/build#node-versions)).
- The loader needs ES modules and the generated files, so run `npx golem generate` once first.
- The build command writes into the `outDir` of your tsconfig. Which file is the entry depends on your `rootDir` and your entry file ([Build with golem build](/guide/build#build-with-golem-build)).

## Reference

- [the `openapi-ts` block](/reference/config#openapi-ts-block): every key of the SDK job.
- [Generated client](/reference/runtime-api#generated-client): options, results and failures of the client.
- [Client authentication](/reference/runtime-api#client-authentication): the schemes and what the client sends.
- [Generated SDK names](/reference/generated-files#generated-sdk-names): the names for each schema.
- [SDK modes](/reference/config#sdk-modes): standalone and golem.
- [Temporal types](/reference/runtime-api#temporal): the six types and their JSON strings.
- [OpenAPI support](/reference/openapi-support): the features that the generator reads.
- Guides: [Call operations](/guide/client-usage), [Authentication](/guide/auth), [Dates and times](/guide/field-types#dates-and-times), [SDK types in your models](/guide/models-and-client), [Build tools](/guide/build).

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
