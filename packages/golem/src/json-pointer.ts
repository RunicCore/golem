/**
 * JSON Pointer tokens (RFC 6901). The plain form escapes `~` as `~0` and `/` as `~1`. The
 * URI-fragment form (`#/components/schemas/<token>`) applies the plain escapes, then
 * percent-encoding; unescaping reverses both in the opposite order.
 */

/** A name as a plain pointer token: no percent-encoding, for a pointer that is not part of a URI. */
export function escapeJsonPointerToken(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Reverses {@link escapeJsonPointerToken}; no percent-decoding. */
export function unescapeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** A name as a pointer token inside a URI fragment. */
export function escapePointerToken(name: string): string {
  return encodeURIComponent(escapeJsonPointerToken(name));
}

/** A URI fragment with its percent escapes decoded; a malformed escape keeps the text as written. */
export function decodeUriFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** The raw tokens of a pointer: `''` has none, `'/a/b'` has `a` and `b`. */
function splitPointer(pointer: string): string[] {
  return pointer === '' ? [] : pointer.slice(1).split('/');
}

/** The names that the tokens of a plain pointer (`''` or `'/a/b'`) denote. */
export function jsonPointerTokens(pointer: string): string[] {
  return splitPointer(pointer).map(unescapeJsonPointerToken);
}

/**
 * The names that the tokens of a URI-fragment pointer (the text after `#`: `''` or `'/a/b%20c'`) denote. The fragment is
 * percent-decoded as a whole, then split and unescaped (RFC 6901 section 6), so `%2F` separates tokens and `~1` is the
 * escape for a `/` inside a name.
 */
export function fragmentPointerTokens(pointer: string): string[] {
  return jsonPointerTokens(decodeUriFragment(pointer));
}

/**
 * Splits the URI-fragment pointer `Name/rest` at its first token, as {@link fragmentPointerTokens} reads it: the first
 * token ends at a `/` or at a `%2F`. Returns the name that the token denotes, and the remaining pointer as written
 * (`''`, or starting with `/`). It reads a component reference after `#/components/schemas/`.
 */
export function splitFirstFragmentToken(pointer: string): { readonly name: string; readonly rest: string } {
  const end = pointer.search(/\/|%2f/i);
  const first = end < 0 ? pointer : pointer.slice(0, end);
  return {
    name: fragmentPointerTokens(`/${first}`)[0] ?? '',
    rest: end < 0 ? '' : pointer.slice(end).replace(/^%2f/i, '/'),
  };
}

/** The position that a pointer token names in an array: a canonical decimal (`0`, `12`; not `01`, `1e0` or `length`). */
export function pointerArrayIndex(token: string): number | undefined {
  return /^(0|[1-9]\d*)$/.test(token) ? Number(token) : undefined;
}

/** The value that `tokens` name inside `document`, through objects and arrays; undefined when a token names nothing. */
function walkTokens(document: unknown, tokens: readonly string[]): unknown {
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = pointerArrayIndex(token);
      current = index === undefined ? undefined : current[index];
    } else if (typeof current === 'object' && current !== null) {
      current = Object.hasOwn(current, token) ? Reflect.get(current, token) : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

/** The value that a plain pointer (`''` or `'/a/0/b'`, escaped tokens, no percent-decoding) names inside `document`. */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return pointer === '' || pointer.startsWith('/') ? walkTokens(document, jsonPointerTokens(pointer)) : undefined;
}

/** The value that a URI-fragment pointer (the text after `#`: `''` or `'/a/b%20c'`) names inside `document`. */
export function resolveFragmentPointer(document: unknown, fragment: string): unknown {
  return resolveJsonPointer(document, decodeUriFragment(fragment));
}
