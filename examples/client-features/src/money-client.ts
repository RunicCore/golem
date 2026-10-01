// #region money-client
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

const response = await client.createPaymentText().execute({
  body: { amount: 25, currency: 'USD' },
});
console.log(response.body); // If the API echoes USD 25: { currency: 'USD', amount: 25 }
// #endregion money-client
