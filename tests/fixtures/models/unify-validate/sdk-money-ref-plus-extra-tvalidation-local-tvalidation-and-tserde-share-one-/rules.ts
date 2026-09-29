import type { TValidation } from '@exprtlabs/codegen/tags';
/** Counts calls so tests can check each rule runs once per conversion. */
export let extraMoneyCalls = 0;
export function extraMoney(value: { amount: number; currency: string }): boolean | string {
  extraMoneyCalls++;
  return value.currency !== "XXX" || "reserved";
}
export function notBlank(value: string): boolean | string { return value.trim().length > 0 || "blank"; }
export function positive(value: number): boolean { return value > 0; }
export function isHex(value: string): boolean { return /^[0-9a-f]+$/i.test(value); }
export function encodeHex(value: number): string { return value.toString(16); }
export function decodeHex(value: string & TValidation<typeof isHex>): number { return Number.parseInt(value, 16); }