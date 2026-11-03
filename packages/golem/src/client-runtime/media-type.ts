/** A media type or media range with its parameters dropped: lowercase `type/subtype`, split at the slash (`*` for a range part). */
export interface MediaType {
  readonly essence: string;
  readonly type: string;
  readonly subtype: string | undefined;
}

/** Reads a `Content-Type` value or an `Accept` media range; the one place that cuts parameters off and lowercases (RFC 9110 section 8.3.1). */
export function parseMediaType(value: string): MediaType {
  const essence = value.split(';', 1)[0]?.trim().toLowerCase() || '';
  const [type = '', subtype] = essence.split('/');
  return { essence, type, subtype };
}

export function mediaEssence(value: string): string {
  return parseMediaType(value).essence;
}

/** Whether `value` is `application/json` or a structured syntax suffix `+json` type; `application/x-ndjson` is not (RFC 6839). */
export function isJsonMediaType(value: string): boolean {
  const { essence } = parseMediaType(value);
  return essence === 'application/json' || essence.endsWith('+json');
}
