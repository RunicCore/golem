// #region base64-codec
// TSerde functions live in their own module: generated files import them, and a model file cannot be imported back.
import type { Pattern } from '@exprtlabs/golem/tags';

export type Base64 = string & Pattern<'^[A-Za-z0-9+/]*={0,2}$'>;

export function encodeBase64(value: Uint8Array): Base64 {
  return btoa(String.fromCharCode(...value)) as Base64;
}

export function decodeBase64(value: Base64): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
// #endregion base64-codec
