// #region base64-codec
import type { Pattern } from '@exprtlabs/golem/tags';

export type Base64 = string & Pattern<'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'>;

export function encodeBase64(value: Uint8Array): Base64 {
  let binary = '';
  // Chunks keep the argument list of fromCharCode short for large inputs.
  for (let start = 0; start < value.length; start += 0x8000) {
    binary += String.fromCharCode(...value.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value: Base64): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
// #endregion base64-codec
