# Authentication

Pass credentials once, and each operation applies what its security requirement asks for.

This page uses the `ProviderClient` of the example's payment provider. Its document declares a bearer security scheme. Add the scheme to `provider.yaml`:

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
security:
  - bearerAuth: []
```

Run `npx golem generate`. The client then has an `auth` option, keyed by security-scheme name. A client whose operations reference no security scheme has no `auth` option.

`provider/client.ts`:

<<< ../../examples/payments/server/provider/client.ts#send-payment

- Your application gets and stores the token.
- To give no credential for a scheme, leave that key out of `auth`. The client then tries the next security requirement.

## Read the current token for each request

Pass a function when the token can change while the client is alive. The client calls it on each `.execute()`.

`provider/client.ts` again:

<<< ../../examples/payments/server/provider/client.ts#current-token

The function can be async. Your application refreshes tokens and signs users in.

## Other schemes

| OpenAPI scheme | Value in `auth` | Request credential |
| --- | --- | --- |
| API key | String, or function that returns a string | Named header, query parameter or cookie |
| HTTP bearer | String, or function that returns a string | Bearer authorization header |
| HTTP Basic | `{ username, password }`, or function that returns it | Basic authorization header |
| OAuth2 and OpenID Connect | Access token, or function that returns it | Bearer authorization header |

- An OAuth function receives the requested scopes and the declared flows.
- An OpenID Connect function receives the `openIdConnectUrl` of the scheme.
- Schemes in one security requirement apply together. Separate requirements are alternatives.
- An empty requirement allows anonymous access. Operation-level security overrides document-level security.

## Missing credentials

If no security requirement has all its credentials, `.execute()` rejects before it calls `fetch`. The rejection is a plain `Error`, not a `LibError`. Its message starts with `No configured credentials satisfy`.

## Mutual TLS

For a declared `mutualTLS` scheme, pass `mutualTls: { fetchImpl }`. Configure that transport with the client certificate first. Mutual TLS uses no token. The client sends every request through `mutualTls.fetchImpl`.
