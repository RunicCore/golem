// #region decimal-text
import type { Pattern } from '@exprtlabs/golem/tags';

export type DecimalText = string & Pattern<'^[0-9]+(?:\\.[0-9]{2})$'>;
// The model keeps integer minor units (cents); JSON carries the exact decimal text.
export const writeAmount = (minorUnits: number): DecimalText => `${Math.trunc(minorUnits / 100)}.${String(minorUnits % 100).padStart(2, '0')}`;
export const readAmount = (text: DecimalText): number => Number(text.replace('.', ''));
// #endregion decimal-text
