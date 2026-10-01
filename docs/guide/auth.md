# Authentication

Pass credentials once and let each operation apply what its security requirement asks for.

This page uses a `PaymentsClient` for the [payments contract](/guide/models-and-client) with a bearer security scheme.

Add the security scheme to `api.yaml`:

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
security:
  - bearerAuth: []
```

After saving the security scheme, run:

```sh
npx golem generate
```

`src/send-payment.ts`:

<<< ../../examples/client-features/src/send-payment.ts#send-payment

- A callback is evaluated for each `.execute()` call, for example `auth: { oauth: ({ scopes }) => tokens.get(scopes) }`.
- Your application obtains and stores the token. Return `undefined` when no credential is available; the client then tries the next security requirement.

Only credentials declared directly on the `auth` object are used; inherited properties are ignored. A client whose document references no security scheme has no generated `auth` option.

## Read the current token for each request

Pass a callback when the token can change while the client is alive.
`src/current-token.ts`:

<<< ../../examples/client-features/src/current-token.ts#current-token

An async callback works too. Token refresh and sign-in remain application
responsibilities.

## Other schemes

| OpenAPI scheme | Value in `auth` | Request credential |
| --- | --- | --- |
| API key | String or callback returning a string | Named header, query parameter or cookie |
| HTTP bearer | String or callback returning a string | Bearer authorization header |
| HTTP Basic | `{ username, password }` or callback returning it | Basic authorization header |
| OAuth2 / OpenID Connect | Access token or callback returning it | Bearer authorization header |

- OAuth callbacks receive the requested scopes and declared flow information.
- OpenID Connect callbacks receive the discovery URL; the client does not perform discovery.
- Schemes in one security requirement apply together. Separate requirements are alternatives.
- An empty requirement allows anonymous access. Operation-level security overrides document-level security.

## Missing credentials

If no security requirement can be satisfied, `.execute()` rejects before
calling `fetch`. It rejects with a plain `Error` (not `LibError`) whose
message starts `No configured credentials satisfy`.

## Mutual TLS

For a declared `mutualTLS` scheme, pass `mutualTls: { fetchImpl }`. The
transport must already be configured with the client certificate. Mutual TLS
does not use a token. `mutualTls.fetchImpl` becomes the transport for every
request from this client.
