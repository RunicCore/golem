# OpenAPI from NestJS controllers

This complete project uses one TypeScript model contract at four boundaries:

- Nest request conversion and validation;
- Nest response serialization;
- the generated OpenAPI document;
- the generated SDK client.

Amounts are decimal strings. The example stores payments in memory and does
not require a hosted API.

## Install and run

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
| `src/payment.model.ts` | Model fields, codecs and generated model subclasses |
| `src/payments.controller.ts` | Payments routes and in-memory store |
| `src/routes.ts` | Route path helper shared by the controller and the OpenAPI generator |
| `src/payment-status.ts` | `PaymentStatus` query type |
| `src/application.ts` | Nest bootstrap; model module load registers codecs |
| `src/main.ts` | Process entrypoint; validates `PORT` and starts listening |
| `src/client.ts` | Serialize a draft and call the generated operation |
| `src/run-client.ts` | Runnable client entrypoint |
| `src/app-workflows.ts` | Shared test cases, run against a created Nest application |
| `src/app.test.ts` | Runs `app-workflows.ts` against the real Nest adapter |
| `golem.yaml` | Controller, SDK and model jobs |

The project archive contains the full source for every file, including the
generated `api/openapi.yaml` and `sdk/` files.

## Nest bootstrap

`src/application.ts` creates the Nest application. Load the model module, then
register `NestModelInterceptor`:

```ts
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
import { PaymentsController } from './payments.controller.js';
import './payment.model.js';

@Module({ controllers: [PaymentsController] })
class PaymentsModule {}

export async function createApplication() {
  const application = await NestFactory.create(PaymentsModule, { logger: false });
  application.setGlobalPrefix('api');
  application.useGlobalInterceptors(new NestModelInterceptor());
  return application;
}
```

`@Body()` and `@Query()` convert through that interceptor, and it writes an `IModel` or `IObject` return value with `stringify`.

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

`golem.yaml` writes the controller document, then the SDK, then model
companions:

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
`npm run generate`. Generated files under `api/`, `sdk/` and model companion
paths are replaced.
