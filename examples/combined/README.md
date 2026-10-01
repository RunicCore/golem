# Models with a client example

This complete project edits a payment in a model and sends it through a generated client.

- The OpenAPI job generates the client and its `Money` type from `api.yaml`.
- The models job generates the `PaymentEditor` class, whose nested `money` field uses the client's type.
- `validateInstance` runs the stateless checks before the request; `toWireFormat` writes the body.
- The generated client rejects an invalid request before `fetch`.
- The profile has validation on and MobX off.

It backs the guide pages [Models with a client](../../docs/guide/models-and-client.md), [Using the client](../../docs/guide/client-usage.md), [Body codecs](../../docs/guide/codecs.md) and [MobX and React](../../docs/guide/mobx.md).

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm test
npm start
```

- `npm run generate` runs the `openapi` and `models` jobs in `golem.yaml`.
- `npm test` checks the generated files, compiles with `ttsc` and runs `src/app.test.ts` against a mocked `fetch`.
- `npm start` prints a hint unless `PAYMENTS_API_BASE_URL` is set. With it set, the example saves a payment to that API:

```sh
PAYMENTS_API_BASE_URL=https://api.example.com npm start
```

The project does not start an API server. Point the URL at a service that matches `api.yaml`.

Edit `api.yaml` or the authored source and run `npm run generate` again. `sdk/` and `src/payment-editor.model.generated.ts` are replaced.

## Source files

| File | Responsibility |
| --- | --- |
| `api.yaml` | The Payments API contract |
| `golem.yaml` | The `openapi` and `models` jobs |
| `src/payment-editor.model.ts` | Model declaration and the `PaymentEditor` class |
| `src/payment-preview.ts` | Edit, serialize, validate and correct a payment |
| `src/payment-app.ts` | Validate an editor, then send it through the client |
| `src/create-payment.ts` | The plain generated-client call |
| `src/main.ts` | The `npm start` entrypoint |
| `src/app.test.ts` | Tests for every behavior above |
