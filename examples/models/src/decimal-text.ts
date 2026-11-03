// #region decimal-text
import type { Pattern } from '@exprtlabs/golem/tags';

export type DecimalText = string & Pattern<'^[0-9]+(?:\\.[0-9]{2})$'>;

// The model keeps integer minor units (cents); JSON carries the exact decimal text.
export function writeAmount(minorUnits: number): DecimalText {
  return `${Math.trunc(minorUnits / 100)}.${String(minorUnits % 100).padStart(2, '0')}`;
}

export function readAmount(text: DecimalText): number {
  return Number(text.replace('.', ''));
}
// #endregion decimal-text
