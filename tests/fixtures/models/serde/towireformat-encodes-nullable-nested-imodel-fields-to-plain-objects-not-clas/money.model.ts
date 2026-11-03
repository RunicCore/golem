import type { IModel } from '@exprtlabs/golem/model';
import { TAccountBaseModel, TCustomerBaseModel } from './money.model.generated.js';
export type TAccount = IModel<{ id: number; code: string }>;
export type TCustomer = IModel<{ id: number; account: TAccount | null }>;
export class Account extends TAccountBaseModel {}
export class Customer extends TCustomerBaseModel {}