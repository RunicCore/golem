import { WireClient } from './client.js';
new WireClient({
  baseUrl: 'https://api.example',
  auth: {
    // @ts-expect-error unknown OpenAPI security scheme
    unknownScheme: 'secret',
  },
});
new WireClient({
  baseUrl: 'https://api.example',
  auth: {
    oauth: (context) => {
      const scope: 'payments:read' | 'payments:write' | undefined = context.scopes[0];
      const tokenUrl: 'https://identity.example/token' = context.flows.clientCredentials.tokenUrl;
      void scope;
      void tokenUrl;
      // @ts-expect-error OAuth context scopes exclude undeclared values
      const invalid: 'payments:delete' = context.scopes[0];
      void invalid;
      return 'token';
    },
    oidc: (context) => {
      const discoveryUrl: 'https://identity.example/.well-known/openid-configuration' = context.openIdConnectUrl;
      void discoveryUrl;
      return 'token';
    },
  },
});
async function checkResponseHeaders(client: WireClient) {
  const response = await client.xmlRoundTrip().execute({ body: { value: 'test' } });
  if (response.status !== 200 || response.contentType !== 'application/xml') return;
  const rate: number | undefined = response.headers['X-Rate'];
  const flags: boolean[] | undefined = response.headers['X-Flags'];
  const count: number | undefined = response.headers['X-Meta']?.count;
  const envelope: { value: string } | undefined = response.headers['X-Envelope'];
  void rate; void flags; void count; void envelope;
}
void checkResponseHeaders;
