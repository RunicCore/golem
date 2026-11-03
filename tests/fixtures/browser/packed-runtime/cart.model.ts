import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { Money as WireMoney } from '../sdk/index.js';
import type { positive, encode, decode } from './codecs.js';

export type TCart = IModel<{
  money: WireMoney;
  note: string;
  count: number & TValidation<typeof positive>;
  code: number & TSerde<typeof encode, typeof decode>;
}>;

import { asGenObservable } from '@exprtlabs/golem-openapi-ts/mobx';
import { TCartBaseModel, type TCartInit } from './cart.model.generated.js';

export class Cart extends TCartBaseModel {
  constructor(values: TCartInit = {}) {
    super(values);
    asGenObservable(this);
  }
}
