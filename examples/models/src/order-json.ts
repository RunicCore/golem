import { parse, stringify } from '@exprtlabs/golem/serde';
import { Order } from './order.model.js';
import type { TOrder } from './order.model.js';

// #region read-order
export function readOrder(text: string): Order {
  return parse<Order>(text); // an Order instance: amount is 1250 for "12.50"
}
// #endregion read-order

// #region write-order
export function writeOrder(order: Order): string {
  return stringify<TOrder>(order); // '{"amount":"12.50","priority":"high","remindAt":"…"}'
}
// #endregion write-order
