# OpenAPI from NestJS controllers

This complete project uses one TypeScript model contract at four boundaries:

- Nest request conversion and validation;
- Nest response serialization;
- the generated OpenAPI document;
- the generated SDK client.

Amounts are decimal strings. The example stores payments in memory and does
not require a hosted API.

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm start
```

The API listens at `http://127.0.0.1:3000/api/payments/transactions`. Set
`PORT` to select another port:

```sh
PORT=3100 npm start
```

Open a second terminal and call the local API:

```sh
npm run client
```

On a fresh server, the client prints:

```text
Payment 1: USD 12.50
```

Set `API_BASE_URL` when the client should use another address.

## Source files

| File | Purpose |
| --- | --- |
| `src/payment.model.ts` | Model declarations and the `Payment` class that extends the generated `TPaymentBaseModel` |
| `src/payments.controller.ts` | Payments routes and in-memory store |
| `src/payment-draft.model.ts` | Class model used as a `@Body()` type by the `drafts` route |
| `src/payment-notes.controller.ts` | Controller without Swagger decorators, so its operation ID is the default |
| `src/price.model.ts`, `src/decimal-text.ts` | `TSerde` pair that stores a number and writes a decimal string |
| `src/routes.ts` | Route path helper shared by the controller and the OpenAPI generator |
| `src/payment-status.ts` | `PaymentStatus` query type |
| `src/application.ts` | Nest bootstrap; model module load registers codecs |
| `src/main.ts` | Process entrypoint; validates `PORT` and starts listening |
| `src/client.ts` | Serialize a draft and call the generated operation |
| `src/run-client.ts` | Runnable client entrypoint |
| `src/app-workflows.ts` | Shared test cases, run against a created Nest application |
| `src/app.test.ts` | Runs `app-workflows.ts` against the real Nest adapter |
| `golem.yaml` | Controller, SDK and model jobs |

The directory also holds the generated `api/openapi.yaml`, `sdk/` and
`*.model.generated.ts` files.

## Nest bootstrap

`src/application.ts` creates the Nest application with both controllers, sets the `api` global prefix and registers `NestModelInterceptor` with `useGlobalInterceptors`. It imports `src/payment.model.ts` so the generated codec is registered before requests arrive.

The interceptor runs `fromWireFormat` on a whole `@Body()` or `@Query()` model before the handler, and writes an `IModel` or `IObject` return value, a `Promise` of one or an array of one with `stringify`. `@Param()` and field bindings such as `@Body('field')` stay as Nest received them.

`tsconfig.json` enables `experimentalDecorators`, `emitDecoratorMetadata` and the `@exprtlabs/golem/ttsc-plugin` with `"nest": true`. The plugin records the `@Body()`, `@Query()` and return types that TypeScript erases, and `npm start` and `npm test` compile through `ttsc`. [Generate OpenAPI](../../docs/guide/nestjs.md#set-up-typescript) lists the settings, and [NestModelInterceptor](../../docs/guide/nestjs-in-depth.md#nestmodelinterceptor) has the full request and response contract.

## Generated client call

`src/client.ts` sends a model draft through the generated operation:

```ts
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { PaymentsClient } from '../sdk/index.js';
import { Payment, type TPaymentInput } from './payment.model.js';

export async function submitPayment(
  client: PaymentsClient,
  draft: TPaymentInput,
): Promise<Payment> {
  const response = await client.createPayment().execute({
    body: draft,
  });
  return fromWireFormat<Payment>(response.body);
}
```

`fromWireFormat` is synchronous; `client.createPayment().execute` is
asynchronous.

## Generation order

`golem.yaml` writes the controller document, then the SDK, then the
`*.model.generated.ts` files:

```yaml
version: 1
controllers:
  - framework: nestjs
    root: .
    output: ./api/openapi.yaml
    info:
      title: Payments API
      version: '1'
    globalPrefix: api
openapi:
  - input: ./api/openapi.yaml
    output: ./sdk
    name: Payments
models:
  root: .
```

Edit the authored files under `src/` or `golem.yaml` and run
`npm run generate`. Generated files under `api/`, `sdk/` and the
`*.model.generated.ts` files are replaced.
