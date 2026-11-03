import { parse } from '@exprtlabs/golem/serde';
import type { PurchaseOrder } from './order.model.js';

export const order = parse<PurchaseOrder>('{"id":"o-1","total":3}');
