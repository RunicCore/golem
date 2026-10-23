# Generate a client

Generate a typed SDK from an OpenAPI document, then call its operations with checked requests and responses.

## Install

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-openapi typescript@~7.0.2
```

Requests and responses are validated by default ([validation profiles](/reference/config#validation-profiles)). Choose how to build in [Build your app](/guide/build). Include the generated `sdk/` directory in the TypeScript program that builds your app. Ignore it in git with the other [generated files](/reference/generated-files#gitignore).

## Point to your OpenAPI document

Add `golem.yaml` at the project root. The example keeps it in `server/`. Paths are relative to this file. `name: Provider` names the client `ProviderClient`. This excerpt leaves out two root keys. The [`mobx`](/reference/config#root-keys) key sets MobX observability for the generated code. The [`validation`](/reference/config#validation-profiles) key sets runtime validation.

<<< ../../examples/payments/server/golem.yaml#openapi-job

The document is the contract. Keep it in the project or point `input` at the file that your API already owns. The generator reads the features in [OpenAPI client support](/reference/openapi-support). The example's [`provider.yaml`](https://github.com/RunicCore/golem/blob/master/examples/payments/server/provider/provider.yaml) declares `createCharge` (`POST /charges`), and list, get, text and event operations:

<<< ../../examples/payments/server/provider/provider.yaml#create-charge-operation

Generation stops on an invalid document and reports each problem.

## Generate the SDK

```sh
npx golem generate
```

The command writes the `sdk/` directory under `output`. The example writes `provider/sdk/`.

## What to import

Import `ProviderClient` from the `sdk/index.js` file under your `output` directory. The example's `provider/client.ts` imports `./sdk/index.js`. Import operation factories and model classes from the public paths in [Generated files](/reference/generated-files#public-paths).

Golem replaces only the files it generated. Keep your own code, including model classes that use [SDK types](/guide/models-and-client), outside `sdk/`. A file there that golem did not generate stops generation.

Change `provider.yaml` and generate again when the contract changes.

## First call

<<< ../../examples/payments/server/provider/charges.ts#create-and-list

Set `baseUrl` to your service and pass credentials as in [Authentication](/guide/auth). `client.listCharges()` creates a reusable operation. `.execute({})` sends `GET /charges` and returns the response. Add [parameters and a body](/guide/client-usage#pass-parameters-and-a-body), and [read the response](/guide/client-usage#read-responses-and-handle-failures) and check the `status` before you read the `body`.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
