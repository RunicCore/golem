# OpenAPI client example

This complete project generates a typed client for a Tasks API from `api.yaml` and calls it.

- `golem generate` writes the client into `sdk/`: operations, request and response types, and a `TasksClient`.
- Operations take path, query and body arguments, reject an invalid request before `fetch`, and return decoded response bodies.
- A client sets shared headers, reuses an operation for several requests, and cancels with an `AbortSignal`.
- Declared and undeclared error responses have separate handling.
- The profile has validation on and MobX off.

It backs the guide pages [Generate a client](../../docs/guide/client.md) and [Using the client](../../docs/guide/client-usage.md), and the [runtime API](../../docs/reference/runtime-api.md).

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm test
npm start
```

- `npm run generate` runs the `openapi` job in `golem.yaml`.
- `npm test` checks the generated files, compiles with `ttsc` and runs `src/app.test.ts` against a mocked `fetch`.
- `npm start` prints a hint unless `TASKS_API_BASE_URL` is set. With it set, the example lists tasks from that API:

```sh
TASKS_API_BASE_URL=https://api.example.com npm start
```

The project does not start an API server. Point the URL at a service that matches `api.yaml`.

Edit `api.yaml` or the authored source and run `npm run generate` again. Everything under `sdk/` is replaced.

## Source files

| File | Responsibility |
| --- | --- |
| `api.yaml` | The Tasks API contract |
| `golem.yaml` | The `openapi` job |
| `src/create-client.ts`, `src/list-tasks.ts` | Build a client from a base URL and list tasks |
| `src/task-requests.ts`, `src/read-task.ts`, `src/invalid-task.ts` | Request arguments, found and missing tasks, request validation |
| `src/standalone-operation.ts`, `src/reuse-request.ts` | Import one operation; reuse an operation for two requests |
| `src/handle-errors.ts`, `src/shared-headers.ts`, `src/cancel-request.ts` | Undeclared responses, shared headers, cancellation |
| `src/task-model.ts` | Turn wire data into a `TaskModel` instance |
| `src/main.ts` | The `npm start` entrypoint |
| `src/app.test.ts` | Tests for every behavior above |
