export let calls = 0;
export function reset(): void { calls = 0; }
export function positive(value: unknown): boolean { calls += 1; return typeof value === "number" && value > 0; }