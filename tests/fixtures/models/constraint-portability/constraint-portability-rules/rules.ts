
export let calls = 0;
export function reset(): void { calls = 0; }
export function positive(value: number): boolean { calls++; return value > 0; }
export function negative(value: number): boolean { calls++; return value < 0; }
