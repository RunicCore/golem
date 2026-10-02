import { assertValue, parse, stringify } from '@exprtlabs/golem/serde';
import type { TMoney, TUnkeyed } from './payment.model.js';

declare const text: string;
export const union = parse<TMoney | null>(text);
export const array = stringify<Array<TMoney>>([]);
export const pair = assertValue<TMoney, TMoney>(text);
export const unkeyed = parse<TUnkeyed>(text);
export function generic<T>(value: string): T {
  return parse<T>(value);
}
