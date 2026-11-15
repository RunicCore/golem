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

/** The name a URI-fragment pointer token denotes; a malformed percent escape is kept literally. */
export function unescapePointerToken(token: string): string {
  return unescapeJsonPointerToken(decodeUriFragment(token));
}

/** The raw tokens of a pointer: `''` has none, `'/a/b'` has `a` and `b`. */
function splitPointer(pointer: string): string[] {
  return pointer === '' ? [] : pointer.slice(1).split('/');
}

/** The names that the tokens of a plain pointer (`''` or `'/a/b'`) denote. */
export function jsonPointerTokens(pointer: string): string[] {
  return splitPointer(pointer).map(unescapeJsonPointerToken);
}

/** The names that the tokens of a URI-fragment pointer (the text after `#`: `''` or `'/a/b%20c'`) denote. */
export function fragmentPointerTokens(pointer: string): string[] {
  return splitPointer(pointer).map(unescapePointerToken);
}

/**
 * Splits `Name/rest` at its first token: the name that the token denotes, and the remaining pointer as written
 * (`''`, or starting with `/`). It reads a component reference after `#/components/schemas/`.
 */
export function splitFirstFragmentToken(pointer: string): { readonly name: string; readonly rest: string } {
  const slash = pointer.indexOf('/');
  return slash < 0
    ? { name: unescapePointerToken(pointer), rest: '' }
    : { name: unescapePointerToken(pointer.slice(0, slash)), rest: pointer.slice(slash) };
}

/** The value that `tokens` name inside `document`, through objects and arrays; undefined when a token names nothing. */
function walkTokens(document: unknown, tokens: readonly string[]): unknown {
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      current = /^(0|[1-9]\d*)$/.test(token) ? current[Number(token)] : undefined;
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
  return fragment === '' || fragment.startsWith('/') ? walkTokens(document, fragmentPointerTokens(fragment)) : undefined;
}
