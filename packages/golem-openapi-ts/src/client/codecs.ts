import { mediaEssence } from '@exprtlabs/golem/internal/generator-support';

export function isBuiltinTextMediaType(contentType: string): boolean {
  const essence = mediaEssence(contentType);
  return essence.startsWith('text/') && !/xml|yaml|yml/.test(essence) && essence !== 'text/event-stream';
}

export function isBinaryMediaType(contentType: string): boolean {
  return /^(application\/octet-stream|application\/pdf|application\/zip|application\/x-zip-compressed|application\/gzip|image\/|audio\/|video\/|font\/)/i.test(mediaEssence(contentType));
}

export function isNdjsonMediaType(contentType: string): boolean {
  return /^(application\/(?:x-ndjson|ndjson|jsonl)|[^/]+\/[^;]+\+jsonl)$/i.test(mediaEssence(contentType));
}

export function isJsonSeqMediaType(contentType: string): boolean {
  return /^(application\/json-seq|[^/]+\/[^;]+\+json-seq)$/i.test(mediaEssence(contentType));
}

export function isServerSentEventsMediaType(contentType: string): boolean {
  return /^text\/event-stream$/i.test(mediaEssence(contentType));
}
