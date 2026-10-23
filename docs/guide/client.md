# Generate a client

Point `@exprtlabs/golem-openapi` at an OpenAPI document and call its operations with typed, validated requests and responses.

<<< ../../examples/payments/server/provider/charges.ts#create-and-list

Set `baseUrl` to your service — the client doesn't pick an OpenAPI `servers` URL — then `client.listCharges()` creates a reusable operation and `.execute({})` sends `GET /charges` and returns the response.

## Install

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-openapi typescript@~7.0.2
```

Requests and responses are validated by default. Choose how to build in [Build your app](/guide/build). Include the generated `sdk/` directory in the TypeScript program that builds your app, and ignore it in git with the other generated files ([ignore generated files](/reference/generated-files#gitignore)).

## Point to your OpenAPI document

Add `golem.yaml` at the project root (the example keeps it in `server/`). Paths are relative to it, and `name: Provider` names the client `ProviderClient`. The [`mobx`](/reference/config#root-keys) and [`validation`](/reference/config#validation-profiles) root keys, which this excerpt leaves out, set MobX observability and runtime validation for the generated code.

<<< ../../examples/payments/server/golem.yaml#openapi-job

The document is the contract. Keep it in the project or point `input` at the file your API already owns; any [supported OpenAPI feature](/reference/openapi-support) works. The example's [`provider.yaml`](https://github.com/RunicCore/golem/blob/master/examples/payments/server/provider/provider.yaml) declares `createCharge` (`POST /charges`), plus list, get, text and event operations:

<<< ../../examples/payments/server/provider/provider.yaml#create-charge-operation

Generation fails on an invalid document.

## Generate the SDK

```sh
npx golem generate
```

The command writes the `sdk/` directory under `output`; the example writes `provider/sdk/`. Import `ProviderClient` from the `sdk/index.js` file under your `output` directory; the example's `provider/client.ts` imports `./sdk/index.js`.

## Generated files

Import only the public [generated files](/reference/generated-files); the others may change in a minor release.

| File | Contents | Public |
| --- | --- | --- |
| `index.ts` | Entrypoint | Yes |
| `client.ts` | The client class | No |
| `operations/<name>.ts` | One operation factory per endpoint | Yes |
| `models/<Schema>.ts` | A runtime model class per object schema | Yes |
| `model-manifest.json` | Read by the model generator | No |

For a schema named `Charge` you get `Charge`, the JSON data type, and `ChargeModel`, its runtime class. Use `ChargeModel` when you want an instance rather than response data:

<<< ../../examples/payments/server/provider/charges.ts#charge-model

Build your own model around SDK types the same way in [Models with a client](/guide/models-and-client).

Change `provider.yaml` and generate again when the contract changes. Keep your own code, including your model classes, outside `sdk/`.

## Call the generated client

Pass query parameters and a request body:

<<< ../../examples/payments/server/provider/charges.ts#request-arguments

Check the declared status before reading the body:

<<< ../../examples/payments/server/provider/charges.ts#read-charge

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments)
