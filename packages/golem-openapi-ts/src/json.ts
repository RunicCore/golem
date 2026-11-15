import { escapeJsonPointerToken, jsonPointerTokens, unescapeJsonPointerToken } from '@exprtlabs/golem/internal/schema';

export type JsonObject = { readonly [key: string]: JsonValue | undefined };
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asRecord(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function objectEntries(value: unknown): ReadonlyArray<readonly [string, unknown]> {
  return isJsonObject(value) ? Object.entries(value) : [];
}

/** The entries of a map whose `x-` keys are specification extensions, not members: the `paths` of a document and a callback. */
export function entriesWithoutExtensions(value: unknown): ReadonlyArray<readonly [string, unknown]> {
  return objectEntries(value).filter(([key]) => !key.startsWith('x-'));
}

// Plain RFC 6901 token escaping (no percent-encoding) is `@exprtlabs/golem/internal/schema`'s definition; the
// URI-fragment form of `$ref` values (`#/components/schemas/A%20B`) is its percent-encoding sibling.
export { escapeJsonPointerToken, jsonPointerTokens, unescapeJsonPointerToken };

/** Append one raw token to a plain JSON Pointer, escaping it per RFC 6901. */
export function jsonPointerJoin(parent: string, token: string): string {
  return `${parent}/${escapeJsonPointerToken(token)}`;
}

/** The OpenAPI lines that golem reads; a document names one in its `openapi` field. */
export type OpenApiLine = '3.1' | '3.2';

/**
 * The line of `document.openapi` (`3.1` or `3.2`, with an optional patch number). Every other value, a missing one
 * and a 3.0 document included, is refused with the one error that every reader of the field gives.
 */
export function openApiLine(document: unknown): OpenApiLine {
  const version = String(asRecord(document).openapi ?? '');
  const line = /^(3\.[12])(?:\.\d+)?$/.exec(version)?.[1];
  if (line === '3.1' || line === '3.2') return line;
  if (/^3\.0(?:\.\d+)?$/.test(version)) throw new Error('OpenAPI 3.0 is not supported; convert the document to OpenAPI 3.1 or 3.2');
  throw new Error(`unsupported OpenAPI version "${version}"; expected 3.1 or 3.2`);
}

/** Resolve a JSON Pointer ('' or '/a/0/b', escaped tokens) through objects and arrays. */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = document;
  for (const token of jsonPointerTokens(pointer)) {
    if (Array.isArray(current)) {
      current = /^(0|[1-9]\d*)$/.test(token) ? current[Number(token)] : undefined;
    } else if (isJsonObject(current)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}
