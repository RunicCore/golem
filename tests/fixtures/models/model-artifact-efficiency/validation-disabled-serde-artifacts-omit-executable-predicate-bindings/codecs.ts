export function accepts(value: number): boolean { return value > 0; }
export function encode(value: number): string { return String(value); }
export function decode(value: string): number { return Number(value); }
