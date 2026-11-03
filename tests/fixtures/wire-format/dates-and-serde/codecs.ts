export function encodeLevel(value: number): string {
  return value.toString(16);
}
export function decodeLevel(value: string): number {
  return Number.parseInt(value, 16);
}
export function encodeBytes(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
export function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
