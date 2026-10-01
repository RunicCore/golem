import type { IModel } from '@exprtlabs/golem/model';
import type { Minimum, TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { Money } from '../sdk/index.js';
import type { positive, encode, decode } from './codecs.js';

export type TCart = IModel<{
  money: Money;
  count: number & Minimum<1> & TValidation<typeof positive>;
  when: Date;
  code: number & TSerde<typeof encode, typeof decode>;
}>;

import { CartBaseModel } from './cart.model.generated.js';

export class Cart extends CartBaseModel {}
