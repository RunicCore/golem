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

/**
 * Plain RFC 6901 JSON Pointer token escaping (`~` -> `~0`, `/` -> `~1`), with
 * no percent-encoding. `escapePointerToken`/`unescapePointerToken` from
 * `@exprtlabs/golem/internal/schema` additionally apply `encodeURIComponent`; that
 * is for URI-fragment `$ref` values (e.g. `#/components/schemas/A%20B`), not
 * for a plain in-document JSON Pointer like `OpenApiProblem.pointer`.
 */
export function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Reverses {@link escapeJsonPointerToken}; no percent-decoding. */
export function unescapeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append one raw token to a plain JSON Pointer, escaping it per RFC 6901. */
export function jsonPointerJoin(parent: string, token: string): string {
  return `${parent}/${escapeJsonPointerToken(token)}`;
}

/**
 * Detect the OpenAPI line ('3.1' or '3.2') from `document.openapi`. Any
 * other or missing value is treated as 3.1, matching `checkOpenApiStructure`
 * choosing the 3.1 document schema for it.
 */
export type OpenApiLine = '3.1' | '3.2';

export function openApiLine(document: unknown): OpenApiLine {
  const version = isJsonObject(document) ? String(document.openapi ?? '') : '';
  return version.startsWith('3.2') ? '3.2' : '3.1';
}

/** Resolve a JSON Pointer ('' or '/a/0/b', escaped tokens) through objects and arrays. */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = document;
  for (const token of pointer.slice(1).split('/').map(unescapeJsonPointerToken)) {
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
