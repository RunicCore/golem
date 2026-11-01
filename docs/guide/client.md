# Generate an SDK

Generate a typed SDK from an OpenAPI document, then call its operations with checked requests and responses.

The SDK is a client and types. The client checks and converts each request and each response, so your code never calls a conversion function. The SDK has no model classes.

## Install

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-openapi-ts typescript@~7.1.0-beta
```

With the [MobX extension](/guide/mobx), install `@exprtlabs/golem-openapi-ts` in `dependencies`, because generated files import its MobX runtime.

Requests and responses are validated by default ([validation profiles](/reference/config#validation-profiles)). Choose how to build in [Build tools](/guide/build). Include the generated `sdk/` directory in the TypeScript program that builds your app. Ignore it in git with the other [generated files](/reference/generated-files#gitignore).

## Point to your OpenAPI document

Add `golem.yaml` at the project root. The example keeps it in `server/`. Paths are relative to this file. `name: Provider` names the client `ProviderClient`. This excerpt leaves out two keys. The [`validation`](/reference/config#validation-profiles) root key sets runtime validation. The [`extensions`](/reference/config#mobx-extension) key of the block turns on MobX.

<<< ../../examples/payments/server/golem.yaml#openapi-job

The document is the contract. Keep it in the project or point `input` at the file that your API already owns. The generator reads the features in [OpenAPI support](/reference/openapi-support). The example's [`provider.yaml`](https://github.com/RunicCore/golem/blob/master/examples/payments/server/provider/provider.yaml) declares `createCharge` (`POST /charges`), and list, get, text and event operations:

<<< ../../examples/payments/server/provider/provider.yaml#create-charge-operation

Generation stops on an invalid document and reports each problem.

## Generate the SDK

```sh
npx golem generate
```

The command writes the `sdk/` directory under `output`. The example writes `provider/sdk/`.

## What to import

Import `ProviderClient` and the data types from the `sdk/index.js` file under your `output` directory. The example's `provider/client.ts` imports `./sdk/index.js`. Import operation factories from the public paths in [Generated files](/reference/generated-files#public-paths).

Golem replaces only the files it generated. Keep your own code, including models over [SDK types](/guide/models-and-client), outside `sdk/`. A file there that golem did not generate stops generation.

Change `provider.yaml` and generate again when the contract changes.

## Choose a mode

An SDK job has a `mode` key ([SDK modes](/reference/config#sdk-modes)). The calls are the same in both modes.

| Mode | Use it when | What the SDK holds |
| --- | --- | --- |
| `standalone` (default) | You get a ready SDK and have no golem setup, or you publish the SDK | The client, the types, the checks and conversions, and a copy of the golem runtime that it uses |
| `golem` | Your app runs golem and has models in the same `golem.yaml` | The client and the types. The models job writes the checks and conversions with your models |

- A standalone SDK imports nothing from `@exprtlabs/golem`. With `dates: temporal`, install `temporal-polyfill` and load it before the first call.
- A golem mode SDK needs a `model` block in the same file. Add `mode: golem` to the job.
- An SDK in a block with the `mobx` extension needs `mode: golem` ([MobX and React](/guide/mobx)).

## First call

<<< ../../examples/payments/server/provider/charges.ts#create-and-list

Set `baseUrl` to your service and pass credentials as in [Authentication](/guide/auth). `client.listCharges()` creates a reusable operation. `.execute({})` sends `GET /charges` and returns the response. Add [parameters and a body](/guide/client-usage#pass-parameters-and-a-body), and [read the response](/guide/client-usage#read-responses-and-handle-failures) and check the `status` before you read the `body`.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
