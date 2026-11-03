export let predicateCalls = 0;
export let serialized = 0;
export let deserialized = 0;
export const valid = (value: unknown): boolean | string => { predicateCalls += 1; return value !== "bad"; };
export function encodeDate(value: Date): string { serialized += 1; return value.toISOString(); }
export function decodeDate(value: string): Date { deserialized += 1; return new Date(value); }