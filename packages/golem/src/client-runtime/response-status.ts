/** How a declared response status key matches a response: one status code, a class (`2XX`), or any other (`default`). */
export type ResponseStatusKind = 'status' | 'range' | 'default';

/** The kind of a declared response status key (OpenAPI response keys); undefined for text that is none of the three. The one reader of these keys. */
export function responseStatusKind(status: string): ResponseStatusKind | undefined {
  if (status === 'default') return 'default';
  if (/^\d{3}$/.test(status)) return 'status';
  return /^[1-5]XX$/i.test(status) ? 'range' : undefined;
}
