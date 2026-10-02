# Payments

A merchant payments app: one TypeScript contract becomes a NestJS API, an OpenAPI document, a typed client and a React + MobX payment editor. It also calls a third-party provider through a client generated from the provider's own OpenAPI document.

## What it shows

- `server/`: a NestJS API whose controllers generate `server/api/openapi.yaml`, with `NestModelInterceptor` validating bodies and queries. Amounts are decimal strings on the wire.
- `web/`: a React + MobX editor that uses the client generated from that document.
- `server/provider/`: a client generated from `provider.yaml` with bearer auth, an `Idempotency-Key` header, NDJSON event streams, Temporal settlement dates and a custom money media type.
- Each saved payment is charged through the provider client (bearer token, one `Idempotency-Key` per payment), and the editor shows the charge status.
- `generators/event-models.js`: a generator job that writes the provider's event models.
- One package, two configurations: `server/golem.yaml` has MobX off and `web/golem.yaml` has MobX on.

The example depends on `1.0.0-rc` of `@exprtlabs/golem*`, which is not published yet. Run it from this repository checkout.

## Install and run

```sh
npm install
npm run generate   # server configuration first, then the web configuration
npm test           # offline: mocked fetch and an in-process Nest app
npm run demo       # starts the API on a free port and submits one payment
npm run dev        # API :3000, stand-in provider :3001, editor http://127.0.0.1:5173
```

`npm run demo` prints:

```text
Payment 1: USD 12.50, charge charge-1 is pending
```

`dev/provider.ts` is a local stand-in for the third-party provider (token `dev-token`). Only `npm run dev` starts it; tests mock `fetch`.

## Files

| File | Responsibility |
| --- | --- |
| `server/src/payment.model.ts` | Payment, money and query models |
| `server/src/payments.controller.ts` | Payment routes that produce the OpenAPI document |
| `server/src/provider-charges.ts` | Charges a saved payment through the provider client |
| `server/src/application.ts` | Nest application with the global model interceptor |
| `server/src/price.model.ts`, `decimal-text.ts` | Integer minor units written as decimal text |
| `server/provider/provider.yaml` | The provider's OpenAPI document |
| `server/provider/*.ts` | Provider client usage: auth, headers, codecs, streams, dates |
| `web/src/payment-editor.model.ts` | Observable payment editor model |
| `web/src/payment-store.ts` | Validate, save, cancel and retry |
| `web/src/App.tsx` | The editor view |

## Edit and regenerate

Change a model or controller, then run `npm run generate`. The web configuration reads `server/api/openapi.yaml`, so the server configuration runs first.
