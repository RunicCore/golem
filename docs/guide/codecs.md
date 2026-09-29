# Body codecs

Send and receive JSON, form, text and binary bodies, or plug in your own format.

This page uses the `PaymentsClient` from [Models with a client](/guide/models-and-client); its `createPayment` operation accepts and returns `{ amount: number, currency: string }` as JSON.

`src/create-payment.ts`:

```ts
import { PaymentsClient } from '../sdk/index.js';

const client = new PaymentsClient({ baseUrl: 'https://api.example.com' });
const response = await client.createPayment().execute({
  body: { amount: 25, currency: 'USD' },
});
// Request body: {"amount":25,"currency":"USD"}
// Content-Type: application/json
response.body; // Already decoded.
```

- Validation checks the request value or decoded response value; codecs still run when validation is disabled.

## Built-in body formats

| Declared media | Matches | Request | Response |
| --- | --- | --- | --- |
| JSON | `*json*` | Plain data → JSON text | JSON text → plain data |
| Text | `text/*` except XML, YAML and SSE | String only | String only |
| URL-encoded / multipart form | `application/x-www-form-urlencoded`, `multipart/form-data` | Declared form fields | Declared decoded value |
| Binary, such as PDF or ZIP | `image/*`, `audio/*`, `video/*`, `font/*`, PDF, ZIP, gzip, octet-stream | Binary data | `Blob` |
| Empty response | No content declared | — | No body decoding |

- The OpenAPI contract determines the argument and return types.
- For a `Blob` response, call `arrayBuffer()` or `text()` when needed.
- Let `fetch` set multipart boundaries. An encoder returning `FormData` should omit `contentType`.

## Supply a custom format

Suppose the service sends money as text such as `USD 25`. Declare
`application/vnd.example.money` for the request and response, with this decoded
schema:

```yaml
schema:
  type: object
  required: [amount, currency]
  properties:
    amount: { type: number, minimum: 0 }
    currency: { type: string, pattern: '^[A-Z]{3}$' }
```

Regenerate `PaymentsClient` with that media type on `createPayment`. The
[payment contract](/guide/models-and-client) uses the same fields.
`src/money-client.ts`:

```ts
import { PaymentsClient } from '../sdk/index.js';

export const client = new PaymentsClient({
  baseUrl: 'https://api.example.com',
  bodyEncoders: {
    'application/vnd.example.money': (value, { contentType }) => {
      if (typeof value !== 'object' || value === null
        || !('currency' in value) || !('amount' in value)) {
        throw new TypeError('Expected money fields');
      }
      return {
        body: `${value.currency} ${value.amount}`, // { amount: 25, currency: 'USD' } → 'USD 25'
        contentType,
      };
    },
  },
  responseDecoders: {
    'application/vnd.example.money': async response => {
      const text = await response.text();
      const match = /^([A-Z]{3}) ([0-9]+(?:\.[0-9]+)?)$/.exec(text);
      if (!match) throw new TypeError('Expected money text, such as USD 25');
      // 'USD 25' → { currency: 'USD', amount: 25 }; response validation checks this object.
      return { currency: match[1], amount: Number(match[2]) };
    },
  },
});

const response = await client.createPayment().execute({
  body: { amount: 25, currency: 'USD' },
});
console.log(response.body); // If the API echoes USD 25: { currency: 'USD', amount: 25 }
```

## Codec options

| Option | Input | Return value |
| --- | --- | --- |
| `bodyEncoders` | Request value (`unknown`) and context (`contentType`, encoding metadata) | `BodyInit` or `{ body, contentType? }` |
| `responseDecoders` | `Response` | Decoded value or promise of one |

- An exact media-type key wins, then its lowercase type/subtype without parameters, then `*/*`. Matching does not depend on key insertion order. A configured codec overrides built-in handling.
- The decoder must return the shape declared in the response schema.
- Missing required codecs, encoding failures and decoding failures reject `.execute()`.
- The client cancels an unconsumed response body after a protocol or decoder failure. If your decoder calls `response.body.getReader()`, call `reader.releaseLock()` when done.

A text body whose schema allows non-strings (including `nullable`) needs a codec. Without one, `.execute()` rejects and names the missing option.

For item-by-item responses, use [streams](/guide/streams).
