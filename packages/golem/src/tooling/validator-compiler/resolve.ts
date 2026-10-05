import { unescapePointerToken } from '../../json-pointer.js';

/** A schema node with the context its keywords and references are read in. */
export interface SchemaLocation {
  readonly node: unknown;
  /** The base URI in effect outside the node; the node's own `$id` applies on top. */
  readonly base: string;
  /** Name of the root or resource the node belongs to, for diagnostics. */
  readonly resource: string;
  /** RFC 6901 pointer from that root or resource to the node. */
  readonly pointer: string;
}

// Where a schema keyword holds subschemas, as far as `$id` and `$anchor` discovery is concerned.
const SCHEMA_KEYWORDS = ['additionalProperties', 'items', 'contains', 'if', 'then', 'else', 'not', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties'] as const;
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const SCHEMA_MAP_KEYWORDS = ['$defs', 'properties', 'patternProperties', 'dependentSchemas'] as const;

const HIERARCHICAL_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One RFC 6901 pointer segment. */
export function pointerSegment(token: string | number): string {
  return `/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function resolveUrl(reference: string, base: string): URL | undefined {
  try {
    return new URL(reference, base);
  } catch (error) {
    // A reference that is not a URI cannot name a schema; the caller reports it.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function withoutFragment(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

/** The base URI inside `node`: its own `$id` resolved against the base outside it. */
export function baseInside(node: unknown, outside: string): string {
  if (!isRecord(node) || typeof node.$id !== 'string') return outside;
  const url = resolveUrl(node.$id, outside);
  return url ? withoutFragment(url) : outside;
}

/** Resolves `$ref` targets across the roots and the resources of one compilation. */
export class SchemaResolver {
  private readonly documents = new Map<string, SchemaLocation>();
  private readonly anchors = new Map<string, SchemaLocation>();
  private readonly names = new Map<string, string>();
  private readonly rootLocations = new Map<string, SchemaLocation>();

  public constructor(roots: ReadonlyMap<string, unknown>, resources: ReadonlyMap<string, unknown>) {
    for (const [name, schema] of roots) this.rootLocations.set(name, this.addDocument('roots', name, schema));
    for (const [name, schema] of resources) this.addDocument('resources', name, schema);
  }

  public rootLocation(name: string): SchemaLocation {
    const location = this.rootLocations.get(name);
    if (!location) throw new Error(`Unknown root ${JSON.stringify(name)}`);
    return location;
  }

  /** The schema `reference` names when read inside a schema whose base URI is `base`; undefined when it names none. */
  public resolve(reference: string, base: string): SchemaLocation | undefined {
    // A codec id such as `TPayment_1234abcd#wire` names a root or resource whole. A leading `#` is a fragment
    // of the current document, never a name.
    const whole = reference.startsWith('#') ? undefined : this.names.get(reference);
    if (whole !== undefined) return this.documents.get(whole);
    const hash = reference.indexOf('#');
    const target = hash < 0 ? reference : reference.slice(0, hash);
    const alias = target === '' ? undefined : this.names.get(target);
    let uri: string;
    let fragment: string;
    if (alias !== undefined) {
      uri = alias;
      fragment = hash < 0 ? '' : reference.slice(hash + 1);
    } else {
      const url = resolveUrl(reference, base);
      if (!url) return undefined;
      uri = withoutFragment(url);
      fragment = url.hash.slice(1);
    }
    const document = this.documents.get(uri);
    if (!document) return undefined;
    if (fragment === '') return document;
    if (fragment.startsWith('/')) return this.followPointer(document, fragment);
    return this.anchors.get(`${uri}#${fragment}`);
  }

  private addDocument(kind: 'roots' | 'resources', name: string, schema: unknown): SchemaLocation {
    // A name that is itself an absolute URI is the document's address; any other name gets a synthetic one.
    const url = HIERARCHICAL_URI.test(name) ? resolveUrl(name, name) : undefined;
    const address = url ? withoutFragment(url) : `golem-schema://${kind}/${encodeURIComponent(name)}`;
    const location: SchemaLocation = { node: schema, base: address, resource: name, pointer: '' };
    this.documents.set(address, location);
    this.names.set(name, address);
    this.index(location);
    return location;
  }

  /** Registers the `$id` and `$anchor` of `location` and of every subschema below it. */
  private index(location: SchemaLocation): void {
    const { node, resource, pointer } = location;
    if (!isRecord(node)) return;
    const here = baseInside(node, location.base);
    if (here !== location.base && !this.documents.has(here)) this.documents.set(here, location);
    if (typeof node.$anchor === 'string') this.anchors.set(`${here}#${node.$anchor}`, location);
    const descend = (child: unknown, ...tokens: readonly (string | number)[]): void => {
      this.index({ node: child, base: here, resource, pointer: tokens.reduce<string>((path, token) => path + pointerSegment(token), pointer) });
    };
    for (const keyword of SCHEMA_KEYWORDS) if (keyword in node) descend(node[keyword], keyword);
    for (const keyword of SCHEMA_LIST_KEYWORDS) {
      const list = node[keyword];
      if (Array.isArray(list)) list.forEach((child: unknown, position) => descend(child, keyword, position));
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const map = node[keyword];
      if (isRecord(map)) for (const [key, child] of Object.entries(map)) descend(child, keyword, key);
    }
  }

  private followPointer(document: SchemaLocation, fragment: string): SchemaLocation | undefined {
    let node = document.node;
    let base = document.base;
    let pointer = document.pointer;
    for (const segment of fragment.slice(1).split('/')) {
      const token = unescapePointerToken(segment);
      base = baseInside(node, base);
      if (Array.isArray(node) && /^(?:0|[1-9][0-9]*)$/.test(token) && Number(token) < node.length) {
        node = node[Number(token)];
      } else if (isRecord(node) && Object.hasOwn(node, token)) {
        node = node[token];
      } else {
        return undefined;
      }
      pointer += pointerSegment(token);
    }
    return { node, base, resource: document.resource, pointer };
  }
}
