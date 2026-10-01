# React form with MobX example

This complete project binds a React form to an observable payment editor and saves it through a generated client to a local demo server.

- The OpenAPI job generates the client; the models job generates the `PaymentEditor` class.
- `src/payment-store.ts` owns one editor and the save state. It validates before saving, aborts an in-flight request on `dispose`, and allows a retry after a transport failure.
- `src/App.tsx` renders the form as a MobX `observer` component. Its fields call editor actions, and `getValidator` supplies the field errors.
- `server/server.ts` is a small local API for `POST /payments`.
- The profile has validation on and MobX on.

It backs the guide page [MobX and React](../../docs/guide/mobx.md).

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm test
npm run dev
```

- `npm run generate` runs the `openapi` and `models` jobs in `golem.yaml`.
- `npm test` checks the generated files, compiles with `ttsc` and runs `tests/payment-store.test.ts` against a mocked `fetch`.
- `npm run dev` compiles the server and starts it with Vite. Open http://127.0.0.1:5173.
- `npm run build` builds the page with Vite; `npm run preview` serves the build.

The page reads `VITE_API_BASE_URL` (default `http://127.0.0.1:3002`). The server reads `PAYMENT_DEMO_PORT` (default `3002`) and `PAYMENT_DEMO_ORIGIN` (default `http://127.0.0.1:5173`). `VITE_API_BASE_URL` and `PAYMENT_DEMO_PORT` must name the same port, and `PAYMENT_DEMO_ORIGIN` must match the page's origin.

`tests/browser.md` lists the two manual browser checks: the StrictMode save and keyboard navigation at a narrow viewport.

Edit `api.yaml` or the authored source and run `npm run generate` again. `sdk/` and `src/payment-editor.model.generated.ts` are replaced.

## Source files

| File | Responsibility |
| --- | --- |
| `api.yaml` | The Payments API contract |
| `golem.yaml` | The `openapi` and `models` jobs |
| `src/payment-editor.model.ts` | Model declaration and the observable `PaymentEditor` class |
| `src/payment-store.ts` | Save state, validation before save, abort and retry |
| `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `index.html` | The React page |
| `server/server.ts`, `scripts/dev.ts` | The local demo API and the `npm run dev` launcher |
| `tests/payment-store.test.ts` | Tests for save, validation, failure and retry, and disposal |
| `tests/browser.md` | Manual browser checks |
