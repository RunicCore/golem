import type { TValidation } from '@exprtlabs/golem/tags';
export let modelCalls = 0;
export let wireCalls = 0;
export let encodeCalls = 0;
export let decodeCalls = 0;
export let invalidEncoding = false;
export function setInvalidEncoding(value: boolean): void { invalidEncoding = value; }
export function positive(value: number): boolean { modelCalls += 1; return value > 0; }
export function isHex(value: string): boolean { wireCalls += 1; return /^[0-9a-f]+$/i.test(value); }
export function encode(value: number): string { encodeCalls += 1; return invalidEncoding ? "zz" : value.toString(16); }
export function decode(value: string & TValidation<typeof isHex>): number { decodeCalls += 1; return Number.parseInt(value, 16); }