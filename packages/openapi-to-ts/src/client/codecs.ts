import type { EmissionPlan } from '../emission-plan.js';
import type { OpenApiGenerationProfile } from '../profile.js';

export function mediaEssence(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() || '';
}

export function isBuiltinTextMediaType(contentType: string): boolean {
  const essence = mediaEssence(contentType);
  return essence.startsWith('text/') && !/xml|yaml|yml/.test(essence) && essence !== 'text/event-stream';
}

function emitCodecLookup(mapExpr: string, keysExpr: string): string {
  return `((map, keys) => {
      for (const key of keys) {
        if (key && Object.hasOwn(map, key)) return map[key];
      }
      for (const key of keys) {
        const essence = (key.split(';', 1)[0] || '').trim().toLowerCase();
        if (essence && Object.hasOwn(map, essence)) return map[essence];
      }
      return Object.hasOwn(map, '*/*') ? map['*/*'] : undefined;
    })(${mapExpr}, ${keysExpr})`;
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

function emitEncodeBody(clientName: string, plan: EmissionPlan): string {
  if (!plan.helpers.has('encodeBody')) return '';
  return `
  private isEncodedBody(
    value: BodyInit | ${clientName}EncodedBody,
  ): value is ${clientName}EncodedBody {
    return typeof value === 'object' &&
      value !== null &&
      'body' in value &&
      !(value instanceof Blob) &&
      !(value instanceof FormData) &&
      !(value instanceof URLSearchParams) &&
      !(value instanceof ArrayBuffer);
  }

  public encodeBody(
    operation: OperationName,
    value: unknown,
    contentType: string | undefined,
    mediaMetadata: Record<string, {
      encoding: Record<string, {
        contentType?: string;
        headers?: Record<string, unknown>;
        style?: string;
        explode?: boolean;
        allowReserved?: boolean;
        encoding?: Record<string, unknown>;
        prefixEncoding?: readonly unknown[];
        itemEncoding?: unknown;
      }>;
      prefixEncoding: readonly unknown[];
      itemEncoding: unknown;
      requiredCodec?: string;
      schemaType?: string;
    }>,
  ): { body?: BodyInit; contentType?: string } {
    if (value === undefined || !contentType) return {};
    const essence = (contentType.split(';', 1)[0] || '').trim().toLowerCase();
    const metadata = mediaMetadata[contentType] || mediaMetadata[essence] || {
      encoding: {},
      prefixEncoding: [],
      itemEncoding: null,
    };
    const customEncoder = ${emitCodecLookup('this.bodyEncoders', '[contentType]')};
    if (customEncoder) {
      const encoded = customEncoder(value, { contentType, ...metadata });
      if (this.isEncodedBody(encoded)) return encoded;
      return encoded instanceof FormData ? { body: encoded } : { body: encoded, contentType };
    }
    if (metadata.requiredCodec) {
      throw new Error(
        \`Custom \${metadata.requiredCodec} required for operation \${operation} media \${contentType} type \${metadata.schemaType || 'ambiguous'}\`,
      );
    }
    if (essence.includes('json')) {
      return { body: JSON.stringify(value), contentType };
    }
${plan.hasFormBody ? `    if (essence === 'application/x-www-form-urlencoded') {
      const advancedEncoding = metadata.prefixEncoding.length > 0 ||
        metadata.itemEncoding !== null ||
        Object.values(metadata.encoding).some((item) =>
          item.contentType !== undefined ||
          item.headers !== undefined ||
          item.encoding !== undefined ||
          item.prefixEncoding !== undefined ||
          item.itemEncoding !== undefined
        );
      if (advancedEncoding) {
        throw new Error(
          \`Form media type \${contentType} requires a custom body encoder for nested or content-specific Encoding Objects\`,
        );
      }
      const fields: string[] = [];
      if (typeof value === 'object' && value !== null) {
        for (const [name, item] of Object.entries(value)) {
          const itemEncoding = metadata.encoding[name] || {};
          this.addQueryParameter(
            fields,
            name,
            item,
            itemEncoding.style || 'form',
            itemEncoding.explode === undefined ? true : itemEncoding.explode,
            itemEncoding.allowReserved === true,
          );
        }
      }
      return { body: fields.join('&'), contentType };
    }` : ''}
${plan.hasMultipartBody ? `    if (essence === 'multipart/form-data') {
      const advancedEncoding = metadata.prefixEncoding.length > 0 ||
        metadata.itemEncoding !== null ||
        Object.values(metadata.encoding).some((item) =>
          item.headers !== undefined ||
          item.style !== undefined ||
          item.explode !== undefined ||
          item.allowReserved !== undefined ||
          item.encoding !== undefined ||
          item.prefixEncoding !== undefined ||
          item.itemEncoding !== undefined
        );
      if (advancedEncoding) {
        throw new Error(
          \`Multipart media type \${contentType} requires a custom body encoder for advanced Encoding Object fields\`,
        );
      }
      const form = new FormData();
      const encoding = metadata.encoding;
      if (typeof value === 'object' && value !== null) {
        for (const [name, item] of Object.entries(value)) {
          const values = Array.isArray(item) ? item : [item];
          for (const entry of values) {
            if (entry instanceof Blob) form.append(name, entry);
            else if (encoding[name]?.contentType) {
              const serialized = typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry);
              form.append(name, new Blob([serialized], { type: encoding[name].contentType }));
            }
            else if (typeof entry === 'object' && entry !== null) {
              form.append(name, new Blob([JSON.stringify(entry)], { type: 'application/json' }));
            }
            else form.append(name, String(entry));
          }
        }
      }
      return { body: form };
    }` : ''}
    if (value instanceof Blob || value instanceof FormData || value instanceof URLSearchParams || typeof value === 'string') {
      return { body: value, contentType };
    }
    throw new Error(\`No request body encoder configured for media type: \${contentType}\`);
  }
`;
}

function emitStreamDispatch(
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  validatorsParameter: string,
): string {
  if (!plan.hasItemSchema) {
    return '';
  }
  const helpers = plan.helpers;
  const fallback = "(() => { throw new Error('No stream decoder configured for media type: ' + (selected.contentType || '')); })()";
  const framed = [
    helpers.has('readNdjson') ? "selected.framing === 'ndjson' ? this.readNdjson(response.body)" : null,
    helpers.has('readJsonSeq') ? "selected.framing === 'json-seq' ? this.readJsonSeq(response.body)" : null,
    helpers.has('readServerSentEvents') ? "selected.framing === 'sse' ? this.readServerSentEvents(response.body)" : null,
    fallback,
  ].filter((item): item is string => item !== null);
  const framedExpression = framed.reduceRight((next, clause) => `${clause} : ${next}`);
  const validated = profile.validation && helpers.has('validateStreamItems');
  const wrap = (expression: string): string => (
    validated ? `this.validateStreamItems(operation, selected, ${expression}, ${validatorsParameter})` : expression
  );
  const custom = plan.clientSurfaces.streamDecoders
    ? `
      const customStream = ${emitCodecLookup('this.streamDecoders', '[rawContentType, selected.contentType || \'\']')};
      if (customStream) {
        const framed = customStream(response, { operation, contentType: selected.actualContentType });
        return this.httpResponse(operation, response, selected.status, selected.contentType, ${wrap('framed')}, contracts) as TResponse;
      }`
    : '';
  return `
    if (selected.framing === 'ndjson' || selected.framing === 'json-seq' || selected.framing === 'sse' || selected.framing === 'custom-stream') {
      if (!response.body) throw new Error('Streaming response has no body');
      ${custom}
      const framed = ${framedExpression};
      const body = ${wrap('framed')};
      return this.httpResponse(operation, response, selected.status, selected.contentType, body, contracts) as TResponse;
    }
`;
}

export function emitCodecMethods(
  clientName: string,
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
): string {
  const validatorsParameter = '_validators';
  const readBody = !plan.hasResponseContent ? `
    const selected = this.selectResponse(operation, response, contracts);
    await response.body?.cancel().catch(() => undefined);
    return this.httpResponse(operation, response, selected.status, selected.contentType, undefined, contracts) as TResponse;` : `
    const selected = this.selectResponse(operation, response, contracts);
    const rawContentType = response.headers.get('content-type') || '';
${emitStreamDispatch(profile, plan, validatorsParameter)}
    const mediaType = selected.actualContentType;
    const customDecoder = ${emitCodecLookup('this.responseDecoders', '[rawContentType, selected.contentType || \'\']')};
    let body: unknown;
    if (selected.contentType === null) await response.body?.cancel().catch(() => undefined);
    else if (customDecoder) body = await customDecoder(response);
    else if (selected.requiredCodec) {
      throw new Error(
        \`Custom \${selected.requiredCodec} required for operation \${operation} status \${selected.status} media \${selected.contentType || rawContentType} type \${selected.schemaType || 'ambiguous'}\`,
      );
    }
    else if (mediaType.includes('json')) {
      const text = await response.text();
      body = !text ? undefined : JSON.parse(text);
    }
    else if (/^(application\\/octet-stream|application\\/pdf|application\\/zip|application\\/x-zip-compressed|application\\/gzip|image\\/|audio\\/|video\\/|font\\/)/i.test(mediaType)) {
      body = await response.blob();
    }
    else if (mediaType.startsWith('text/') && !/xml|yaml|yml/i.test(mediaType) && mediaType !== 'text/event-stream') {
      body = await response.text();
    }
    else {
      throw new Error(\`No response decoder configured for media type: \${mediaType || '(empty)'}\`);
    }
${profile.validation ? `    await this.assertValid(this.responseValidator(operation, selected, ${validatorsParameter}), body);` : ''}
    return this.httpResponse(operation, response, selected.status, selected.contentType, body, contracts) as TResponse;`;
  return `${emitEncodeBody(clientName, plan)}
  public async readResponse<TResponse>(
    operation: OperationName,
    response: Response,
    contracts: readonly RuntimeResponseContract[],
    ${validatorsParameter}: OperationRuntimeValidators | undefined,
  ): Promise<TResponse> {
    try {
${readBody.trim().split('\n').map((line) => `      ${line.replace(/^    /, '')}`).join('\n')}
    }
    catch (error) {
      if (response.body && !response.body.locked) {
        try { await response.body.cancel(error); }
        catch { /* Preserve the original protocol or decoder failure. */ }
      }
      throw error;
    }
  }
`;
}
