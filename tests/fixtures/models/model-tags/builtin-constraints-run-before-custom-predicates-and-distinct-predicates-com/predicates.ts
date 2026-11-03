export let calls = 0;
export function first(value: unknown): boolean | string { calls += 1; return true; }
export function second(value: unknown): boolean | string { calls += 1; return true; }