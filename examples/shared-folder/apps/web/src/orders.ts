import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TOrder } from './order.model.js';
import './order.model.generated.js'; // registers the order codec

export function readOrder(text: string): TOrder {
  return parse<TOrder>(text);
}

export function writeOrder(order: TOrder): string {
  return stringify<TOrder>(order);
}
