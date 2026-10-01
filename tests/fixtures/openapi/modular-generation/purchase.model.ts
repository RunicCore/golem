import type { IModel } from '@exprtlabs/golem/model';
import type { Order } from './types.js';
import { PurchaseBaseModel } from './purchase.model.generated.js';
export type TPurchase = IModel<{ order: Order }>;
export class Purchase extends PurchaseBaseModel {}