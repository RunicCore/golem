import type { IModel } from '@exprtlabs/codegen/model';
import type { Money as WireMoney } from '../sdk/index.js';

export type TCart = IModel<{ money: WireMoney; note: string }>;

import { asGenObservable } from '@exprtlabs/codegen/mobx';
import { CartBase } from './cart.model.generated.js';
import type { CartFields } from './cart.model.generated.js';

export class Cart extends CartBase {
  constructor(values: Partial<CartFields> = {}) {
    super(values);
    asGenObservable(this);
  }
}
