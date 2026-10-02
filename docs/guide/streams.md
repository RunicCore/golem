# Streaming responses

Read an OpenAPI 3.2 operation that streams items one at a time instead of returning one body.

A generated operation's `response.body` is an `AsyncIterable` of decoded items, which you read with `for await`.

<<< ../../examples/payments/server/provider/events.ts#read-events

- NDJSON, JSON-seq and SSE have built-in framing.
- Breaking out of the loop cancels its reader.
- `.execute()` returns the response; consuming items is a separate step.
- `response.body` is an `AsyncIterable`. Connection, decoding and validation failures throw inside the loop; wrap the loop in `try`/`catch`.
- With validation enabled, each item is checked before your loop receives it.

## Describe the items

For an API that sends one JSON object per line, describe the response in
`provider.yaml`:

<<< ../../examples/payments/server/provider/provider.yaml#events-operation

`golem.yaml`, whose `openapi` job reads that document:

<<< ../../examples/payments/server/golem.yaml#openapi-job

Run `npx golem generate` to update the client. With the [default
validation dependencies](/guide/install#runtime-dependencies)
installed, each decoded item is checked.

## Stop reading

For the same `readEvents` operation, `provider/events.ts` consumes one item:

<<< ../../examples/payments/server/provider/events.ts#first-event

`provider/events.ts` also cancels from outside the loop:

<<< ../../examples/payments/server/provider/events.ts#cancel-events

## Supported formats

| Content type | Items returned |
| --- | --- |
| `application/x-ndjson`, `application/ndjson`, `application/jsonl`, or a media type ending `+jsonl` | One decoded JSON value per line |
| `application/json-seq`, or a media type ending `+json-seq` | Decoded JSON values separated by record separators; values may span lines |
| `text/event-stream` | `{ data: string, event?, id?, retry? }` per event |

SSE `data` stays a string. Parse it in your application if the server sends
JSON in that field. Malformed or truncated JSON-seq fails iteration and
releases the reader. Other framing formats need a custom `streamDecoders`
entry.

## Connect a custom stream decoder

Declare `application/vnd.example.events` with `itemSchema` on a `readEventIds`
operation, then regenerate `ProviderClient`. The decoder below reads integer
lines and yields the objects declared by `itemSchema`. The same file connects it:

<<< ../../examples/payments/server/provider/events.ts#custom-events

| Decoder contract | Requirement |
| --- | --- |
| Signature | `(response: Response, context: ProviderStreamDecoderContext) => AsyncIterable<unknown>` |
| Context | Operation name and actual response content type |
| Output | Decoded items matching `itemSchema` |
| Cleanup | Cancel and release any reader you acquire when iteration ends or fails |

- An exact media-type key wins — the actual content type, then the declared one — then its lowercase type/subtype without parameters, then `*/*`.
- A configured decoder overrides built-in framing.
