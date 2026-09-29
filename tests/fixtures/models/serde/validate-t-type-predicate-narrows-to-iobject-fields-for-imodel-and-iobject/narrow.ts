import { validate } from '@exprtlabs/codegen/validation';
import type { IObject } from '@exprtlabs/codegen/model';
import type { TMoney, TPayment } from './money.model.js';
export function asMoney(value: unknown): string | undefined {
  if (validate<TMoney>(value)) {
    const money: IObject<{ currency: string; value: string }> = value;
    return money.currency;
  }
  return undefined;
}
export function asPayment(value: unknown): string | undefined {
  if (validate<TPayment>(value)) {
    const payment: IObject<{ id: string; amount: TMoney; note: string }> = value;
    return payment.id;
  }
  return undefined;
}