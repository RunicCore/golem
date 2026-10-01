// #region decimal-text
import type { Pattern } from '@exprtlabs/golem/tags';

export type DecimalText = string & Pattern<'^[0-9]+(?:\\.[0-9]{1,2})?$'>;
export const writeAmount = (amount: number): DecimalText => amount.toFixed(2);
export const readAmount = (text: DecimalText): number => Number(text);
// #endregion decimal-text
