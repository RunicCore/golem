# Call operations

Create a client, send requests, read responses and errors, and share or cancel requests.

These examples use the `ProviderClient` that [Generate an SDK](/guide/client) creates. You can use the same operations from your own API.

| Operation | Request | Declared responses |
| --- | --- | --- |
| `listCharges` | `GET /charges`, optional `limit` and `cursor` query | `200`: array of charges |
| `getCharge` | `GET /charges/{id}` | `200`: charge. `404`: `{ message }` |
| `createCharge` | `POST /charges`, body `{ amount, currency }` | `201`: charge |

<<< ../../examples/payments/server/provider/charges.ts#list-charge-ids

A response holds the HTTP `status` and the decoded `body`. This includes declared error statuses.

## Create a client

<<< ../../examples/payments/server/provider/client.ts#create-client

| Option | Value |
| --- | --- |
| `baseUrl` | the API address; required when the document lists no `servers`, and it wins over `server` and over the servers of an operation |
| `server` | a number is the index of a document server; a string is its `name` or `description`. The first server by default |
| `serverVariables` | values for the `{variables}` of that server URL |
| `fetchImpl` | the `fetch` function, global `fetch` by default |
| `headers` | headers for every request |
| `auth` | credentials by security-scheme name ([Authentication](/guide/auth)) |
| `operationValidators` | validators that replace generated ones ([Runtime API](/reference/runtime-api#runtime-validators)) |

- An empty `baseUrl` is an error.
- The client has `server` and `serverVariables` only when the document lists `servers`.
- `server` and `serverVariables` choose from the `servers` list of the document root.
- An operation, or a path item, that lists its own `servers` uses the first server of that list with its variable defaults, whatever `server` is. `baseUrl` still wins.
- A variable that you leave out uses its default. A value outside its `enum`, or a variable that the server does not declare, is an error.
- A relative server URL such as `/api` is used as written. It works where `fetch` accepts a relative URL, such as a browser.
- A value of `auth` can be a function that returns the credentials.
- `operationValidators` replaces the generated validator of each named operation.

## Pass parameters and a body

<<< ../../examples/payments/server/provider/charges.ts#request-arguments

- `path`, `query`, `header` and `cookie` hold the operation's parameters. `body` holds the request data, encoded by the [body format](/guide/codecs) of the operation.
- The input type has a group only when the operation declares it. A group is optional when none of its members is required. Pass `{}` when nothing is required.
- When the operation accepts several media types, set `body` to `{ contentType, value }`.
- To send a model, call `toWireFormat<T>(model)` first. The result is the plain JSON request body.
- With validation on, the client checks the input before it calls `fetch`.

## Import one operation or model

A feature that uses one endpoint imports its operation factory:

<<< ../../examples/payments/server/provider/charges.ts#standalone-operation

The factory has the name of the operation and takes the client options. It returns the same operation as `client.getCharge()`, with `loading` when MobX is on. Create the operation once and call `.execute()` for each request. If `.execute()` fails with a `ValidationUnavailable` error and the message `Missing generated input validator for <operation>`, run `golem generate` again.

The SDK names each schema in PascalCase and adds `Model` for the runtime class ([Generated SDK names](/reference/generated-files#generated-sdk-names)). The schema `Charge` gives the JSON data type `Charge` and the class `ChargeModel`. A response body is plain data. Call `fromWireFormat<T>` to get a model instance:

<<< ../../examples/payments/server/provider/charges.ts#charge-model

`sdk/index.js` exports every client, operation type and model. Import a model or an operation from its own file to let your bundler drop what you do not use. Find the paths in [Generated files](/reference/generated-files#public-paths).

## Read responses and handle failures

`getCharge` declares `200` (charge) and `404` (`{ message: string }`).

<<< ../../examples/payments/server/provider/charges.ts#read-charge

- Read response data from `body`. The response also holds `contentType` and the declared response `headers`.
- Connection failures, undeclared status or media types, and validation failures reject `.execute()`.
- When several declared responses fit one reply, the client picks one in [a fixed order](/reference/openapi-support#response-matching).

`Money.amount` declares a decimal `pattern`, so `'12,50'` fails before `fetch` runs:

<<< ../../examples/payments/server/provider/charges.ts#invalid-charge

Turn the checks on or off with the [`validation` key](/reference/config#validation-profiles). [Errors and issues](/guide/validation#errors-and-issues) shows how to read `error.issues`. The [runtime API](/reference/runtime-api#errors) holds the issue codes.

## Handle errors

An undeclared status or media type rejects `.execute()` with `LibErrorKind.Response`. Check it with the generated guard:

<<< ../../examples/payments/server/provider/charges.ts#handle-errors

A network failure rejects with the `fetch` error.

## Streaming responses

Read the items of a streaming response one at a time instead of waiting for one body.

An operation that declares `itemSchema` in an OpenAPI 3.2 document has a `response.body` that is an `AsyncIterable` of decoded items. Read it with `for await`.

<<< ../../examples/payments/server/provider/events.ts#read-events

### Describe the items

For an API that sends one JSON object per line, describe the response in `provider.yaml`:

<<< ../../examples/payments/server/provider/provider.yaml#events-operation

The `openapi` job in `golem.yaml` reads that document, as in [Generate an SDK](/guide/client#point-to-your-openapi-document). Run `npx golem generate` to update the client.

### Read items

- `.execute()` returns the response. Reading the items is a separate step.
- A connection, decoding or validation failure throws inside the loop. Wrap the loop in `try` and `catch`.
- With validation on, the client checks each item before your loop receives it. With validation off, items arrive unchecked.

### Stop reading

For the same `readEvents` operation, `provider/events.ts` reads one item. Leaving the loop cancels its reader:

<<< ../../examples/payments/server/provider/events.ts#first-event

`provider/events.ts` also cancels from outside the loop:

<<< ../../examples/payments/server/provider/events.ts#cancel-events

### Stream formats

| Content type | Items returned |
| --- | --- |
| `application/x-ndjson`, `application/ndjson`, `application/jsonl`, or a media type that ends with `+jsonl` | a decoded JSON value per line |
| `application/json-seq`, or a media type that ends with `+json-seq` | a decoded JSON value per record |
| `text/event-stream` | an event object, `{ data: string, event?, id?, retry? }` |

A JSON-seq record can span lines. SSE `data` stays a string. Parse it in your application if the server sends JSON in that field. A malformed or truncated JSON-seq body fails the iteration and releases the reader. Any other framing needs a `streamDecoders` entry.

### Connect a custom stream decoder

Declare `application/vnd.provider.events` with `itemSchema` on a `readEventIds` operation, then generate `ProviderClient` again. The decoder below reads integer lines and yields the objects that `itemSchema` declares. The same file connects it:

<<< ../../examples/payments/server/provider/events.ts#custom-events

| Decoder contract | Requirement |
| --- | --- |
| Signature | `(response: Response, context: ProviderStreamDecoderContext) => AsyncIterable<unknown>` |
| Context | The operation name and the actual response content type |
| Output | Decoded items that match `itemSchema` |
| Cleanup | Cancel and release each reader you acquire when the iteration ends or fails |

- The client uses the exact media-type key first. This is the actual content type, then the declared one. Next it tries the type and subtype in lowercase without parameters, then `*/*`.
- A configured decoder replaces the built-in framing.

## Reuse an operation

<<< ../../examples/payments/server/provider/charges.ts#reuse-request

- Each `.execute()` sends a new request and reads the current credentials. The client caches no responses or errors.
- You can call `.execute()` again before the first call ends. The client then logs `Concurrent execute() invocation for <operation>` and sends both requests. To avoid the warning, wait for the first call.
- A second `client.getCharge()` creates an independent operation.

## Observe loading with MobX

Set `mobx: true` in `golem.yaml`, install `mobx`, and generate again.

<<< ../../examples/payments/web/src/payment-store.ts#loading

- `loading` is observable without more setup.
- It stays true until every pending call ends, including failed and cancelled calls.
- With MobX off, the operation has no `loading` property.
- For a streaming response, `loading` ends when `execute` resolves, before you read the body ([Streaming responses](#streaming-responses)).

## Share headers

<<< ../../examples/payments/server/provider/client.ts#shared-headers

For a header parameter in the API document, use the `header` argument of the operation. For credentials, use [Authentication](/guide/auth).

## Cancel a request

<<< ../../examples/payments/server/provider/charges.ts#cancel-request

Check `controller.signal.aborted` before you rethrow a caught error. An error that has nothing to do with the abort must still propagate.

Full example: [`examples/payments`](https://github.com/RunicCore/golem/tree/master/examples/payments).
