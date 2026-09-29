import { asRecord, isJsonObject, jsonPointerJoin, objectEntries, type JsonObject } from './json.js';
import { identifier } from '@exprtlabs/codegen/generator-api';
import { canonicalSchemaKey, escapePointerToken } from '@exprtlabs/codegen/schema';
import {
  decodePointerToken,
  resolveLocalPointer,
  type NormalizedDocument,
  type NormalizedOperation,
} from './normalize.js';

export type SchemaDirection = 'input' | 'output';

const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
] as const;

const SCHEMA_SINGLE_KEYWORDS = [
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
] as const;

const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/** Schema keywords whose values are literal data, never schemas or references. */
export const DATA_KEYWORDS: ReadonlySet<string> = new Set(['examples', 'example', 'default', 'enum', 'const']);
const DOCUMENT_BASE = 'urn:runic:openapi:document';

export interface CanonicalResource {
  readonly canonical: string;
  readonly hasId: boolean;
  readonly pointer: string | null;
  readonly schema: unknown;
}

export interface ResourceIndex {
  readonly byCanonical: ReadonlyMap<string, CanonicalResource>;
  readonly byPointer: ReadonlyMap<string, CanonicalResource>;
}

export interface ProjectionContext {
  readonly document: unknown;
  readonly direction: SchemaDirection;
  readonly extraExcluded?: ReadonlySet<string>;
  readonly resources?: ResourceIndex;
  readonly exclusionCache?: Map<string, boolean>;
  readonly evaluating?: Set<string>;
}

interface RewriteContext {
  readonly document: unknown;
  readonly direction: SchemaDirection;
  readonly packId: string;
  readonly resources: ResourceIndex;
  readonly currentBase: string;
  readonly emittingCanonical: string | null;
  /**
   * Operation schemas live on the root registry, so component pointers must be
   * qualified against the directional pack. In-pack copies keep `#/components`
   * pointers so nested $id resources are not rewritten onto directional URIs.
   */
  readonly qualifyComponentPointers: boolean;
}

function exclusionFlag(direction: SchemaDirection): 'readOnly' | 'writeOnly' {
  return direction === 'input' ? 'readOnly' : 'writeOnly';
}

function schemaIdentity(schema: unknown): string | null {
  if (typeof schema === 'boolean') return `bool:${schema}`;
  if (!isJsonObject(schema)) return null;
  if (typeof schema.$ref === 'string') return `ref:${schema.$ref}`;
  if (typeof schema.$dynamicRef === 'string') return `dynamic:${schema.$dynamicRef}`;
  return null;
}

function instanceHasExclusion(schema: unknown, direction: SchemaDirection): boolean {
  return isJsonObject(schema) && schema[exclusionFlag(direction)] === true;
}

function stripFragment(uri: string): string {
  const hash = uri.indexOf('#');
  return hash < 0 ? uri : uri.slice(0, hash);
}

function resolveHref(reference: string, base: string): string {
  try {
    return new URL(reference, base).href;
  } catch {
    return reference;
  }
}

function documentBase(document: unknown): string {
  const id = asRecord(document).$id;
  return typeof id === 'string' && id ? stripFragment(resolveHref(id, DOCUMENT_BASE)) : DOCUMENT_BASE;
}

function componentPointer(name: string): string {
  return `#/components/schemas/${name}`;
}

function pointerSchemaName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  const slash = rest.search(/[/]/);
  const token = slash < 0 ? rest : rest.slice(0, slash);
  try {
    return decodePointerToken(decodeURIComponent(token));
  } catch {
    return decodePointerToken(token);
  }
}

export function collectCanonicalResources(document: unknown): ResourceIndex {
  const byCanonical = new Map<string, CanonicalResource>();
  const byPointer = new Map<string, CanonicalResource>();
  const seen = new WeakSet<object>();
  const base = documentBase(document);

  const register = (schema: unknown, canonical: string, hasId: boolean, pointer: string | null): CanonicalResource => {
    const existing = byCanonical.get(canonical);
    if (existing) {
      if (hasId && existing.hasId && existing.schema !== schema) {
        throw new Error(`duplicate JSON Schema $id ${JSON.stringify(canonical)}`);
      }
      if (pointer && !byPointer.has(pointer)) byPointer.set(pointer, existing);
      return existing;
    }
    const record: CanonicalResource = { canonical, hasId, pointer, schema };
    byCanonical.set(canonical, record);
    if (pointer) byPointer.set(pointer, record);
    return record;
  };

  const walk = (schema: unknown, currentBase: string): void => {
    if (typeof schema === 'boolean' || !isJsonObject(schema)) return;
    if (seen.has(schema)) return;
    seen.add(schema);
    let nextBase = currentBase;
    if (typeof schema.$id === 'string') {
      const canonical = stripFragment(resolveHref(schema.$id, currentBase));
      register(schema, canonical, true, null);
      nextBase = canonical;
    }
    for (const [key, value] of objectEntries(schema)) {
      if (DATA_KEYWORDS.has(key) || key === '$ref' || key === '$dynamicRef' || key === '$id') continue;
      if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isJsonObject(value)) {
        for (const child of Object.values(value)) walk(child, nextBase);
        continue;
      }
      if ((SCHEMA_SINGLE_KEYWORDS as readonly string[]).includes(key) && typeof value !== 'boolean') {
        walk(value, nextBase);
        continue;
      }
      if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) {
        for (const child of value) walk(child, nextBase);
      }
    }
  };

  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  for (const [name, schema] of objectEntries(schemas)) {
    const pointer = componentPointer(name);
    if (isJsonObject(schema) && typeof schema.$id === 'string') {
      const canonical = stripFragment(resolveHref(schema.$id, base));
      register(schema, canonical, true, pointer);
      walk(schema, canonical);
    } else {
      register(schema, `${base}${pointer}`, false, pointer);
      walk(schema, base);
    }
  }
  return { byCanonical, byPointer };
}

export function lookupCanonicalResource(
  reference: string,
  currentBase: string,
  resources: ResourceIndex,
): CanonicalResource | undefined {
  if (reference.startsWith('#/components/schemas/')) {
    const name = pointerSchemaName(reference);
    return name ? resources.byPointer.get(componentPointer(name)) : undefined;
  }
  if (reference.startsWith('#/')) return resources.byPointer.get(reference);
  if (reference.startsWith('#') && reference.length > 1) return undefined;
  const resolved = stripFragment(resolveHref(reference, currentBase));
  return resources.byCanonical.get(resolved);
}

export function nextSchemaBase(
  schema: unknown,
  currentBase: string,
  resources?: ResourceIndex,
): string {
  if (!isJsonObject(schema) || typeof schema.$id !== 'string') return currentBase;
  const atBase = resources?.byCanonical.get(stripFragment(currentBase));
  if (atBase?.schema === schema) return currentBase;
  const resolved = stripFragment(resolveHref(schema.$id, currentBase));
  if (!resources) return resolved;
  if (resources.byCanonical.has(resolved)) return resolved;
  if (atBase?.hasId) return currentBase;
  return resolved;
}

export interface ExactComponentTarget {
  readonly schemaName: string;
  readonly typeName: string;
  readonly resource: CanonicalResource;
}

export interface ResolvedSchemaTarget {
  readonly schema: unknown;
  readonly currentBase: string;
  readonly resource: CanonicalResource | undefined;
  readonly fragment: string;
  readonly exactComponent: ExactComponentTarget | null;
}

function exactComponentFromResource(resource: CanonicalResource): ExactComponentTarget | null {
  if (!resource.pointer) return null;
  const schemaName = pointerSchemaName(resource.pointer);
  if (!schemaName || resource.pointer !== componentPointer(schemaName)) return null;
  return { schemaName, typeName: identifier(schemaName), resource };
}

function resourceScope(resource: CanonicalResource, fallback: string): string {
  return resource.hasId ? resource.canonical : fallback;
}

function wholeResourceTarget(resource: CanonicalResource, currentBase: string): ResolvedSchemaTarget {
  return {
    schema: resource.schema,
    currentBase: resourceScope(resource, currentBase),
    resource,
    fragment: '',
    exactComponent: exactComponentFromResource(resource),
  };
}

function applySchemaPointer(
  schema: unknown,
  pointer: string,
  currentBase: string,
  resources: ResourceIndex,
): { schema: unknown; currentBase: string } | undefined {
  const raw = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  if (raw === '' || raw === '/') return { schema, currentBase };
  if (!raw.startsWith('/')) return undefined;
  const tokens = raw.slice(1).split('/').map(decodePointerToken);
  let current: unknown = schema;
  let base = currentBase;
  for (const token of tokens) {
    if (current === undefined) return undefined;
    if (isJsonObject(current) || Array.isArray(current)) {
      base = nextSchemaBase(current, base, resources);
    }
    if (isJsonObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = current[token];
      continue;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    return undefined;
  }
  return { schema: current, currentBase: base };
}

function findAnchor(
  schema: unknown,
  name: string,
  currentBase: string,
  resources: ResourceIndex,
  seen: Set<unknown>,
): { schema: unknown; currentBase: string } | undefined {
  if (typeof schema === 'boolean' || !isJsonObject(schema) || seen.has(schema)) return undefined;
  seen.add(schema);
  const parentBase = currentBase;
  const base = nextSchemaBase(schema, parentBase, resources);
  if (schema.$anchor === name || schema.$dynamicAnchor === name) {
    return { schema, currentBase: parentBase };
  }
  for (const [key, value] of objectEntries(schema)) {
    if (DATA_KEYWORDS.has(key) || key === '$ref' || key === '$dynamicRef' || key === '$id') continue;
    if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isJsonObject(value)) {
      for (const child of Object.values(value)) {
        const found = findAnchor(child, name, base, resources, seen);
        if (found) return found;
      }
      continue;
    }
    if ((SCHEMA_SINGLE_KEYWORDS as readonly string[]).includes(key) && typeof value !== 'boolean') {
      const found = findAnchor(value, name, base, resources, seen);
      if (found) return found;
      continue;
    }
    if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) {
      for (const child of value) {
        const found = findAnchor(child, name, base, resources, seen);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function resolveAnchorTarget(
  name: string,
  currentBase: string,
  resources: ResourceIndex,
  document: unknown | undefined,
): ResolvedSchemaTarget | undefined {
  const current = resources.byCanonical.get(stripFragment(currentBase));
  if (current) {
    const found = findAnchor(current.schema, name, resourceScope(current, currentBase), resources, new Set());
    if (found) {
      return {
        schema: found.schema,
        currentBase: found.currentBase,
        resource: current,
        fragment: `#${name}`,
        exactComponent: found.schema === current.schema ? exactComponentFromResource(current) : null,
      };
    }
  }
  if (document === undefined) return undefined;
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  for (const [schemaName, schema] of objectEntries(schemas)) {
    const resource = resources.byPointer.get(componentPointer(schemaName));
    const scope = resource ? resourceScope(resource, currentBase) : currentBase;
    const found = findAnchor(schema, name, scope, resources, new Set());
    if (!found) continue;
    return {
      schema: found.schema,
      currentBase: found.currentBase,
      resource,
      fragment: `#${name}`,
      exactComponent: resource && found.schema === resource.schema ? exactComponentFromResource(resource) : null,
    };
  }
  return undefined;
}

function pointerSubresource(
  resource: CanonicalResource,
  fragment: string,
  currentBase: string,
  resources: ResourceIndex,
): ResolvedSchemaTarget | undefined {
  const walked = applySchemaPointer(resource.schema, fragment, resourceScope(resource, currentBase), resources);
  if (!walked) return undefined;
  return {
    schema: walked.schema,
    currentBase: walked.currentBase,
    resource,
    fragment,
    exactComponent: null,
  };
}

export function schemaTargetIdentity(target: ResolvedSchemaTarget): string {
  return `${target.resource?.canonical ?? ''}${target.fragment}`;
}

export function resolveSchemaTarget(
  reference: string,
  currentBase: string,
  resources: ResourceIndex,
  document?: unknown,
): ResolvedSchemaTarget | undefined {
  if (reference.startsWith('#') && !reference.startsWith('#/')) {
    return reference.length > 1 ? resolveAnchorTarget(reference.slice(1), currentBase, resources, document) : undefined;
  }
  if (reference.startsWith('#/')) {
    const resource = lookupCanonicalResource(reference, currentBase, resources);
    const rest = remainingPointerFragment(reference);
    if (resource) {
      return rest ? pointerSubresource(resource, rest, currentBase, resources) : wholeResourceTarget(resource, currentBase);
    }
    if (document === undefined) return undefined;
    const schema = resolveLocalPointer(document, reference);
    if (schema === undefined) return undefined;
    return { schema, currentBase, resource: undefined, fragment: reference, exactComponent: null };
  }
  const hash = reference.indexOf('#');
  const locator = hash < 0 ? reference : reference.slice(0, hash);
  const fragment = hash < 0 || reference.slice(hash) === '#' ? '' : reference.slice(hash);
  const resource = lookupCanonicalResource(locator || reference, currentBase, resources);
  if (!resource) return undefined;
  if (!fragment) return wholeResourceTarget(resource, currentBase);
  if (fragment.startsWith('#/')) return pointerSubresource(resource, fragment, currentBase, resources);
  return resolveAnchorTarget(fragment.slice(1), resourceScope(resource, currentBase), resources, document)
    ?? resolveAnchorInResource(resource, fragment.slice(1), currentBase, resources);
}

function resolveAnchorInResource(
  resource: CanonicalResource,
  name: string,
  currentBase: string,
  resources: ResourceIndex,
): ResolvedSchemaTarget | undefined {
  const found = findAnchor(resource.schema, name, resourceScope(resource, currentBase), resources, new Set());
  if (!found) return undefined;
  return {
    schema: found.schema,
    currentBase: found.currentBase,
    resource,
    fragment: `#${name}`,
    exactComponent: found.schema === resource.schema ? exactComponentFromResource(resource) : null,
  };
}

export function resolveExactComponent(
  reference: string,
  currentBase: string,
  resources: ResourceIndex,
  document?: unknown,
): ExactComponentTarget | null {
  return resolveSchemaTarget(reference, currentBase, resources, document)?.exactComponent ?? null;
}

function remainingPointerFragment(reference: string): string {
  if (!reference.startsWith('#/components/schemas/')) return '';
  const name = pointerSchemaName(reference);
  if (!name) return '';
  const prefix = componentPointer(name);
  const rest = reference.slice(prefix.length);
  return rest ? `#${rest}` : '';
}

const OPENAPI_OPERATIONS = [
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query',
] as const;

const OPENAPI_LITERAL_KEYS = new Set(['example', 'examples']);

export type OpenApiComponentKind =
  | 'schemas'
  | 'parameters'
  | 'headers'
  | 'requestBodies'
  | 'responses'
  | 'pathItems'
  | 'examples'
  | 'links'
  | 'callbacks'
  | 'securitySchemes'
  | 'mediaTypes';

export const OPENAPI_COMPONENT_KINDS: readonly OpenApiComponentKind[] = [
  'schemas', 'parameters', 'headers', 'requestBodies', 'responses', 'pathItems',
  'examples', 'links', 'callbacks', 'securitySchemes', 'mediaTypes',
];

export interface OpenApiSchemaTreeHandlers {
  onSchema?(schema: unknown, currentBase: string, pointer: string): void;
  onSchemaRef?(
    keyword: '$ref' | '$dynamicRef',
    reference: string,
    currentBase: string,
    pointer: string,
    owner: Record<string, unknown>,
  ): void;
  onOpenApiRef?(reference: string, pointer: string, kind: OpenApiComponentKind): void;
  /**
   * One string value of a Schema Object's `discriminator.mapping` or
   * `discriminator.defaultMapping`. `ownerPointer` is the object holding the
   * value (`…/discriminator/mapping` or `…/discriminator`) and `property` is
   * its key there (the mapping key, or `defaultMapping`). The value is a
   * schema component name or a URI reference resolved against `currentBase`.
   */
  onDiscriminatorMapping?(
    keyword: 'mapping' | 'defaultMapping',
    reference: string,
    currentBase: string,
    ownerPointer: string,
    property: string,
  ): void;
}

function reportDiscriminatorMappings(
  discriminator: unknown,
  currentBase: string,
  pointer: string,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!handlers.onDiscriminatorMapping || !isJsonObject(discriminator)) return;
  const mappingPointer = jsonPointerJoin(pointer, 'mapping');
  for (const [key, value] of objectEntries(discriminator.mapping)) {
    if (typeof value === 'string') handlers.onDiscriminatorMapping('mapping', value, currentBase, mappingPointer, key);
  }
  if (typeof discriminator.defaultMapping === 'string') {
    handlers.onDiscriminatorMapping('defaultMapping', discriminator.defaultMapping, currentBase, pointer, 'defaultMapping');
  }
}

function visitSchemaNode(
  schema: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  handlers.onSchema?.(schema, currentBase, pointer);
  if (typeof schema === 'boolean' || !isJsonObject(schema)) return;
  if (seen.has(schema)) return;
  seen.add(schema);
  const owner = schema as { [key: string]: unknown };
  const nextBase = typeof owner.$id === 'string'
    ? stripFragment(resolveHref(owner.$id, currentBase))
    : currentBase;
  if (typeof owner.$ref === 'string') {
    handlers.onSchemaRef?.('$ref', owner.$ref, nextBase, `${pointer}/$ref`, owner);
  }
  if (typeof owner.$dynamicRef === 'string') {
    handlers.onSchemaRef?.('$dynamicRef', owner.$dynamicRef, nextBase, `${pointer}/$dynamicRef`, owner);
  }
  reportDiscriminatorMappings(owner.discriminator, nextBase, jsonPointerJoin(pointer, 'discriminator'), handlers);
  for (const [key, value] of objectEntries(schema)) {
    if (DATA_KEYWORDS.has(key) || key === '$ref' || key === '$dynamicRef' || key === '$id') continue;
    if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isJsonObject(value)) {
      for (const [name, child] of objectEntries(value)) {
        visitSchemaNode(child, nextBase, jsonPointerJoin(jsonPointerJoin(pointer, key), name), seen, handlers);
      }
      continue;
    }
    if ((SCHEMA_SINGLE_KEYWORDS as readonly string[]).includes(key) && typeof value !== 'boolean') {
      visitSchemaNode(value, nextBase, jsonPointerJoin(pointer, key), seen, handlers);
      continue;
    }
    if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) {
      value.forEach((child, index) => {
        visitSchemaNode(child, nextBase, jsonPointerJoin(jsonPointerJoin(pointer, key), String(index)), seen, handlers);
      });
    }
  }
}

/** Report a Reference Object; true when `node` is one and was reported. */
function reportObjectRef(
  node: unknown,
  kind: OpenApiComponentKind,
  pointer: string,
  handlers: OpenApiSchemaTreeHandlers,
): boolean {
  if (!isJsonObject(node) || typeof node.$ref !== 'string') return false;
  handlers.onOpenApiRef?.(node.$ref, `${pointer}/$ref`, kind);
  return true;
}

function visitReferenceMap(
  map: unknown,
  kind: OpenApiComponentKind,
  pointer: string,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(map)) return;
  for (const [name, entry] of objectEntries(map)) reportObjectRef(entry, kind, jsonPointerJoin(pointer, name), handlers);
}

function visitHeaderMap(
  headers: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(headers)) return;
  for (const [name, header] of objectEntries(headers)) {
    visitParameterLike(header, 'headers', currentBase, jsonPointerJoin(pointer, name), seen, handlers);
  }
}

/** `encoding`, `prefixEncoding` and `itemEncoding` on a Media Type or Encoding Object. */
function visitEncodingFields(
  owner: JsonObject,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (isJsonObject(owner.encoding)) {
    for (const [name, encoding] of objectEntries(owner.encoding)) {
      visitEncoding(encoding, currentBase, jsonPointerJoin(jsonPointerJoin(pointer, 'encoding'), name), seen, handlers);
    }
  }
  if (Array.isArray(owner.prefixEncoding)) {
    owner.prefixEncoding.forEach((encoding, index) => {
      visitEncoding(encoding, currentBase, jsonPointerJoin(jsonPointerJoin(pointer, 'prefixEncoding'), String(index)), seen, handlers);
    });
  }
  if (owner.itemEncoding !== undefined) {
    visitEncoding(owner.itemEncoding, currentBase, jsonPointerJoin(pointer, 'itemEncoding'), seen, handlers);
  }
}

function visitEncoding(
  encoding: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(encoding)) return;
  visitHeaderMap(encoding.headers, currentBase, jsonPointerJoin(pointer, 'headers'), seen, handlers);
  visitEncodingFields(encoding, currentBase, pointer, seen, handlers);
}

function visitMediaType(
  mediaType: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(mediaType)) return;
  if (reportObjectRef(mediaType, 'mediaTypes', pointer, handlers)) return;
  if (mediaType.schema !== undefined) {
    visitSchemaNode(mediaType.schema, currentBase, jsonPointerJoin(pointer, 'schema'), seen, handlers);
  }
  if (mediaType.itemSchema !== undefined) {
    visitSchemaNode(mediaType.itemSchema, currentBase, jsonPointerJoin(pointer, 'itemSchema'), seen, handlers);
  }
  visitReferenceMap(mediaType.examples, 'examples', jsonPointerJoin(pointer, 'examples'), handlers);
  visitEncodingFields(mediaType, currentBase, pointer, seen, handlers);
}

function visitMediaContent(
  content: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(content)) return;
  for (const [media, mediaType] of objectEntries(content)) {
    visitMediaType(mediaType, currentBase, jsonPointerJoin(pointer, media), seen, handlers);
  }
}

function visitParameterLike(
  parameter: unknown,
  kind: 'parameters' | 'headers',
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(parameter)) return;
  if (reportObjectRef(parameter, kind, pointer, handlers)) return;
  if (parameter.schema !== undefined) {
    visitSchemaNode(parameter.schema, currentBase, jsonPointerJoin(pointer, 'schema'), seen, handlers);
  }
  visitMediaContent(parameter.content, currentBase, jsonPointerJoin(pointer, 'content'), seen, handlers);
  visitReferenceMap(parameter.examples, 'examples', jsonPointerJoin(pointer, 'examples'), handlers);
}

function visitRequestBody(
  body: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(body)) return;
  if (reportObjectRef(body, 'requestBodies', pointer, handlers)) return;
  visitMediaContent(body.content, currentBase, jsonPointerJoin(pointer, 'content'), seen, handlers);
}

function visitResponse(
  response: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(response)) return;
  if (reportObjectRef(response, 'responses', pointer, handlers)) return;
  visitMediaContent(response.content, currentBase, jsonPointerJoin(pointer, 'content'), seen, handlers);
  visitHeaderMap(response.headers, currentBase, jsonPointerJoin(pointer, 'headers'), seen, handlers);
  visitReferenceMap(response.links, 'links', jsonPointerJoin(pointer, 'links'), handlers);
}

function visitCallback(
  callback: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (reportObjectRef(callback, 'callbacks', pointer, handlers)) return;
  visitPathMap(callback, currentBase, pointer, seen, handlers);
}

function visitOperation(
  operation: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(operation)) return;
  if (Array.isArray(operation.parameters)) {
    operation.parameters.forEach((parameter, index) => {
      visitParameterLike(
        parameter,
        'parameters',
        currentBase,
        jsonPointerJoin(jsonPointerJoin(pointer, 'parameters'), String(index)),
        seen,
        handlers,
      );
    });
  }
  if (operation.requestBody !== undefined) {
    visitRequestBody(operation.requestBody, currentBase, jsonPointerJoin(pointer, 'requestBody'), seen, handlers);
  }
  if (isJsonObject(operation.responses)) {
    for (const [status, response] of objectEntries(operation.responses)) {
      visitResponse(response, currentBase, jsonPointerJoin(jsonPointerJoin(pointer, 'responses'), status), seen, handlers);
    }
  }
  if (isJsonObject(operation.callbacks)) {
    for (const [name, callback] of objectEntries(operation.callbacks)) {
      visitCallback(callback, currentBase, jsonPointerJoin(jsonPointerJoin(pointer, 'callbacks'), name), seen, handlers);
    }
  }
}

function visitPathItem(
  item: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(item)) return;
  if (reportObjectRef(item, 'pathItems', pointer, handlers)) return;
  if (Array.isArray(item.parameters)) {
    item.parameters.forEach((parameter, index) => {
      visitParameterLike(
        parameter,
        'parameters',
        currentBase,
        jsonPointerJoin(jsonPointerJoin(pointer, 'parameters'), String(index)),
        seen,
        handlers,
      );
    });
  }
  for (const method of OPENAPI_OPERATIONS) {
    if (item[method] !== undefined) {
      visitOperation(item[method], currentBase, jsonPointerJoin(pointer, method), seen, handlers);
    }
  }
  if (isJsonObject(item.additionalOperations)) {
    for (const [method, operation] of objectEntries(item.additionalOperations)) {
      visitOperation(operation, currentBase, jsonPointerJoin(jsonPointerJoin(pointer, 'additionalOperations'), method), seen, handlers);
    }
  }
}

function visitPathMap(
  map: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  if (!isJsonObject(map)) return;
  for (const [name, item] of objectEntries(map)) {
    if (OPENAPI_LITERAL_KEYS.has(name)) continue;
    visitPathItem(item, currentBase, jsonPointerJoin(pointer, name), seen, handlers);
  }
}

function visitComponentNode(
  kind: OpenApiComponentKind,
  node: unknown,
  currentBase: string,
  pointer: string,
  seen: WeakSet<object>,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  switch (kind) {
    case 'schemas':
      visitSchemaNode(node, currentBase, pointer, seen, handlers);
      return;
    case 'parameters':
    case 'headers':
      visitParameterLike(node, kind, currentBase, pointer, seen, handlers);
      return;
    case 'requestBodies':
      visitRequestBody(node, currentBase, pointer, seen, handlers);
      return;
    case 'responses':
      visitResponse(node, currentBase, pointer, seen, handlers);
      return;
    case 'pathItems':
      visitPathItem(node, currentBase, pointer, seen, handlers);
      return;
    case 'callbacks':
      visitCallback(node, currentBase, pointer, seen, handlers);
      return;
    case 'mediaTypes':
      visitMediaType(node, currentBase, pointer, seen, handlers);
      return;
    case 'examples':
    case 'links':
    case 'securitySchemes':
      reportObjectRef(node, kind, pointer, handlers);
      return;
  }
}

/** Walk one node of a known component kind, such as a target in another document. */
export function visitOpenApiComponent(
  kind: OpenApiComponentKind,
  node: unknown,
  currentBase: string,
  pointer: string,
  handlers: OpenApiSchemaTreeHandlers,
): void {
  visitComponentNode(kind, node, currentBase, pointer, new WeakSet<object>(), handlers);
}

export function visitOpenApiSchemaTree(document: unknown, handlers: OpenApiSchemaTreeHandlers): void {
  const base = documentBase(document);
  const seen = new WeakSet<object>();
  const components = asRecord(asRecord(document).components);
  for (const kind of OPENAPI_COMPONENT_KINDS) {
    const entries = components[kind];
    if (!isJsonObject(entries)) continue;
    for (const [name, node] of objectEntries(entries)) {
      visitComponentNode(kind, node, base, jsonPointerJoin(`#/components/${kind}`, name), seen, handlers);
    }
  }
  visitPathMap(asRecord(document).paths, base, '#/paths', seen, handlers);
  visitPathMap(asRecord(document).webhooks, base, '#/webhooks', seen, handlers);
}

export function schemaDocumentBase(document: unknown): string {
  return documentBase(document);
}

function directionalUri(resource: CanonicalResource, direction: SchemaDirection, packId: string): string {
  if (resource.hasId) return `${resource.canonical}:${direction}`;
  if (resource.pointer) return `${packId}${resource.pointer}`;
  return `${packId}`;
}

function resolveUnconditionalTarget(
  schema: unknown,
  document: unknown,
  resources: ResourceIndex | undefined,
  currentBase: string,
): unknown {
  if (!isJsonObject(schema)) return schema;
  const reference = typeof schema.$ref === 'string'
    ? schema.$ref
    : typeof schema.$dynamicRef === 'string'
      ? schema.$dynamicRef
      : undefined;
  if (typeof reference !== 'string') return schema;
  if (reference.startsWith('#/')) return resolveLocalPointer(document, reference);
  if (reference.startsWith('#') && reference.length > 1) {
    const anchor = reference.slice(1);
    const schemas = asRecord(asRecord(asRecord(document).components).schemas);
    for (const [, candidate] of objectEntries(schemas)) {
      if (!isJsonObject(candidate)) continue;
      if (candidate.$anchor === anchor || candidate.$dynamicAnchor === anchor) return candidate;
    }
  }
  if (!resources) return undefined;
  return lookupCanonicalResource(reference, currentBase, resources)?.schema;
}

function propertyHasExclusion(schema: unknown, context: ProjectionContext): boolean {
  const cache = context.exclusionCache ?? new Map<string, boolean>();
  const evaluating = context.evaluating ?? new Set<string>();
  const resources = context.resources ?? collectCanonicalResources(context.document);
  const base = documentBase(context.document);
  const walk = (current: unknown): boolean => {
    if (instanceHasExclusion(current, context.direction)) return true;
    if (typeof current === 'boolean' || !isJsonObject(current)) return false;
    const identity = schemaIdentity(current);
    if (identity) {
      const cached = cache.get(identity);
      if (cached !== undefined) return cached;
      if (evaluating.has(identity)) return false;
      evaluating.add(identity);
    }
    let result = false;
    try {
      if (typeof current.$ref === 'string' || typeof current.$dynamicRef === 'string') {
        const target = resolveUnconditionalTarget(current, context.document, resources, base);
        if (target !== undefined && target !== current) result = walk(target);
      }
      if (!result && Array.isArray(current.allOf)) result = current.allOf.some((item) => walk(item));
    } finally {
      if (identity) evaluating.delete(identity);
    }
    if (identity) cache.set(identity, result);
    return result;
  };
  return walk(schema);
}

export function collectExcludedPropertyNames(
  schema: unknown,
  context: ProjectionContext,
): Set<string> {
  const excluded = new Set<string>(context.extraExcluded ?? []);
  const evaluating = new Set<string>();
  const resources = context.resources ?? collectCanonicalResources(context.document);
  const cache = context.exclusionCache ?? new Map<string, boolean>();
  const nested: ProjectionContext = {
    ...context,
    resources,
    exclusionCache: cache,
  };
  const visit = (current: unknown): void => {
    if (typeof current === 'boolean' || !isJsonObject(current)) return;
    const identity = schemaIdentity(current);
    if (identity) {
      if (evaluating.has(identity)) return;
      evaluating.add(identity);
    }
    try {
      if (typeof current.$ref === 'string' || typeof current.$dynamicRef === 'string') {
        const target = resolveUnconditionalTarget(current, context.document, resources, documentBase(context.document));
        if (target !== undefined) visit(current === target ? current : target);
      }
      for (const item of Array.isArray(current.allOf) ? current.allOf : []) visit(item);
      for (const [name, property] of objectEntries(current.properties)) {
        if (propertyHasExclusion(property, nested)) excluded.add(name);
      }
    } finally {
      if (identity) evaluating.delete(identity);
    }
  };
  visit(schema);
  return excluded;
}

function projectRequired(
  required: unknown,
  excluded: ReadonlySet<string>,
): string[] | undefined {
  if (!Array.isArray(required)) return undefined;
  return required.map(String).filter((name) => !excluded.has(name));
}

function mapSchemaKeyword(
  value: unknown,
  context: ProjectionContext,
  project: (value: unknown, context: ProjectionContext) => unknown,
): unknown {
  if (typeof value === 'boolean') return value;
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    objectEntries(value).map(([name, child]) => [name, project(child, context)]),
  );
}

function withProjectionState(context: ProjectionContext): ProjectionContext {
  return {
    ...context,
    resources: context.resources ?? collectCanonicalResources(context.document),
    exclusionCache: context.exclusionCache ?? new Map<string, boolean>(),
    evaluating: context.evaluating ?? new Set<string>(),
  };
}

/**
 * Directional schema-keyword projection for TypeScript and runtime validators.
 * $ref/$dynamicRef are preserved; callers rewrite resource IDs separately.
 */
export function projectSchema(schema: unknown, context: ProjectionContext): unknown {
  if (typeof schema === 'boolean') return schema;
  if (!isJsonObject(schema)) return schema;
  const ctx = withProjectionState(context);
  const excluded = collectExcludedPropertyNames(schema, ctx);
  const next: Record<string, unknown> = {};
  for (const [key, value] of objectEntries(schema)) {
    if (DATA_KEYWORDS.has(key)) {
      next[key] = value;
      continue;
    }
    if (key === 'properties' && isJsonObject(value)) {
      const properties = Object.fromEntries(
        objectEntries(value)
          .filter(([name, property]) => !excluded.has(name) && !propertyHasExclusion(property, ctx))
          .map(([name, property]) => [name, projectSchema(property, ctx)]),
      );
      if (Object.keys(properties).length) next.properties = properties;
      continue;
    }
    if (key === 'required') {
      const kept = projectRequired(value, excluded);
      if (kept && kept.length) next.required = kept;
      continue;
    }
    if (key === 'allOf' && Array.isArray(value)) {
      const siblingExcluded = new Set(excluded);
      for (const item of value) {
        for (const name of collectExcludedPropertyNames(item, { ...ctx, extraExcluded: undefined })) {
          siblingExcluded.add(name);
        }
      }
      next.allOf = value.map((item) => projectSchema(item, { ...ctx, extraExcluded: siblingExcluded }));
      continue;
    }
    if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isJsonObject(value)) {
      next[key] = mapSchemaKeyword(value, ctx, projectSchema);
      continue;
    }
    if ((SCHEMA_SINGLE_KEYWORDS as readonly string[]).includes(key)) {
      next[key] = typeof value === 'boolean' ? value : projectSchema(value, ctx);
      continue;
    }
    if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) {
      next[key] = value.map((item) => projectSchema(item, ctx));
      continue;
    }
    next[key] = value;
  }
  return next;
}

function uriFragment(reference: string): string {
  if (reference.startsWith('#/components/schemas/')) return remainingPointerFragment(reference);
  if (!reference.startsWith('#/') && reference.includes('#')) return reference.slice(reference.indexOf('#'));
  return '';
}

function rewriteReference(
  reference: string,
  context: RewriteContext,
  keyword: '$ref' | '$dynamicRef',
): string {
  const fragmentOnly = reference.startsWith('#') && !reference.startsWith('#/');
  // Ajv's 2020 engine only accepts hash-fragment $dynamicRef values.
  if (keyword === '$dynamicRef' && fragmentOnly) return reference;
  const componentPointer = reference.startsWith('#/components/schemas/');
  const nestedIdScope = context.emittingCanonical !== null;
  // Pack-local copies without their own $id can keep document-relative
  // component pointers. Nested $id resources cannot: `#/components` would
  // resolve against the nested resource, not the directional pack.
  if (componentPointer && !context.qualifyComponentPointers && !nestedIdScope) {
    return reference;
  }
  if (fragmentOnly) {
    const resource = context.resources.byCanonical.get(stripFragment(context.currentBase));
    if (resource?.hasId) return `${directionalUri(resource, context.direction, context.packId)}${reference}`;
    return reference;
  }
  const resource = lookupCanonicalResource(reference, context.currentBase, context.resources);
  if (resource?.hasId && !componentPointer) {
    return `${directionalUri(resource, context.direction, context.packId)}${uriFragment(reference)}`;
  }
  if (componentPointer && resource?.hasId && nestedIdScope) {
    return `${directionalUri(resource, context.direction, context.packId)}${remainingPointerFragment(reference)}`;
  }
  if (componentPointer) return `${context.packId}${reference}`;
  if (reference.startsWith('#/')) return `${context.packId}${reference}`;
  return reference;
}

function rewriteProjectedSchema(schema: unknown, context: RewriteContext): unknown {
  if (typeof schema === 'boolean') return schema;
  if (!isJsonObject(schema)) return schema;
  const originalBase = nextSchemaBase(schema, context.currentBase, context.resources);
  const resource = typeof schema.$id === 'string'
    ? context.resources.byCanonical.get(originalBase)
      ?? lookupCanonicalResource(schema.$id, context.currentBase, context.resources)
    : undefined;
  if (
    resource?.hasId
    && context.emittingCanonical !== resource.canonical
  ) {
    return { $ref: directionalUri(resource, context.direction, context.packId) };
  }
  const next: Record<string, unknown> = {};
  const childContext: RewriteContext = {
    ...context,
    currentBase: originalBase,
    emittingCanonical: resource?.hasId
      ? resource.canonical
      : context.emittingCanonical,
  };
  for (const [key, value] of objectEntries(schema)) {
    // Mapping values reference schemas like `$ref`; keep them in the same projected form.
    if (key === 'discriminator' && isJsonObject(value) && isJsonObject(value.mapping)) {
      next.discriminator = {
        ...value,
        mapping: Object.fromEntries(objectEntries(value.mapping).map(([tag, target]) => [
          tag,
          typeof target !== 'string' ? target
            : rewriteReference(/^[^/:#]+$/.test(target) ? componentPointer(escapePointerToken(target)) : target, childContext, '$ref'),
        ])),
      };
      continue;
    }
    if (DATA_KEYWORDS.has(key)) {
      next[key] = value;
      continue;
    }
    if (key === '$ref' && typeof value === 'string') {
      next.$ref = rewriteReference(value, childContext, '$ref');
      continue;
    }
    if (key === '$dynamicRef' && typeof value === 'string') {
      next.$dynamicRef = rewriteReference(value, childContext, '$dynamicRef');
      continue;
    }
    if (key === '$id' && typeof value === 'string') {
      const target = context.resources.byCanonical.get(originalBase)
        ?? lookupCanonicalResource(value, context.currentBase, context.resources);
      next.$id = target?.hasId
        ? directionalUri(target, context.direction, context.packId)
        : `${originalBase}:${context.direction}`;
      continue;
    }
    if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isJsonObject(value)) {
      next[key] = Object.fromEntries(
        objectEntries(value).map(([name, child]) => [
          name,
          rewriteProjectedSchema(child, childContext),
        ]),
      );
      continue;
    }
    if ((SCHEMA_SINGLE_KEYWORDS as readonly string[]).includes(key)) {
      next[key] = typeof value === 'boolean' ? value : rewriteProjectedSchema(value, childContext);
      continue;
    }
    if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) {
      next[key] = value.map((item) => rewriteProjectedSchema(item, childContext));
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function projectionResourceId(rootId: string, direction: SchemaDirection): string {
  return `${rootId}:${direction}`;
}

export interface RuntimeProjectionBundle {
  readonly inputResourceId: string;
  readonly outputResourceId: string;
  readonly inputResource: Record<string, unknown>;
  readonly outputResource: Record<string, unknown>;
}

function idBearingResources(resources: ResourceIndex): CanonicalResource[] {
  const seen = new Set<string>();
  const ordered: CanonicalResource[] = [];
  for (const resource of resources.byCanonical.values()) {
    if (!resource.hasId || seen.has(resource.canonical)) continue;
    seen.add(resource.canonical);
    ordered.push(resource);
  }
  return ordered.sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function projectDirectionalResource(
  document: unknown,
  ir: NormalizedDocument,
  direction: SchemaDirection,
  packId: string,
  resources: ResourceIndex,
): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const resource of idBearingResources(resources)) {
    const projected = projectSchema(resource.schema, { document, direction, resources });
    defs[resource.canonical] = rewriteProjectedSchema(projected, {
      document,
      direction,
      packId,
      resources,
      currentBase: resource.canonical,
      emittingCanonical: resource.canonical,
      qualifyComponentPointers: false,
    });
  }
  const schemas = Object.fromEntries(
    objectEntries(ir.schemas).map(([name, schema]) => {
      const pointer = componentPointer(name);
      const resource = resources.byPointer.get(pointer);
      if (resource?.hasId) {
        return [name, { $ref: directionalUri(resource, direction, packId) }];
      }
      const projected = projectSchema(schema, { document, direction, resources });
      return [name, rewriteProjectedSchema(projected, {
        document,
        direction,
        packId,
        resources,
        currentBase: documentBase(document),
        emittingCanonical: null,
        qualifyComponentPointers: false,
      })];
    }),
  );
  return {
    $id: packId,
    ...(Object.keys(defs).length ? { $defs: defs } : {}),
    components: { schemas },
  };
}

export function buildRuntimeProjections(
  document: unknown,
  ir: NormalizedDocument,
  rootId: string,
  resources: ResourceIndex = collectCanonicalResources(document),
): RuntimeProjectionBundle {
  const inputResourceId = projectionResourceId(rootId, 'input');
  const outputResourceId = projectionResourceId(rootId, 'output');
  const inputResource = projectDirectionalResource(document, ir, 'input', inputResourceId, resources);
  // Compare in the same reference scope. Resources with their own $id keep
  // directional identities; merging those requires rebasing their entire graph.
  if (idBearingResources(resources).length === 0) {
    const outputInInputScope = projectDirectionalResource(document, ir, 'output', inputResourceId, resources);
    if (canonicalSchemaKey(inputResource) === canonicalSchemaKey(outputInInputScope)) {
      return { inputResourceId, outputResourceId: inputResourceId, inputResource, outputResource: inputResource };
    }
  }
  return {
    inputResourceId,
    outputResourceId,
    inputResource,
    outputResource: projectDirectionalResource(document, ir, 'output', outputResourceId, resources),
  };
}

export function projectOperationSchema(
  schema: unknown,
  document: unknown,
  direction: SchemaDirection,
  resourceId: string,
  resources: ResourceIndex = collectCanonicalResources(document),
): unknown {
  return rewriteProjectedSchema(
    projectSchema(schema, { document, direction, resources }),
    {
      document,
      direction,
      packId: resourceId,
      resources,
      currentBase: documentBase(document),
      emittingCanonical: null,
      qualifyComponentPointers: true,
    },
  );
}

export type { NormalizedOperation };
