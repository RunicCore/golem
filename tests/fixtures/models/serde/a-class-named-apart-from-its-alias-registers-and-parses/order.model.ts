import type { IModel } from '@exprtlabs/golem/model';
import { TOrderBaseModel } from './order.model.generated.js';

export type TOrder = IModel<{ id: string; total: number }>;
export class PurchaseOrder extends TOrderBaseModel {}
export class RushOrder extends PurchaseOrder {}
