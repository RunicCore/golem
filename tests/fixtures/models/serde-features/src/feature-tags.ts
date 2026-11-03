import type { Format, Integer, Maximum, MaxLength, MinLength, Minimum, Pattern, TSerde, TValidation } from '@exprtlabs/golem/tags';
import { hasReadPermission } from './access-rules.js';

export type Email = string & MinLength<3> & MaxLength<80> & Format<'email'>;
export type Phone = string & MinLength<8> & MaxLength<24> & Pattern<'^\\+[0-9][0-9-]+$'>;
export type MoneyWire = string & Pattern<'^[0-9]+\\.[0-9]{2}$'>;
export type Money = number
  & Integer
  & Minimum<0>
  & Maximum<1_000_000_000>
  & TSerde<typeof encodeMoney, typeof decodeMoney>;

export function encodeMoney(cents: number): MoneyWire {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new RangeError('Money must be a non-negative integer number of cents.');
  }
  const dollars = Math.trunc(cents / 100);
  return `${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

export function decodeMoney(value: MoneyWire): number {
  if (!/^[0-9]+\.[0-9]{2}$/.test(value)) {
    throw new TypeError('Money must be a dollar amount with two decimals.');
  }
  const separator = value.indexOf('.');
  return Number.parseInt(value.slice(0, separator), 10) * 100 + Number.parseInt(value.slice(separator + 1), 10);
}

export function extraMoney(value: { amount: number; currency: string }): boolean | string {
  return value.currency !== 'XXX' || 'reserved';
}

export function notBlank(value: string): boolean | string {
  return value.trim().length > 0 || 'blank';
}

export function positive(value: number): boolean {
  return value > 0;
}

export function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

export function encodeHex(value: number): string {
  return value.toString(16);
}

export function decodeHex(value: string & TValidation<typeof isHex>): number {
  return Number.parseInt(value, 16);
}

export type HexCode = number & TValidation<typeof positive> & TSerde<typeof encodeHex, typeof decodeHex>;

export type YesNoWire = string & Pattern<'^(yes|no)$'>;
export type YesNo = boolean & TSerde<typeof encodeYesNo, typeof decodeYesNo>;

export function encodeYesNo(value: boolean): YesNoWire {
  return (value ? 'yes' : 'no') as YesNoWire;
}

export function decodeYesNo(value: YesNoWire): boolean {
  return value === 'yes';
}

/* The plain twins of the converting tags: the same rules on the wire value, with nothing to convert (the serde-none payload). */
export type PlainMoney = number & Integer & Minimum<0> & Maximum<1_000_000_000>;
export type PlainHexCode = number & TValidation<typeof positive>;
export type PlainPermissions = number & Integer & Minimum<0> & Maximum<255> & TValidation<typeof hasReadPermission>;
export type PlainYesNo = YesNoWire;
export type Stamp = string & Format<'date-time'>;
