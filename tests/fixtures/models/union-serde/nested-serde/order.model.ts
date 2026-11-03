import type { IObject } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { writeAmount, readAmount } from './codecs.js';
export type TMoney = IObject<{
  amount: number & TSerde<typeof writeAmount, typeof readAmount>;
  currency: 'USD' | 'EUR';
}>;
type Tag = 'open' | 'closed';
export type TOrder = IObject<{
  money: TMoney;
  tag?: Tag | Tag[];
}, { exact: true }>;
