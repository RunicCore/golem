import type { IModel } from '@exprtlabs/golem/model';
import { AccountBaseModel, CustomerBaseModel } from './money.model.generated.js';
export type TAccount = IModel<{ id: number; code: string }>;
export type TCustomer = IModel<{ id: number; account: TAccount | null }>;
export class Account extends AccountBaseModel {}
export class Customer extends CustomerBaseModel {}