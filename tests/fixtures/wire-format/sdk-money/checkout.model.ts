import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/index.js';
import { notReserved } from './rules.js';
import { TCheckoutBaseModel } from './checkout.model.generated.js';

export type TCheckout = IModel<{ money: Money & TValidation<typeof notReserved>; note?: string }>;

export class Checkout extends TCheckoutBaseModel {}
