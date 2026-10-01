import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { InputObserver } from '@exprtlabs/golem/generator-api';
import YAML from 'yaml';
import { asRecord, escapeJsonPointerToken, isJsonObject, jsonPointerJoin, objectEntries, resolveJsonPointer } from './json.js';
import {
  collectCanonicalResources,
  DATA_KEYWORDS,
  lookupCanonicalResource,
  schemaDocumentBase,
  visitOpenApiComponent,
  visitOpenApiSchemaTree,
  type OpenApiComponentKind,
  type OpenApiSchemaTreeHandlers,
} from './schema-projection.js';

function abortError(absoluteRef: string, signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new Error(`remote reference timed out: ${absoluteRef}`);
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function readLimitedBody(
  response: Response,
  maxBytes: number,
  absoluteRef: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw abortError(absoluteRef, signal);
  const stream = response.body;
  if (!stream) {
    const body = await response.text();
    if (signal?.aborted) throw abortError(absoluteRef, signal);
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      throw new Error(`remote reference exceeds ${maxBytes} bytes: ${absoluteRef}`);
    }
    return body;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder(undefined, { fatal: true });
  let body = '';
  let received = 0;
  let completed = false;
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError(absoluteRef, signal);
      const result = await reader.read();
      if (signal?.aborted) throw abortError(absoluteRef, signal);
      if (result.done) {
        completed = true;
        break;
      }
      const chunk = result.value;
      if (!chunk) continue;
      received += chunk.byteLength;
      if (received > maxBytes) {
        throw new Error(`remote reference exceeds ${maxBytes} bytes: ${absoluteRef}`);
      }
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    completed = false;
    if (signal?.aborted) throw abortError(absoluteRef, signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface ReferenceResolutionOptions {
  readonly allowRemoteRefs?: boolean;
  readonly remoteHosts?: readonly string[];
  readonly maxRefBytes?: number;
  readonly maxRefDocuments?: number;
  readonly refTimeoutMs?: number;
  readonly onInput?: InputObserver;
}

/**
 * Real path of `candidate`, or of its nearest existing ancestor with the
 * missing suffix segments appended, so a not-yet-loaded (or nonexistent)
 * path is still compared against a resolved root when the root or an
 * ancestor is reached through a symlink.
 */
function realpathOrNearestAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  const missingSuffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingSuffix.unshift(path.basename(current));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return missingSuffix.length ? path.join(real, ...missingSuffix) : real;
}

/** True when the candidate's real path leaves the input document directory. */
function localReferenceEscapes(rootDirectory: string, candidate: string): boolean {
  const rootReal = realpathOrNearestAncestor(rootDirectory);
  const boundaryPath = realpathOrNearestAncestor(candidate);
  const relative = path.relative(rootReal, boundaryPath);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

export interface ReferenceLoadOptions extends ReferenceResolutionOptions {
  /** Leave remote references unresolved instead of fetching them (input collection). */
  readonly skipRemote?: boolean;
}

export interface ReferenceTarget {
  readonly uri: string;
  /** JSON Pointer inside the target document; '' is the document root. */
  readonly pointer: string;
}

/**
 * What holds a reference value: a `$ref` or `$dynamicRef` keyword, a
 * discriminator `mapping` value, or a discriminator `defaultMapping`.
 */
export type ReferenceKeyword = '$ref' | '$dynamicRef' | 'mapping' | 'defaultMapping';

export interface ReferenceSite {
  readonly documentUri: string;
  /**
   * JSON Pointer of the object holding the reference value: the Schema or
   * Reference Object for `$ref`/`$dynamicRef`, the `discriminator.mapping`
   * object for `mapping`, the `discriminator` object for `defaultMapping`.
   */
  readonly ownerPointer: string;
  readonly keyword: ReferenceKeyword;
  /** The owner's key that holds the value: the keyword itself, or the mapping key. */
  readonly property: string;
  readonly reference: string;
  readonly kind: OpenApiComponentKind;
  /** The referenced node; null when the reference is kept as written with nothing to copy. */
  readonly target: ReferenceTarget | null;
  /** Keep the written value because a JSON Schema `$id` identifies the target. */
  readonly preserve: boolean;
}

export interface LoadedDocument {
  readonly uri: string;
  readonly document: unknown;
}

export interface ReferenceGraph {
  readonly rootUri: string;
  readonly rootDirectory: string;
  readonly documents: ReadonlyMap<string, LoadedDocument>;
  readonly sites: readonly ReferenceSite[];
  /** Every local file read or attempted, sorted; generation watches these. */
  readonly localFiles: readonly string[];
}

const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]*:/i;
const REMOTE_ACCEPT = 'application/yaml, application/json, application/openapi+json, */*;q=0.1';

function stripFragment(uri: string): string {
  const hash = uri.indexOf('#');
  return hash < 0 ? uri : uri.slice(0, hash);
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function anchorFragmentError(reference: string, documentUri: string): Error {
  return new Error(`anchor fragments are only supported within the root document: ${reference} (in ${documentUri})`);
}

function parseDocumentText(text: string, name: string): unknown {
  try {
    return name.toLowerCase().endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse referenced document ${name}: ${detail}`);
  }
}

const DOCUMENT_EXTENSION = /\.(?:json|ya?ml)$/i;

/**
 * A discriminator mapping value that names a schema component instead of a
 * URI reference: no `#`, `/` or scheme, and no `.json`/`.yaml`/`.yml` file
 * extension. In the root document, a value equal to a `components.schemas`
 * key is always a name. Names are kept as written; they name root components.
 */
function isMappingComponentName(value: string, rootSchemaNames: ReadonlySet<string> | undefined): boolean {
  if (rootSchemaNames?.has(value)) return true;
  return /^[^/:#]+$/.test(value) && !DOCUMENT_EXTENSION.test(value);
}

/**
 * Index every absolute `$id` so references to it are kept as identities, not
 * fetched. A document not loaded from `file:` cannot declare a `file:` `$id`:
 * a remote document must not shadow a local file.
 */
function registerAbsoluteIds(uri: string, node: unknown, pointer: string, ids: Map<string, ReferenceTarget>): void {
  const fromFile = new URL(uri).protocol === 'file:';
  const register = (current: unknown, currentPointer: string): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => { register(child, `${currentPointer}/${index}`); });
      return;
    }
    if (!isJsonObject(current)) return;
    if (typeof current.$id === 'string' && ABSOLUTE_URI.test(current.$id)) {
      const canonical = stripFragment(current.$id);
      const shadowsLocalFile = !fromFile && /^file:/i.test(canonical);
      if (!shadowsLocalFile && !ids.has(canonical)) ids.set(canonical, { uri, pointer: currentPointer });
    }
    for (const [key, child] of objectEntries(current)) {
      if (DATA_KEYWORDS.has(key)) continue;
      register(child, `${currentPointer}/${escapeJsonPointerToken(key)}`);
    }
  };
  register(node, pointer);
}

async function fetchRemoteDocument(uri: string, maxBytes: number, timeoutMs: number): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(uri, { redirect: 'error', signal, headers: { Accept: REMOTE_ACCEPT } });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`remote reference returned HTTP ${response.status}: ${uri}`);
  }
  const declaredLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`remote reference exceeds ${maxBytes} bytes: ${uri}`);
  }
  return readLimitedBody(response, maxBytes, uri, signal);
}

interface SiteResolution {
  readonly target: ReferenceTarget | null;
  readonly preserve: boolean;
}

/**
 * A reference site that may name a JSON Schema `$id` declared in a document
 * not loaded yet: its classification waits until the local queue drains.
 */
interface DeferredIdentitySite {
  readonly documentUri: string;
  readonly ownerPointer: string;
  readonly keyword: ReferenceKeyword;
  readonly property: string;
  readonly reference: string;
  readonly kind: OpenApiComponentKind;
  readonly schemaBase: string;
  readonly walkerPointer: string;
}

export async function loadReferenceGraph(
  filename: string,
  rootDocument: unknown,
  options: ReferenceLoadOptions = {},
): Promise<ReferenceGraph> {
  const rootFile = path.resolve(filename);
  const rootUri = pathToFileURL(rootFile).href;
  const rootDirectory = path.dirname(rootFile);
  const maxBytes = options.maxRefBytes || 5 * 1024 * 1024;
  const maxDocuments = options.maxRefDocuments || 256;
  const timeoutMs = options.refTimeoutMs || 10_000;
  const allowedHosts = new Set((options.remoteHosts ?? []).map((host) => String(host).toLowerCase()));
  const onInput: InputObserver | undefined = options.onInput;

  const documents = new Map<string, LoadedDocument>([[rootUri, { uri: rootUri, document: rootDocument }]]);
  const localFiles = new Set<string>([rootFile]);
  const absoluteIds = new Map<string, ReferenceTarget>();
  const rootResources = collectCanonicalResources(rootDocument);
  const sites: ReferenceSite[] = [];
  const seenSiteKeys = new Set<string>();
  const walked = new Set<string>();
  const pending: { readonly target: ReferenceTarget; readonly kind: OpenApiComponentKind }[] = [];
  const deferredIdentitySites: DeferredIdentitySite[] = [];
  const rootSchemaNames = new Set(Object.keys(asRecord(asRecord(asRecord(rootDocument).components).schemas)));
  let externalDocuments = 0;

  registerAbsoluteIds(rootUri, rootDocument, '', absoluteIds);

  const loadDocument = async (uri: string): Promise<LoadedDocument> => {
    if (externalDocuments + 1 > maxDocuments) throw new Error(`reference document limit exceeded (${maxDocuments})`);
    externalDocuments += 1;
    const url = new URL(uri);
    let document: unknown;
    if (url.protocol === 'file:') {
      const file = fileURLToPath(url);
      localFiles.add(file);
      onInput?.(file);
      if (!existsSync(file)) throw new Error(`referenced document does not exist: ${file}`);
      if (statSync(file).size > maxBytes) throw new Error(`referenced document exceeds ${maxBytes} bytes: ${file}`);
      document = parseDocumentText(readFileSync(file, 'utf8'), file);
    } else {
      document = parseDocumentText(await fetchRemoteDocument(uri, maxBytes, timeoutMs), uri);
    }
    const loaded: LoadedDocument = { uri, document };
    documents.set(uri, loaded);
    registerAbsoluteIds(uri, document, '', absoluteIds);
    return loaded;
  };

  /**
   * Resolve `reference` (already known to resolve to `file:` against
   * `documentUri`) to a local file target: reject an escape from the input
   * directory, reject a `file:` target named by a document that was not
   * itself loaded from `file:` (a fetched remote document must not be able
   * to read local files), and otherwise return the target. `onInput` is not
   * called here; it fires later, only if this target is actually loaded.
   */
  const resolveFileTarget = (documentUri: string, reference: string): SiteResolution => {
    const resolved = new URL(reference, documentUri);
    const fragment = decodeFragment(resolved.hash.replace(/^#/, ''));
    resolved.hash = '';
    const uri = resolved.href;
    const file = fileURLToPath(resolved);
    if (localReferenceEscapes(rootDirectory, file)) {
      throw new Error(`local reference escapes the input directory: ${file}`);
    }
    if (new URL(documentUri).protocol !== 'file:') {
      throw new Error(`remote document cannot reference local file: ${file}`);
    }
    return { target: { uri, pointer: fragment }, preserve: false };
  };

  /**
   * Classify one reference site. A reference is left `deferred` whenever its
   * final scheme, resolved against `documentUri` or against `schemaBase` (the
   * enclosing schema's own `$id`, when it has one), is not `file:`. Such a
   * reference may name a JSON Schema `$id` (`https://schemas.example/money`,
   * `urn:example:money`) declared in a document that has not loaded yet. The
   * `schemaBase` case covers a reference like `money` written inside a schema
   * whose own `$id` is `https://schemas.example/order`: resolved against the
   * physical `documentUri` it looks like a same-directory file, but it may
   * really name `https://schemas.example/money`. Whether such a site names a
   * registered `$id`, is blocked, uses a disallowed host, must be fetched, is
   * actually a local file, or uses an unsupported scheme is decided in
   * `resolveDeferredSite`, once the local queue has drained.
   */
  const classifySite = (
    documentUri: string,
    reference: string,
    schemaBase: string,
    keyword: ReferenceKeyword,
    walkerPointer: string,
  ): SiteResolution | 'deferred' => {
    const inRoot = documentUri === rootUri;
    if (reference.startsWith('#')) {
      const fragment = reference.slice(1);
      if (fragment === '' || fragment.startsWith('/')) {
        return { target: { uri: documentUri, pointer: decodeFragment(fragment) }, preserve: false };
      }
      if (keyword === '$dynamicRef' || inRoot) return { target: null, preserve: true };
      throw anchorFragmentError(reference, documentUri);
    }
    if (inRoot && lookupCanonicalResource(reference, schemaBase, rootResources)?.hasId) {
      return { target: null, preserve: true };
    }
    let resolved: URL;
    try {
      resolved = new URL(reference, documentUri);
    } catch {
      throw new Error(`invalid reference ${JSON.stringify(reference)} at ${walkerPointer}`);
    }
    const fragment = decodeFragment(resolved.hash.replace(/^#/, ''));
    if (fragment !== '' && !fragment.startsWith('/')) {
      throw anchorFragmentError(reference, documentUri);
    }
    if (resolved.protocol !== 'file:') return 'deferred';
    let bySchema: URL | undefined;
    try {
      bySchema = new URL(reference, schemaBase);
    } catch {
      // schemaBase is not a hierarchical base (e.g. the synthetic `urn:` document base).
    }
    if (bySchema && bySchema.protocol !== 'file:') return 'deferred';
    const identity = bySchema ? absoluteIds.get(stripFragment(bySchema.href)) : undefined;
    if (identity) return { target: identity, preserve: true };
    return resolveFileTarget(documentUri, reference);
  };

  /**
   * Resolve one previously deferred site, re-checking `$id` identity first
   * now that more documents may have loaded. When no identity matches and
   * the reference resolves to `file:` against its document (the `schemaBase`
   * case described on {@link classifySite}), fall back to local file
   * resolution. A scheme other than `http:`/`https:` names nothing loadable;
   * http(s) gets the skip/blocked/HTTPS/host/fetch decision.
   */
  const resolveDeferredSite = (item: DeferredIdentitySite): SiteResolution => {
    try {
      const identity = absoluteIds.get(stripFragment(new URL(item.reference, item.schemaBase).href));
      if (identity) return { target: identity, preserve: true };
    } catch {
      // Not resolvable against schemaBase; fall through to the documentUri-based resolution below.
    }
    const resolved = new URL(item.reference, item.documentUri);
    if (resolved.protocol === 'file:') {
      return resolveFileTarget(item.documentUri, item.reference);
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      throw new Error(`unsupported reference scheme ${resolved.protocol} in ${item.reference}`);
    }
    const fragment = decodeFragment(resolved.hash.replace(/^#/, ''));
    resolved.hash = '';
    const uri = resolved.href;
    if (options.skipRemote) return { target: null, preserve: false };
    if (!options.allowRemoteRefs) {
      throw new Error(`remote reference blocked at ${item.walkerPointer}: ${item.reference}; set allowRemoteRefs: true and remoteHosts in golem.yaml to opt in`);
    }
    if (allowedHosts.size === 0) throw new Error('remote references require at least one explicitly allowed remote host');
    if (resolved.protocol !== 'https:') throw new Error(`remote reference must use HTTPS: ${uri}`);
    if (!allowedHosts.has(resolved.hostname.toLowerCase())) {
      throw new Error(`remote reference host is not allowed: ${resolved.hostname}`);
    }
    return { target: { uri, pointer: fragment }, preserve: false };
  };

  const handlersFor = (documentUri: string): OpenApiSchemaTreeHandlers => {
    /**
     * `ownerPointer` is a plain JSON Pointer to the object holding the value
     * and `property` its key there; `walkerPointer` (`#`-prefixed) locates the
     * value itself in error messages.
     */
    const record = (
      keyword: ReferenceKeyword,
      ownerPointer: string,
      property: string,
      reference: string,
      schemaBase: string,
      walkerPointer: string,
      kind: OpenApiComponentKind,
    ): void => {
      const key = `${documentUri}\u0000${ownerPointer}\u0000${property}`;
      if (seenSiteKeys.has(key)) return;
      seenSiteKeys.add(key);
      const classified = classifySite(documentUri, reference, schemaBase, keyword, walkerPointer);
      if (classified === 'deferred') {
        deferredIdentitySites.push({ documentUri, ownerPointer, keyword, property, reference, kind, schemaBase, walkerPointer });
        return;
      }
      const { target, preserve } = classified;
      sites.push({ documentUri, ownerPointer, keyword, property, reference, kind, target, preserve });
      if (target) pending.push({ target, kind });
    };
    const keywordOwner = (walkerPointer: string, keyword: string): string => walkerPointer.slice(1, -(keyword.length + 1));
    const mappingNames = documentUri === rootUri ? rootSchemaNames : undefined;
    return {
      onSchemaRef(keyword, reference, currentBase, pointer) {
        record(keyword, keywordOwner(pointer, keyword), keyword, reference, currentBase, pointer, 'schemas');
      },
      onOpenApiRef(reference, pointer, kind) {
        record('$ref', keywordOwner(pointer, '$ref'), '$ref', reference, documentUri, pointer, kind);
      },
      onDiscriminatorMapping(keyword, reference, currentBase, ownerPointer, property) {
        if (isMappingComponentName(reference, mappingNames)) return;
        record(keyword, ownerPointer.slice(1), property, reference, currentBase, jsonPointerJoin(ownerPointer, property), 'schemas');
      },
    };
  };

  visitOpenApiSchemaTree(rootDocument, handlersFor(rootUri));
  while (pending.length > 0 || deferredIdentitySites.length > 0) {
    if (pending.length > 0) {
      const next = pending.shift();
      if (!next) continue;
      const walkKey = `${next.target.uri}#${next.target.pointer}\u0000${next.kind}`;
      if (walked.has(walkKey)) continue;
      walked.add(walkKey);
      const loaded = documents.get(next.target.uri) ?? await loadDocument(next.target.uri);
      const node = resolveJsonPointer(loaded.document, next.target.pointer);
      if (node === undefined) continue;
      const base = next.target.uri === rootUri ? schemaDocumentBase(rootDocument) : next.target.uri;
      visitOpenApiComponent(next.kind, node, base, `#${next.target.pointer}`, handlersFor(next.target.uri));
      continue;
    }
    // The local queue is drained and every loaded document's `$id`s are registered: resolve one
    // deferred site now. Its resolution (an identity match, or a fetched document) can
    // enqueue more local or deferred work, so the loop above keeps draining `pending` first.
    const item = deferredIdentitySites.shift();
    if (!item) continue;
    const { target, preserve } = resolveDeferredSite(item);
    sites.push({
      documentUri: item.documentUri,
      ownerPointer: item.ownerPointer,
      keyword: item.keyword,
      property: item.property,
      reference: item.reference,
      kind: item.kind,
      target,
      preserve,
    });
    if (target) pending.push({ target, kind: item.kind });
  }

  return {
    rootUri,
    rootDirectory,
    documents,
    sites,
    localFiles: [...localFiles].sort(),
  };
}
