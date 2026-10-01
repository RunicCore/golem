# Models with a client and MobX example

This complete project edits a nested payment as an observable model and saves it through a generated client.

- The OpenAPI job generates the client; the models job generates a `PaymentEditor` whose nested `money` field is observable.
- An `autorun` reaction reprints the editor's summary when a nested field changes.
- Validation errors stay reactive; `validateInstance` blocks an invalid save.
- A generated operation exposes `loading`, which the example observes while a request is pending.
- The profile has validation on and MobX on.

It backs the guide pages [MobX and React](../../docs/guide/mobx.md) and [Using the client](../../docs/guide/client-usage.md).

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
- `npm start` prints the summary as the amount changes. It saves the payment only when `PAYMENTS_API_BASE_URL` is set:

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
| `src/payment-editor.model.ts` | Model declaration and the observable `PaymentEditor` class |
| `src/nested-editing.ts` | Reaction over a nested edit |
| `src/payment-app.ts` | Validate an editor, then save it through the client |
| `src/loading.ts` | Observe an operation's `loading` state |
| `src/main.ts` | The `npm start` entrypoint |
| `src/app.test.ts` | Tests for every behavior above |
