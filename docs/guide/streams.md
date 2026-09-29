# Streaming responses

Read an OpenAPI 3.2 operation that streams items one at a time instead of returning one body.

A generated operation's `response.body` is an `AsyncIterable` of decoded items, which you read with `for await`.

```ts
import { EventsClient } from '../sdk/index.js';

const client = new EventsClient({ baseUrl: 'https://api.example.com' });
// API response: {"id":1} followed by a newline, then {"id":2}.
const response = await client.readEvents().execute({});

for await (const event of response.body) {
  console.log(event.id); // Prints 1, then 2 as those items arrive.
}
```

- NDJSON, JSON-seq and SSE have built-in framing.
- Breaking out of the loop cancels its reader.
- `.execute()` returns the response; consuming items is a separate step.
- `response.body` is an `AsyncIterable`. Connection, decoding and validation failures throw inside the loop; wrap the loop in `try`/`catch`.
- With validation enabled, each item is checked before your loop receives it.

## Describe the items

For an API that sends one JSON object per line, describe the response in
`api.yaml`:

```yaml
openapi: 3.2.0
info:
  title: Events
  version: '1'
paths:
  /events:
    get:
      operationId: readEvents
      responses:
        '200':
          description: Events as they happen
          content:
            application/x-ndjson:
              itemSchema:
                type: object
                required: [id]
                properties:
                  id: { type: integer }
```

`runic-codegen.yaml`:

```yaml
version: 1
validation: true
openapi:
  - input: api.yaml
    output: sdk
    name: Events
```

Run `npx runic-codegen generate` to update the client. With the [default
validation dependencies](/guide/install#runtime-dependencies)
installed, each decoded item is checked.

## Stop reading

For the same `GET /events` client, `src/first-event.ts` consumes one item:

```ts
import { EventsClient } from '../sdk/index.js';

const client = new EventsClient({ baseUrl: 'https://api.example.com' });
const response = await client.readEvents().execute({});
for await (const event of response.body) {
  console.log(event.id); // Consume the first event.
  break; // Closes the iterator and cancels its reader.
}
```

`src/cancel-events.ts` — cancel from outside the loop:

```ts
import { EventsClient } from '../sdk/index.js';

const client = new EventsClient({ baseUrl: 'https://api.example.com' });
const controller = new AbortController();
const response = await client.readEvents().execute({}, { signal: controller.signal });
controller.abort(); // For example, when the user closes the activity feed.

try {
  for await (const event of response.body) console.log(event.id);
} catch (error) {
  if (!controller.signal.aborted) throw error;
}
```

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

Declare `application/vnd.example.events` with `itemSchema`, then regenerate
`EventsClient`. The decoder below reads integer lines and yields the objects
declared by `itemSchema`. `src/custom-events.ts`:

```ts
import { EventsClient } from '../sdk/index.js';

// This API sends one integer per line: "7\n8\n" → { id: 7 }, { id: 8 }.
async function* decodeEventIds(response: Response) {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += chunk.value; // A line may span several network chunks.
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) yield { id: Number(line) };
    }
    if (pending) yield { id: Number(pending) };
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export function eventsClient(baseUrl: string) {
  return new EventsClient({
    baseUrl,
    streamDecoders: { 'application/vnd.example.events': decodeEventIds },
  });
}

export async function firstEventId(baseUrl: string) {
  const response = await eventsClient(baseUrl).readEvents().execute({});
  for await (const event of response.body) {
    return event.id; // First line "7" returns 7 and closes the stream.
  }
}

```

| Decoder contract | Requirement |
| --- | --- |
| Signature | `(response: Response, context: EventsStreamDecoderContext) => AsyncIterable<unknown>` |
| Context | Operation name and actual response content type |
| Output | Decoded items matching `itemSchema` |
| Cleanup | Cancel and release any reader you acquire when iteration ends or fails |

- An exact media-type key wins — the actual content type, then the declared one — then its lowercase type/subtype without parameters, then `*/*`.
- A configured decoder overrides built-in framing.
