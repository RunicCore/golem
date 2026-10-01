import type { IModel } from '@exprtlabs/golem/model';
import { OrderBaseModel } from './order.model.generated.js';

export type TOrder = IModel<{ id: string; total: number }>;
export class PurchaseOrder extends OrderBaseModel {}
export class RushOrder extends PurchaseOrder {}
