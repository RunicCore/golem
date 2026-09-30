/**
 * JSON Pointer tokens as they appear in a URI fragment (`#/components/schemas/<token>`).
 * Escaping applies the RFC 6901 `~0`/`~1` escapes, then percent-encoding; unescaping
 * reverses both in the opposite order.
 */

/** A name as a pointer token inside a URI fragment. */
export function escapePointerToken(name: string): string {
  return encodeURIComponent(name.replace(/~/g, '~0').replace(/\//g, '~1'));
}

/** The name a URI-fragment pointer token denotes; a malformed percent escape is kept literally. */
export function unescapePointerToken(token: string): string {
  let decoded = token;
  try { decoded = decodeURIComponent(token); } catch { /* keep the token as written */ }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}
