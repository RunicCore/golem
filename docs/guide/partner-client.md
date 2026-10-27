# Call a partner's API

Turn a partner's OpenAPI 3.1 document into a typed client for a Node.js service, with bearer auth, Temporal dates, checked responses and your own model class.

## What golem gives you

Golem reads the partner's document and writes a TypeScript client from it. The examples use a payment provider. Its document is `provider.yaml`, and `name: Provider` makes the client `ProviderClient`.

| You want | Golem gives you |
| --- | --- |
| To call an operation such as `getCharge` | A `ProviderClient` method for each operation, with typed input and a typed response |
| To send a bearer token | An `auth` option on the client, keyed by the name of the security scheme |
| To use a schema such as `Charge` | A JSON type, a runtime class and a type guard for each schema |
| Dates as dates | `Temporal.Instant` and `Temporal.PlainDate` values from `format: date-time` and `format: date` |
| To know when the partner breaks the contract | A check of each request and response, and a `LibError` when one fails |
| Your own rules on the partner's data | Your own model class that uses the SDK types and adds methods |

## Step 1: Install

```sh
npm install @exprtlabs/golem temporal-polyfill
npm install --save-dev @exprtlabs/golem-openapi @exprtlabs/golem-model typescript@~7.1.0-beta
```

- `@exprtlabs/golem-model` is for your own model in Step 8. Leave it out when you do not write one.
- Check the [requirements](/guide/quick-start#requirements) and the [project settings](/guide/quick-start#project-settings), such as `"type": "module"`.
- Add `"esnext.temporal"` to `compilerOptions.lib` in `tsconfig.json`.
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
| `dates: temporal` | Temporal values for dates and times in place of `Date` ([OpenAPI jobs](/reference/config#openapi-jobs)) |

The `models` job lets your own model class use the SDK types (Step 8):

<<< ../../examples/payments/server/golem.yaml#models-job

Golem reads OpenAPI 3.1 and 3.2 documents ([OpenAPI support](/reference/openapi-support)).

## Step 3: Generate the client

```sh
npx golem generate
```

The command writes `provider/sdk/`. Keep it out of git ([generated files](/reference/generated-files#gitignore)). Run the command again when the partner publishes a new version of the document.

Import from `sdk/index.js`. Each schema in `components.schemas` gets a set of names. The schema `Charge` gives the class `ChargeModel`. The JSON type, the type guard and the other names are in [Generated SDK names](/reference/generated-files#generated-sdk-names).

<<< ../../examples/payments/server/provider/charges.ts#client-imports

## Step 4: Create the client with bearer auth

<<< ../../examples/payments/server/provider/client.ts#send-payment

- `bearerAuth` is the name of the security scheme in the document.
- The client sends `Authorization: Bearer <token>` with each request.
- Pass a function instead of a string when the token changes while the client lives. The client calls it for each request.

<<< ../../examples/payments/server/provider/client.ts#current-token

Golem reads security from the document, so the client has an `auth` option only when the document has both parts:

<<< ../../examples/payments/server/provider/provider.yaml#bearer-security-scheme

<<< ../../examples/payments/server/provider/provider.yaml#bearer-security-requirement

If the partner's document lacks one part, ask the partner to add it. Or keep a copy of the document in your project, add the parts to the copy and point `input` at the copy ([use a document you do not own](/guide/auth#use-a-document-you-do-not-own)). The other schemes are in the [client reference](/reference/runtime-api#client-authentication).

## Step 5: Call an operation and read the response

<<< ../../examples/payments/server/provider/charges.ts#request-arguments

- `client.listCharges()` makes an operation. `.execute(input)` sends the request.
- The input has a group for each kind of parameter that the operation declares: `path`, `query`, `header`, `cookie` and `body`. Pass `{}` when nothing is required.

<<< ../../examples/payments/server/provider/charges.ts#read-charge

- A response holds `status` and the decoded `body`.
- A status that the document declares, such as `404`, gives you a response, not an error. Check `status` before you read `body`.

Reuse, shared headers and cancel are in [Call operations](/guide/client-usage).

## Step 6: Read dates as Temporal values

- `dates: temporal` in Step 2 makes `format: date-time` a `Temporal.Instant`, `format: date` a `Temporal.PlainDate` and `format: duration` a `Temporal.Duration`. A `format: time` value stays a string.
- A `Temporal` must exist when golem converts a value. Install `temporal-polyfill` and import `temporal-polyfill/global` once, before the first conversion. A runtime that has a global `Temporal` needs no polyfill. Without any, conversion fails with "Temporal is not available".
- The wire form stays an ISO 8601 string. The response `body` holds the strings, and the model class holds the Temporal values:

| Schema `format` | Wire | In your code |
| --- | --- | --- |
| `date-time` | `2025-01-02T03:04:05Z` | `Temporal.Instant` |
| `date` | `2025-02-01` | `Temporal.PlainDate` |
| `duration` | `PT1H30M` | `Temporal.Duration` |

<<< ../../examples/payments/server/provider/settlement.ts#temporal-imports

<<< ../../examples/payments/server/provider/settlement.ts#read-dates

`toWireFormat<ChargeModel>(charge)` writes the strings back. A `Temporal.Instant` is written with `Z`. [Dates and times](/guide/field-types#use-temporal-values-in-a-client) shows the write.

## Step 7: Handle a reply that breaks the contract

A request or a response that breaks its schema rejects `.execute()`. This catch block handles both. The example sends an amount that breaks a `pattern`:

<<< ../../examples/payments/server/provider/charges.ts#invalid-charge

A body that breaks its schema gives a `LibError` of kind `Validation`, with `causedByInput` set to `true` and `issues` with source `openapi`.

- The error does not keep the response body. Log what you need from each issue: `code`, `path` and `message`. Add the operation name and the id that you sent.
- A reply with a status or media type that the document does not declare gives a `LibError` of kind `Response`. Test for it with `is<Client>UndeclaredResponseError(error)`, which is `isProviderUndeclaredResponseError` here. It narrows the error to `status`, `headers`, `contentType`, `operation` and `client`.
- A network failure rejects with the error of `fetch`, unchanged.

<<< ../../examples/payments/server/provider/charges.ts#handle-errors

Every failure and its result are in the [generated client reference](/reference/runtime-api#generated-client). The issue codes are in the [errors reference](/reference/runtime-api#errors).

## Step 8: Add your own model

Put your rules in a class of your own, not in the SDK:

- A model can use an SDK type as a field. Golem builds that field as the SDK class: the type `TMoney` gives the class `TMoneyModel`.
- Your class extends the generated base class of your model and adds methods.

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-declaration

<<< ../../examples/payments/web/src/payment-editor.model.ts#model-methods

- Declare a field with the SDK type, such as `money: TMoney`. The field is a `TMoneyModel`, so `this.money.amount` reads a field of the SDK model. The web project has its own SDK, so this import reads `../sdk/index.js` of that project.
- A method such as `summary` goes in the class body. It reads `this.money.amount`.
- Golem links a class to its model through `extends <Alias>BaseModel` ([generated names](/reference/generated-files#generated-names)). Keep methods in that class.
- Run `golem generate` before you write the class. It writes the base class that the class extends.
- This example turns MobX on. With `mobx: false`, leave out the MobX import and the `asGenObservable` call.

A model can also hold a type of the partner, such as `Charge`. This model adds `isOverdue()`:

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-record-declaration

<<< ../../examples/payments/server/provider/charge-record.model.ts#charge-record-class

- The field `charge: Charge` is the SDK class `ChargeModel`. Its `settlesOn` is a `Temporal.PlainDate`.
- `isOverdue` takes today's date as an argument, so a test can fix the date. The settlement day itself is not overdue.
- The `temporal-polyfill/global` import gives the global `Temporal` ([Step 6](/guide/partner-client#step-6-read-dates-as-temporal-values)).

Build the model from the body of a response:

<<< ../../examples/payments/web/src/summary.ts#load-from-wire

[SDK types in your models](/guide/models-and-client) shows the whole flow, with validation and sending.

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

- [OpenAPI jobs](/reference/config#openapi-jobs): every key of the `openapi` job.
- [Generated client](/reference/runtime-api#generated-client): options, results and failures of the client.
- [Client authentication](/reference/runtime-api#client-authentication): the schemes and what the client sends.
- [Generated SDK names](/reference/generated-files#generated-sdk-names): the names for each schema.
- [Temporal types](/reference/runtime-api#temporal): the six types and their wire strings.
- [OpenAPI support](/reference/openapi-support): the features that the generator reads.
- Guides: [Call operations](/guide/client-usage), [Authentication](/guide/auth), [Dates and times](/guide/field-types#dates-and-times), [SDK types in your models](/guide/models-and-client), [Build tools](/guide/build).

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
