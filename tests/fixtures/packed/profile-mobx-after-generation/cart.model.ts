import type { IModel } from '@exprtlabs/golem/model';
import type { Money as WireMoney } from '../sdk/index.js';

export type TCart = IModel<{ money: WireMoney; note: string }>;

import { asGenObservable } from '@exprtlabs/golem/mobx';
import { CartBaseModel } from './cart.model.generated.js';
import type { CartFields } from './cart.model.generated.js';

export class Cart extends CartBaseModel {
  constructor(values: Partial<CartFields> = {}) {
    super(values);
    asGenObservable(this);
  }
}
