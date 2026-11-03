import type { TSerde } from '@exprtlabs/golem/tags';
export type WireCode = string & { readonly __wireCode?: never };
export let encodeCalls = 0;
export function encode(value: number): WireCode { encodeCalls += 1; return String(value) as WireCode; }
export function decode(value: WireCode): number { return Number(value); }
export type Code = number & TSerde<typeof encode, typeof decode>;