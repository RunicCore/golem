import { ProviderClient, type ProviderClientOptions } from './sdk/index.js';

// #region create-client
export function createProviderClient(options: ProviderClientOptions): ProviderClient {
  return new ProviderClient(options);
}
// #endregion create-client

// #region send-payment
export function createAuthorizedClient(baseUrl: string, token: string): ProviderClient {
  return new ProviderClient({
    baseUrl,
    auth: { bearerAuth: token }, // Keyed by security scheme name.
  });
}
// The request includes: Authorization: Bearer <token>
// #endregion send-payment

// #region current-token
export function createRefreshingClient(baseUrl: string, currentToken: () => string): ProviderClient {
  // The callback runs on each execute call, so one operation picks up a refreshed token.
  return new ProviderClient({ baseUrl, auth: { bearerAuth: currentToken } });
}
// #endregion current-token

// #region shared-headers
export function createClientWithIdempotencyKey(baseUrl: string, token: string, key: string): ProviderClient {
  return new ProviderClient({
    baseUrl,
    auth: { bearerAuth: token },
    headers: { 'Idempotency-Key': key }, // Sent with every request from this client.
  });
}
// #endregion shared-headers

// #region money-client
export function createMoneyTextClient(baseUrl: string, token: string): ProviderClient {
  return new ProviderClient({
    baseUrl,
    auth: { bearerAuth: token },
    bodyEncoders: {
      'application/vnd.provider.money': (value, { contentType }) => {
        if (typeof value !== 'object' || value === null
          || !('currency' in value) || !('amount' in value)) {
          throw new TypeError('Expected money fields');
        }
        return { body: `${value.currency} ${value.amount}`, contentType }; // { amount: '25.00', currency: 'USD' } → 'USD 25.00'
      },
    },
    responseDecoders: {
      'application/vnd.provider.money': async response => {
        const match = /^([A-Z]{3}) ([0-9]+(?:\.[0-9]{1,2})?)$/.exec(await response.text());
        if (!match) throw new TypeError('Expected money text, such as USD 25.00');
        return { currency: match[1], amount: match[2] }; // Response validation checks this object.
      },
    },
  });
}
// #endregion money-client
