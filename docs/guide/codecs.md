# Body formats

Send and receive JSON, form, text and binary bodies, or add your own format.

The examples use the `PaymentsClient` from [SDK types in your models](/guide/models-and-client). Its `createPayment` operation sends a payment as JSON. `money` is `{ amount, currency }` and `amount` is a decimal string.

`web/src/submit-payment.ts`:

<<< ../../examples/payments/web/src/submit-payment.ts#create-payment

Validation checks the request value and the decoded response value. Codecs run even when validation is off.

## Built-in formats

| Declared media | Matches | Request | Response |
| --- | --- | --- | --- |
| JSON | `*json*` | Plain data as JSON text | JSON text as plain data |
| Text | `text/*` except XML, YAML and SSE | String | String |
| URL-encoded form | `application/x-www-form-urlencoded` | Declared form fields | Needs a `responseDecoders` entry |
| Multipart form | `multipart/form-data` | Declared form fields | Needs a `responseDecoders` entry |
| Binary, such as PDF or ZIP | `image/*`, `audio/*`, `video/*`, `font/*`, PDF, ZIP, gzip, octet-stream | `Blob` | `Blob` |
| Empty response | No content declared | None | No body |

- The OpenAPI contract sets the argument and return types.
- For a `Blob` response, call `arrayBuffer()` or `text()` when you need the bytes or the text.
- Let `fetch` set the multipart boundary. An encoder that returns `FormData` must omit `contentType`.
- A form with advanced `encoding` settings in the document needs a `bodyEncoders` entry.
- A response of another media type, such as XML or YAML, needs a `responseDecoders` entry.
- A request body of another media type must be a string, `Blob`, `FormData` or `URLSearchParams`. Otherwise it needs a `bodyEncoders` entry.

## Add a custom format

Suppose the service sends money as text such as `USD 25.00`. Declare `application/vnd.provider.money` for the request and the response, with this decoded schema:

```yaml
schema:
  type: object
  required: [amount, currency]
  properties:
    amount: { type: string, pattern: '^[0-9]+(?:\\.[0-9]{1,2})?$' }
    currency: { type: string, pattern: '^[A-Z]{3}$' }
```

Declare it on a `createChargeText` operation and generate `ProviderClient` again. The provider's `Money` schema has the same fields.

`provider/client.ts`:

<<< ../../examples/payments/server/provider/client.ts#money-client

## Codec options

| Option | Input | Return value |
| --- | --- | --- |
| `bodyEncoders` | The request value (`unknown`) and a context with `contentType` and the encoding rules | `BodyInit`, or `{ body, contentType? }` |
| `responseDecoders` | The `Response` | The decoded value, or a promise of it |

- Each option is an object keyed by media type. For `bodyEncoders`, the client tries the declared request media type, then the type and subtype in lowercase without parameters, then `*/*`.
- For `responseDecoders`, the client tries the actual response content type, then the declared one, then the lowercase type and subtype, then `*/*`.
- A configured codec replaces the built-in handling.
- A decoder must return the shape that the response schema declares.
- A missing required codec, an encoding failure or a decoding failure rejects `.execute()`.
- If your decoder calls `response.body.getReader()`, call `reader.releaseLock()` when it ends or fails. The client can then cancel the unread body.

A text body whose schema allows a type other than string (including `nullable`) needs a codec. Without one, `.execute()` rejects and names the missing option.

A response that sends items one at a time uses [stream decoders](/guide/client-usage#connect-a-custom-stream-decoder) instead.
