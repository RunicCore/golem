import type { IModel } from '@exprtlabs/golem/model';
import type { Money as WireMoney } from '../sdk/index.js';

export type TCart = IModel<{ money: WireMoney; note: string }>;

import { asGenObservable } from '@exprtlabs/golem-openapi-ts/mobx';
import { TCartBaseModel } from './cart.model.generated.js';
import type { TCartFields } from './cart.model.generated.js';

export class Cart extends TCartBaseModel {
  constructor(values: Partial<TCartFields> = {}) {
    super(values);
    asGenObservable(this);
  }
}
