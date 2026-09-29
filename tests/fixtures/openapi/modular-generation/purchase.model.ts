import type { IModel } from '@exprtlabs/codegen/model';
import type { Order } from './types.js';
import { PurchaseBase } from './purchase.model.generated.js';
export type TPurchase = IModel<{ order: Order }>;
export class Purchase extends PurchaseBase {}