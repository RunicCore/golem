export let serialized = 0;
export let deserialized = 0;
export function encode(value: unknown): string { serialized += 1; return String(value); }
export function decode(value: string): number { deserialized += 1; return Number(value); }