export type Base64 = string;
export function encodeBytes(value: Uint8Array): Base64 { return btoa(String.fromCharCode(...value)); }
export function decodeBytes(value: Base64): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
