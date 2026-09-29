import type { IObject } from '@exprtlabs/codegen/model';
import type { Pattern, TSerde } from '@exprtlabs/codegen/tags';
type DecimalText = string & Pattern<'^[0-9]+(?:\\.[0-9]{1,2})?$'>;
export const writeAmount = (amount: number): DecimalText => amount.toFixed(2) as DecimalText;
export const readAmount = (text: DecimalText): number => Number(text);
export type TMoney = IObject<{
  amount: number & TSerde<typeof writeAmount, typeof readAmount>;
  currency: 'USD' | 'EUR';
}>;
type Tag = 'open' | 'closed';
export type TOrder = IObject<{
  money: TMoney;
  tag?: Tag | Tag[];
}, { exact: true }>;
