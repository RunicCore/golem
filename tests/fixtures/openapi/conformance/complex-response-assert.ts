import type { CreatePaymentOperationHttpResponse, PaymentStatusEvent } from './types.js';

declare const response: CreatePaymentOperationHttpResponse;
if (response.matched === 'status' && response.status === 201) {
  const location: string | undefined = response.headers.Location;
  void location;
  // @ts-expect-error response headers are readonly
  response.headers.Location = 'https://example.test/payments/1';
} else if (response.matched === 'default') {
  // a status this operation does not declare falls back to the default response
  const problemStatus: number = response.status;
  void problemStatus;
}

declare const event: PaymentStatusEvent;
event.failure = null;
// @ts-expect-error PaymentStatusEvent.failure resolves to the Problem schema, not an unconstrained object
event.failure = { random: true };
