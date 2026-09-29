import type { ClientHelperName, EmissionPlan } from '../emission-plan.js';

function when(helpers: ReadonlySet<ClientHelperName>, name: ClientHelperName, source: string): string {
  return helpers.has(name) ? source : '';
}

export function emitTransportMethods(clientName: string, plan: EmissionPlan): string {
  const helpers = plan.helpers;
  return `
${when(helpers, 'url', `
  public url(route: string, query: string[]): string {
    const suffix = query.length ? \`?\${query.join('&')}\` : '';
    return \`\${this.baseUrl}\${route}\${suffix}\`;
  }
`)}
${when(helpers, 'formValue', `
  private formValue(form: URLSearchParams, name: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) form.append(name, String(item));
      return;
    }
    form.set(name, String(value));
  }
`)}
${when(helpers, 'encode', `
  public encode(value: unknown, allowReserved = false): string {
    const text = String(value);
    if (!allowReserved) return encodeURIComponent(text);
    // allowReserved: RFC 3986 reserved characters stay literal except those that
    // would change the query's structure (# [ ] & +); existing %XX triples pass through.
    return text.split(/(%[0-9A-Fa-f]{2})/).map((part, index) => index % 2 === 1
      ? part
      : encodeURIComponent(part).replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B|3D)/gi, (match) =>
        String.fromCharCode(Number.parseInt(match.slice(1), 16)))).join('');
  }
`)}
${when(helpers, 'entries', `
  private entries(value: unknown): Array<[string, unknown]> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : [];
  }
`)}
${when(helpers, 'serializeSimple', `
  private serializeSimple(value: unknown, explode: boolean): string {
    if (Array.isArray(value)) return value.map((item) => this.encode(item)).join(',');
    const entries = this.entries(value);
    if (entries.length) {
      return entries.map(([key, item]) =>
        explode ? \`\${this.encode(key)}=\${this.encode(item)}\` : \`\${this.encode(key)},\${this.encode(item)}\`
      ).join(',');
    }
    return this.encode(value);
  }
`)}
${when(helpers, 'serializeHeaderSimple', `
  public serializeHeaderSimple(value: unknown, explode: boolean): string {
    if (Array.isArray(value)) return value.map((item) => String(item)).join(',');
    const entries = this.entries(value);
    if (entries.length) {
      return entries.map(([key, item]) =>
        explode ? \`\${key}=\${item}\` : \`\${key},\${item}\`
      ).join(',');
    }
    return String(value);
  }
`)}
${when(helpers, 'serializeContentParameter', `
  public serializeContentParameter(
    value: unknown,
    context: ${clientName}ParameterSerializerContext,
  ): string {
    const normalized = context.contentType.toLowerCase();
    const serializer =
      this.parameterSerializers[normalized] ?? this.parameterSerializers['*/*'];
    if (serializer) return serializer(value, context);
    if (normalized.includes('json')) return JSON.stringify(value);
    if (normalized === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams();
      for (const [key, item] of this.entries(value)) this.formValue(form, key, item);
      return form.toString();
    }
    if (normalized.startsWith('text/')) return String(value);
    throw new Error(
      \`No parameter serializer configured for media type: \${context.contentType}\`,
    );
  }
`)}
${when(helpers, 'serializePath', `
  public serializePath(name: string, value: unknown, style: string, explode: boolean): string {
    if (style === 'simple') return this.serializeSimple(value, explode);
    if (style === 'label') {
      if (Array.isArray(value)) return \`.\${value.map((item) => this.encode(item)).join(explode ? '.' : ',')}\`;
      const entries = this.entries(value);
      if (entries.length) {
        return \`.\${entries.map(([key, item]) =>
          explode ? \`\${this.encode(key)}=\${this.encode(item)}\` : \`\${this.encode(key)},\${this.encode(item)}\`
        ).join(explode ? '.' : ',')}\`;
      }
      return \`.\${this.encode(value)}\`;
    }
    if (style === 'matrix') {
      if (Array.isArray(value)) {
        return explode
          ? value.map((item) => \`;\${this.encode(name)}=\${this.encode(item)}\`).join('')
          : \`;\${this.encode(name)}=\${value.map((item) => this.encode(item)).join(',')}\`;
      }
      const entries = this.entries(value);
      if (entries.length) {
        return explode
          ? entries.map(([key, item]) => \`;\${this.encode(key)}=\${this.encode(item)}\`).join('')
          : \`;\${this.encode(name)}=\${entries.flatMap(([key, item]) => [this.encode(key), this.encode(item)]).join(',')}\`;
      }
      return \`;\${this.encode(name)}=\${this.encode(value)}\`;
    }
    throw new Error(\`Unsupported path parameter style: \${style}\`);
  }
`)}
${when(helpers, 'appendQuery', `
  public appendQuery(query: string[], name: unknown, value: unknown, allowReserved: boolean): void {
    query.push(\`\${this.encode(name)}=\${this.encode(value, allowReserved)}\`);
  }
`)}
${when(helpers, 'addQueryParameter', `
  public addQueryParameter(
    query: string[],
    name: string,
    value: unknown,
    style: string,
    explode: boolean,
    allowReserved: boolean,
  ): void {
    if (value === undefined || value === null) return;
    if (style === 'deepObject') {
      const append = (prefix: string, item: unknown): void => {
        if (item === undefined || item === null) return;
        if (typeof item === 'object' && !Array.isArray(item)) {
          for (const [key, child] of this.entries(item)) append(\`\${prefix}[\${this.encode(key)}]\`, child);
          return;
        }
        query.push(\`\${prefix}=\${this.encode(item, allowReserved)}\`);
      };
      for (const [key, item] of this.entries(value)) append(\`\${this.encode(name)}[\${this.encode(key)}]\`, item);
      return;
    }
    const delimiter = style === 'spaceDelimited' ? '%20' : style === 'pipeDelimited' ? '|' : ',';
    if (Array.isArray(value)) {
      if (style === 'form' && explode) {
        for (const item of value) this.appendQuery(query, name, item, allowReserved);
      } else {
        query.push(\`\${this.encode(name)}=\${value.map((item) => this.encode(item, allowReserved)).join(delimiter)}\`);
      }
      return;
    }
    const entries = this.entries(value);
    if (entries.length) {
      if (style === 'form' && explode) {
        for (const [key, item] of entries) this.appendQuery(query, key, item, allowReserved);
      } else {
        const flattened = entries
          .flatMap(([key, item]) => [this.encode(key), this.encode(item, allowReserved)])
          .join(delimiter);
        query.push(\`\${this.encode(name)}=\${flattened}\`);
      }
      return;
    }
    this.appendQuery(query, name, value, allowReserved);
  }
`)}
${when(helpers, 'setQueryString', `
  public setQueryString(
    query: string[],
    value: unknown,
    context: ${clientName}ParameterSerializerContext,
  ): void {
    if (value === undefined || value === null) return;
    if (context.contentType === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams();
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, item] of Object.entries(value)) this.formValue(form, name, item);
      } else {
        form.set('', String(value));
      }
      const serialized = form.toString();
      if (serialized) query.push(serialized.replace(/^=/, ''));
      return;
    }
    const serialized = this.serializeContentParameter(value, context);
    query.push(this.encode(serialized));
  }
`)}
${when(helpers, 'addCookieParameter', `
  public addCookieParameter(cookies: string[], name: string, value: unknown, explode: boolean): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (explode) {
        for (const item of value) cookies.push(\`\${this.encode(name)}=\${this.encode(item)}\`);
      } else {
        cookies.push(\`\${this.encode(name)}=\${value.map((item) => this.encode(item)).join(',')}\`);
      }
      return;
    }
    const entries = this.entries(value);
    if (entries.length && explode) {
      for (const [key, item] of entries) cookies.push(\`\${this.encode(key)}=\${this.encode(item)}\`);
      return;
    }
    const serialized = entries.length
      ? entries.flatMap(([key, item]) => [this.encode(key), this.encode(item)]).join(',')
      : this.encode(value);
    cookies.push(\`\${this.encode(name)}=\${serialized}\`);
  }
`)}
${when(helpers, 'addCookieStyleParameter', `
  public addCookieStyleParameter(cookies: string[], name: string, value: unknown, explode: boolean): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (explode) {
        for (const item of value) cookies.push(\`\${name}=\${String(item)}\`);
      } else {
        cookies.push(\`\${name}=\${value.map((item) => String(item)).join(',')}\`);
      }
      return;
    }
    const entries = this.entries(value);
    if (entries.length && explode) {
      for (const [key, item] of entries) cookies.push(\`\${key}=\${String(item)}\`);
      return;
    }
    const serialized = entries.length
      ? entries.flatMap(([key, item]) => [String(key), String(item)]).join(',')
      : String(value);
    cookies.push(\`\${name}=\${serialized}\`);
  }
`)}
${when(helpers, 'matchesStatus', `
  private matchesStatus(status: number, expected: string): boolean {
    if (/^\\d{3}$/.test(expected)) return status === Number(expected);
    if (/^[1-5]XX$/i.test(expected)) return String(status)[0] === expected[0];
    return expected === 'default';
  }
`)}
${when(helpers, 'mediaRank', `
  private mediaRank(actual: string, expected: string): number | null {
    const rangeEnd = expected.indexOf(';');
    const valueEnd = actual.indexOf(';');
    const range = (rangeEnd < 0 ? expected : expected.slice(0, rangeEnd)).trim().toLowerCase();
    const value = (valueEnd < 0 ? actual : actual.slice(0, valueEnd)).trim().toLowerCase();
    if (value === range) return 0;
    const [rangeType, rangeSubtype] = range.split('/');
    const [actualType] = value.split('/');
    if (rangeSubtype === '*' && rangeType === actualType) return 1;
    if (range === '*/*') return 2;
    return null;
  }
`)}
${when(helpers, 'selectResponse', `
  private selectResponse(
    operation: OperationName,
    response: Response,
    contracts: readonly RuntimeResponseContract[],
  ): {
    status: string;
    contentType: string | null;
    actualContentType: string;
    framing: 'ndjson' | 'json-seq' | 'sse' | 'custom-stream' | 'binary' | 'body';
    requiredCodec?: string;
    schemaType?: string;
    headers: readonly {
      name: string;
      style: string;
      explode: boolean;
      contentType: string | null;
      kind: string | null;
      itemKind: string | null;
      propertyKinds: Readonly<Record<string, string | null>>;
    }[];
  } {
    const rawMediaType = response.headers.get('content-type') || '';
    const mediaEnd = rawMediaType.indexOf(';');
    const mediaType = (mediaEnd < 0 ? rawMediaType : rawMediaType.slice(0, mediaEnd)).trim().toLowerCase();
    let selected: (typeof contracts)[number] | undefined;
    let range: (typeof contracts)[number] | undefined;
    let fallback: (typeof contracts)[number] | undefined;
    for (const contract of contracts) {
      if (/^\\d{3}$/.test(contract.status) && this.matchesStatus(response.status, contract.status)) {
        selected = contract;
        break;
      }
      if (!range && /^[1-5]XX$/i.test(contract.status) && this.matchesStatus(response.status, contract.status)) range = contract;
      if (!fallback && contract.status === 'default') fallback = contract;
    }
    selected ??= range ?? fallback;
    if (!selected) throw undeclaredResponseError(operation, response, mediaType);
    // A response declared without content has no body to read, whatever the server sends.
    if (!selected.content.length) {
      return {
        status: selected.status,
        contentType: null,
        actualContentType: mediaType,
        framing: 'body',
        headers: selected.headers,
      };
    }
    let match: (typeof selected.content)[number] | undefined;
    let bestRank = Infinity;
    for (const item of selected.content) {
      const rank = this.mediaRank(mediaType, item.contentType);
      if (rank !== null && rank < bestRank) {
        match = item;
        bestRank = rank;
        if (rank === 0) break;
      }
    }
    if (!match) throw undeclaredResponseError(operation, response, mediaType);
    return {
      ...match,
      status: selected.status,
      actualContentType: mediaType,
      headers: selected.headers,
    };
  }
`)}
${when(helpers, 'decodeHeaderScalar', `
  private decodeHeaderScalar(value: string, kind: string | null): unknown {
    if (kind === 'integer' || kind === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError(\`Invalid numeric response header: \${value}\`);
      return number;
    }
    if (kind === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new TypeError(\`Invalid boolean response header: \${value}\`);
    }
    if (kind === 'null') {
      if (value === 'null') return null;
      throw new TypeError(\`Invalid null response header: \${value}\`);
    }
    return value;
  }
`)}
${when(helpers, 'decodeResponseHeader', `
  private decodeResponseHeader(
    ${plan.hasResponseHeaderContent ? 'operation' : '_operation'}: OperationName,
    value: string,
    metadata: {
      name: string;
      explode: boolean;
      contentType: string | null;
      kind: string | null;
      itemKind: string | null;
      propertyKinds: Readonly<Record<string, string | null>>;
    },
  ): unknown {
${plan.hasResponseHeaderContent ? `    if (metadata.contentType) {
      const normalized = metadata.contentType.toLowerCase();
      const decoder =
        this.responseHeaderDecoders[normalized] ?? this.responseHeaderDecoders['*/*'];
      if (decoder) return decoder(value, { operation, name: metadata.name, contentType: metadata.contentType });
      if (normalized.includes('json')) return JSON.parse(value);
      if (normalized === 'application/x-www-form-urlencoded') {
        return Object.fromEntries(new URLSearchParams(value));
      }
      if (normalized.startsWith('text/')) return value;
      throw new Error(
        \`No response header decoder configured for media type: \${metadata.contentType}\`,
      );
    }` : ''}
    const trimOws = (token: string): string => token.replace(/^[ \\t]+|[ \\t]+$/g, '');
    if (metadata.kind === 'array') {
      return value.split(',').map((item) => this.decodeHeaderScalar(trimOws(item), metadata.itemKind));
    }
    if (metadata.kind === 'object') {
      const parts = value.split(',');
      const entries: Array<[string, unknown]> = [];
      if (metadata.explode) {
        for (const part of parts) {
          const separator = part.indexOf('=');
          if (separator < 0) throw new TypeError(\`Invalid exploded object response header: \${value}\`);
          const name = trimOws(part.slice(0, separator));
          entries.push([
            name,
            this.decodeHeaderScalar(trimOws(part.slice(separator + 1)), Object.hasOwn(metadata.propertyKinds, name) ? metadata.propertyKinds[name] : null),
          ]);
        }
      } else {
        if (parts.length % 2 !== 0) throw new TypeError(\`Invalid object response header: \${value}\`);
        for (let index = 0; index < parts.length; index += 2) {
          const name = trimOws(parts[index]);
          entries.push([
            name,
            this.decodeHeaderScalar(trimOws(parts[index + 1]), Object.hasOwn(metadata.propertyKinds, name) ? metadata.propertyKinds[name] : null),
          ]);
        }
      }
      return Object.fromEntries(entries);
    }
    return this.decodeHeaderScalar(value, metadata.kind);
  }
`)}
${when(helpers, 'responseHeaders', `
  private responseHeaders(
    operation: OperationName,
    response: Response,
    headers: readonly {
      name: string;
      explode: boolean;
      contentType: string | null;
      kind: string | null;
      itemKind: string | null;
      propertyKinds: Readonly<Record<string, string | null>>;
    }[],
  ): Record<string, unknown> {
    const entries: Array<[string, unknown]> = [];
    for (const metadata of headers) {
      const value = response.headers.get(metadata.name);
      if (value !== null) {
        entries.push([metadata.name, this.decodeResponseHeader(operation, value, metadata)]);
      }
    }
    return Object.fromEntries(entries);
  }
`)}
${when(helpers, 'httpResponse', `
  private httpResponse(
    operation: OperationName,
    response: Response,
    declaredStatus: string,
    contentType: string | null,
    body: unknown,
    contracts: readonly RuntimeResponseContract[],
  ): {
    matched: 'status' | 'range' | 'default';
    status: number;
    contentType: string | null;
    body: unknown;
    headers: Record<string, unknown>;
  } {
    const contract = contracts.find((item) => item.status === declaredStatus);
    if (!contract) throw new Error(\`Missing generated response contract for \${operation} \${declaredStatus}\`);
    return {
      matched: declaredStatus === 'default' ? 'default' : /^[1-5]XX$/i.test(declaredStatus) ? 'range' : 'status',
      status: response.status,
      contentType,
      body,
      headers: ${helpers.has('responseHeaders')
        ? 'this.responseHeaders(operation, response, contract.headers)'
        : '{}'},
    };
  }
`)}
`;
}
