import { fromWireFormat, parse, stringify } from '@exprtlabs/golem/serde';
import { PaymentsClient } from '../sdk/index.js';
import type { Payment, TPaymentInput } from './payment.model.js';

// The compiler plugin rewrites these calls by their type argument, so they live
// in a compiled module that verify.mjs imports.
export const parseInput = (json: string): TPaymentInput => parse<TPaymentInput>(json);
export const stringifyInput = (value: TPaymentInput): string => stringify<TPaymentInput>(value);

export async function submitPayment(client: PaymentsClient, draft: TPaymentInput): Promise<Payment> {
  const response = await client.createPayment().execute({ body: draft });
  return fromWireFormat<Payment>(response.body);
}
