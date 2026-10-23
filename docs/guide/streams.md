# Streaming responses

Read the items of a streaming response one at a time instead of waiting for one body.

An operation that declares `itemSchema` in an OpenAPI 3.2 document has a `response.body` that is an `AsyncIterable` of decoded items. Read it with `for await`.

<<< ../../examples/payments/server/provider/events.ts#read-events

## Describe the items

For an API that sends one JSON object per line, describe the response in `provider.yaml`:

<<< ../../examples/payments/server/provider/provider.yaml#events-operation

The `openapi` job in `golem.yaml` reads that document, as in [Generate a client](/guide/client#point-to-your-openapi-document). Run `npx golem generate` to update the client.

## Read items

- `.execute()` returns the response. Reading the items is a separate step.
- A connection, decoding or validation failure throws inside the loop. Wrap the loop in `try` and `catch`.
- With validation on, the client checks each item before your loop receives it. With validation off, items arrive unchecked.

## Stop reading

For the same `readEvents` operation, `provider/events.ts` reads one item. Leaving the loop cancels its reader:

<<< ../../examples/payments/server/provider/events.ts#first-event

`provider/events.ts` also cancels from outside the loop:

<<< ../../examples/payments/server/provider/events.ts#cancel-events

## Formats

| Content type | Items returned |
| --- | --- |
| `application/x-ndjson`, `application/ndjson`, `application/jsonl`, or a media type that ends with `+jsonl` | a decoded JSON value per line |
| `application/json-seq`, or a media type that ends with `+json-seq` | a decoded JSON value per record |
| `text/event-stream` | an event object, `{ data: string, event?, id?, retry? }` |

A JSON-seq record can span lines. SSE `data` stays a string. Parse it in your application if the server sends JSON in that field. A malformed or truncated JSON-seq body fails the iteration and releases the reader. Any other framing needs a `streamDecoders` entry.

## Connect a custom stream decoder

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
