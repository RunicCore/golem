export let encodeCalls = 0;
export function encodeOptional(value: string): string { encodeCalls += 1; return value.toUpperCase(); }
export function decodeOptional(value: string): string { return value.toLowerCase(); }