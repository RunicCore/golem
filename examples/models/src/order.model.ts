import { TOrderBaseModel } from './order.model.generated.js';
// #region order-declaration
import type { IModel } from '@exprtlabs/golem/model';
import type { Integer, Minimum, TSerde } from '@exprtlabs/golem/tags';
import type { readAmount, writeAmount } from './decimal-text.js';
import type { fromPriorityWord, toPriorityWord } from './priority-word.js';

export type TOrder = IModel<{
  // Your code adds cents; the JSON carries decimal text.
  amount: number & Integer & Minimum<0> & TSerde<typeof writeAmount, typeof readAmount>;
  // Your code sorts by a number; the JSON carries a word.
  priority: number & TSerde<typeof toPriorityWord, typeof fromPriorityWord>;
  // A Date needs no TSerde: the JSON carries ISO text.
  remindAt: Date;
}>;
// #endregion order-declaration

export class Order extends TOrderBaseModel {}
