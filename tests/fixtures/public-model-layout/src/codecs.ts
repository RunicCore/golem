export function toCents(value: number): string { return String(Math.round(value * 100)); }
export function fromCents(cents: string): number { return Number(cents) / 100; }
