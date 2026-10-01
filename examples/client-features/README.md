# Client features example

This complete project uses the generated client's authentication, body codecs, streaming responses and Temporal dates, and runs a local generator job.

- `auth` sends a bearer token as a string or reads it from a callback on each `execute`.
- `bodyEncoders` and `responseDecoders` read and write a custom media type.
- A streaming response is an async iterable; `break`, an `AbortSignal` or a custom decoder control it.
- `dates: temporal` reads date fields as `Temporal` values and writes them back as ISO strings.
- `generators/event-models.js` is a generator job that writes `IModel` declarations into `src/event-models/`.
- The profile has validation on and MobX off.

It backs the guide pages [Authentication](../../docs/guide/auth.md), [Body codecs](../../docs/guide/codecs.md), [Streaming responses](../../docs/guide/streams.md), [Dates and times](../../docs/guide/dates.md) and [Run your own generator](../../docs/guide/generators.md).

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm test
npm start
```

- `npm run generate` runs the generator job, the `openapi` job and the `models` job in `golem.yaml`.
- `npm test` checks the generated files, compiles with `ttsc` and runs `src/app.test.ts` against a mocked `fetch`.
- `npm start` prints a hint unless `PAYMENTS_API_BASE_URL` is set. With it set, the example reads the due date of `payment-1` from that API:

```sh
PAYMENTS_API_BASE_URL=https://api.example.com npm start
```

The project does not start an API server. Point the URL at a service that matches `api.yaml`.

Most files under `src/` are short snippets the guides quote. They compile with the project and the tests cover the behavior, but `npm start` does not run them.

Edit `api.yaml`, `golem.yaml` or the authored source and run `npm run generate` again. `sdk/` and the generated model files are replaced.

## Source files

| File | Responsibility |
| --- | --- |
| `api.yaml` | The Payments API contract, including the event streams |
| `golem.yaml` | The generator, `openapi` (with `dates: temporal`) and `models` jobs |
| `generators/event-models.js` | The local generator, exported as `client-features-example/generator` |
| `src/send-payment.ts`, `src/current-token.ts` | Token string and token callback |
| `src/money-client.ts` | Custom body encoder and response decoder |
| `src/read-events.ts`, `src/first-event.ts`, `src/cancel-events.ts`, `src/custom-events.ts` | Read, stop, cancel and custom-decode a stream |
| `src/payment-dates.ts` | Read and write Temporal dates |
| `src/read-event.ts` | Parse into a generated event model |
| `src/main.ts` | The `npm start` entrypoint |
| `src/app.test.ts` | Tests for every behavior above |
