# Using the client

Create a client, pass parameters and bodies, read responses and failures, and share or cancel requests.

These examples use this contract, generated as `TasksClient` from the [Tasks example](/guide/client) or equivalent operations from your API.

| Operation | Request | Declared responses |
| --- | --- | --- |
| `listTasks` | `GET /tasks`, optional `limit` / `cursor` query | `200`: array of `{ id, title }` |
| `getTask` | `GET /tasks/{id}` | `200`: task; `404`: `{ message }` |
| `createTask` | `POST /tasks`, body `{ id, title }` | `201`: task |

<<< ../../examples/openapi/src/list-tasks.ts#list-titles

- Responses contain the HTTP `status` and decoded `body`, including declared error statuses.
- Requests and responses are validated when `validation: true` (the default) in `golem.yaml`.
- With MobX enabled, each operation exposes observable `loading` state.

## Create a client

<<< ../../examples/openapi/src/create-client.ts#create-client

| Option | Value |
| --- | --- |
| `baseUrl` | Required, trimmed; rejects an empty string. |
| `fetchImpl` | Defaults to the environment's `fetch`, called without a receiver. |
| `headers` | Merged into every request from this client. |
| `auth` | Values or lazy providers keyed by security-scheme name ([authentication](/guide/auth)). |
| `validationEngine` | Shared schema engine for generated operation and model validation. |
| `operationValidators` | Overrides generated validators for individual operations. |

Response bodies are plain data; call `fromWireFormat<T>(response.body)` for a model instance.

## Pass parameters and a body

<<< ../../examples/openapi/src/task-requests.ts#request-arguments

- `path`, `query`, `header` and `cookie` contain the operation's parameters; `body` contains request data, encoded by the operation's [body codec](/guide/codecs).
- Request validation constraints are checked before `fetch` runs when validation is enabled.
- Only parameter groups declared by the operation appear in its input type; pass `{}` when there are none.
- When sending a model, first call `toWireFormat<T>(model)` to get the plain JSON request body.

## Import one operation or model

A feature that uses one endpoint can import its factory directly:

<<< ../../examples/openapi/src/standalone-operation.ts#standalone-operation

The factory has the existing operation name and accepts client options. It returns the same reusable operation interface as `client.getTask()`, including MobX loading state when enabled. Keep the operation for repeated requests so its setup and validators can be reused.

A client resolves an operation's validators when that operation is first created and reuses them for later calls from the same client instance. A standalone factory builds its own runtime, so it does not share validators with `client.getTask()`. A supplied [`validationEngine`](#create-a-client) that cannot resolve the required schemas fails at that first call.

Models have corresponding public entries:

<<< ../../examples/openapi/src/task-model.ts#task-model

Each entry loads the models, schemas and runtime helpers its dependency graph needs. `index.js` re-exports every client, operation type and model; per-file imports let a bundler drop unused ones. Operation factories are exported from their individual operation modules.

## Read responses and handle failures

Assume `getTask` declares `200` (task) and `404` (`{ message: string }`).

<<< ../../examples/openapi/src/read-task.ts#read-task

- Read response data from `body`; `contentType` and declared response `headers` are available too.
- Connection failures, undeclared status/media types and validation failures reject `.execute()`.
- Several declared responses can match one request; [status and media-type selection follow a fixed order](/reference/openapi-support#response-matching).

`Task.title` declares `minLength: 1`, so an empty title fails before `fetch` runs:

<<< ../../examples/openapi/src/invalid-task.ts#invalid-task

Choose the validation profile in [validation](/guide/validation); find issue shapes and codes in the [runtime API](/reference/runtime-api#errors).

## Handle errors

An undeclared status or media type rejects `.execute()` with `LibErrorKind.Response`. Check it with the generated guard:

<<< ../../examples/openapi/src/handle-errors.ts#handle-errors

Network failures reject with the underlying `fetch` error.

## Reuse an operation

<<< ../../examples/openapi/src/reuse-request.ts#reuse-request

- Every `.execute()` sends a fresh request and reads current authentication. No responses or errors are cached.
- Concurrent calls are allowed. A second `.execute()` that starts before the first finishes logs `Concurrent execute() invocation for <operation>`. The requests still run. Wait for the first call to finish if you do not want that warning.
- A second `client.getTask()` creates an independent operation.

## Observe loading with MobX

Set `mobx: true` in `golem.yaml`, install `mobx`, and generate again.

<<< ../../examples/combined-mobx/src/loading.ts#loading

- `loading` is observable without further setup.
- It stays true until every pending execution settles, including failures and cancellation.
- With MobX disabled, the property is absent.
- For a streaming response, `loading` ends when `execute` resolves, before you read the body as shown in [streams](/guide/streams).

## Share headers

<<< ../../examples/openapi/src/shared-headers.ts#shared-headers

For a header parameter declared in the API document, use the operation's `header` argument. For credentials, use [authentication](/guide/auth).

## Cancel a request

<<< ../../examples/openapi/src/cancel-request.ts#cancel-request

Check `controller.signal.aborted` before rethrowing a caught error; a failure unrelated to the abort should still propagate.

Full example: [`examples/openapi`](https://github.com/exprtlabs/codegen/tree/main/examples/openapi)
