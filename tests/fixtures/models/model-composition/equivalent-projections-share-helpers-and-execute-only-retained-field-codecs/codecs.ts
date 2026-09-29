
export let retained = 0;
export let removed = 0;
export function encode(value: string): string { retained++; return value.toUpperCase(); }
export function decode(value: string): string { retained++; return value.toLowerCase(); }
export function removedEncode(value: string): string { removed++; return value; }
export function removedDecode(value: string): string { removed++; return value; }
