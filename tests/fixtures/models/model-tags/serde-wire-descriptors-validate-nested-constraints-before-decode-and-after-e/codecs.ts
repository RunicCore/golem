import type { MinLength } from '@exprtlabs/golem/tags';
export let encodeCalls = 0;
export let decodeCalls = 0;
export type Wire = { code: string & MinLength<3> };
export function encode(value: number): Wire { encodeCalls += 1; return { code: String(value) }; }
export function decode(value: Wire): number { decodeCalls += 1; return Number(value.code); }