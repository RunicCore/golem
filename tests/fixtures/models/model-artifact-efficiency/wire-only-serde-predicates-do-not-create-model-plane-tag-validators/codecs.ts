import type { TValidation } from '@exprtlabs/golem/tags';
export function encode(value: number): string { return String(value); }
export function isWire(value: string): boolean { return value.length > 0; }
export function decode(value: string & TValidation<typeof isWire>): number { return Number(value); }