import { compareText } from '@exprtlabs/golem/generator-api';
import { identifier } from '@exprtlabs/golem/internal/generator-support';
import { escapePointerToken } from '@exprtlabs/golem/internal/schema';
import { escapeJsonPointerToken, isJsonObject, resolveJsonPointer, unescapeJsonPointerToken } from './json.js';
import { displayLocation, displayUri } from './origin.js';
import type { ReferenceGraph, ReferenceSite, ReferenceTarget } from './reference-loader.js';
import type { OpenApiComponentKind } from './schema-projection.js';

interface SourceOrigin {
  readonly uri: string;
  readonly pointer: string;
}

export interface BundledDocument {
  readonly document: Record<string, unknown>;
  /** Map a JSON Pointer in the bundled document to the document and pointer it came from. */
  originOf(pointer: string): SourceOrigin;
}

interface Hoist {
  readonly key: string;
  readonly target: ReferenceTarget;
  readonly kind: OpenApiComponentKind;
  readonly name: string;
  readonly node: unknown;
  readonly firstSite: ReferenceSite;
  /** This hoist's name came from a root component that was a bare `$ref` to it, not from `componentNameFor`. */
  readonly fromRootAlias: boolean;
}

const NAMED_DEFINITION_CONTAINERS = new Set(['$defs', 'definitions']);

function siteLocation(site: ReferenceSite, rootDirectory: string): string {
  return displayLocation(site.documentUri, site.ownerPointer, rootDirectory);
}

/**
 * Render a plain, internal RFC 6901 pointer (no percent-encoding) as a
 * `$ref` URI fragment, token by token: unescape the plain `~0`/`~1` escaping,
 * then re-escape with `escapePointerToken`'s `~0`/`~1` + percent-encoding.
 * `'' -> '#'`.
 */
function fragmentRef(pointer: string): string {
  if (pointer === '') return '#';
  return `#${pointer.slice(1).split('/').map((token) => `/${escapePointerToken(unescapeJsonPointerToken(token))}`).join('')}`;
}

/**
 * Path-based component name: source path (relative to the root document, or
 * host + path for remote documents) without extension, then the fragment. A
 * fragment naming a component or a `$defs`/`definitions` entry contributes
 * only that entry's name.
 */
export function componentNameFor(target: ReferenceTarget, rootDirectory: string): string {
  const source = displayUri(target.uri, rootDirectory);
  const url = new URL(target.uri);
  const sourcePath = url.protocol === 'file:' ? source : `${url.hostname}${url.pathname}`;
  const sourceSegments = sourcePath.replace(/\.[^./]+$/, '').split('/').filter((segment) => segment !== '' && segment !== '.');
  const tokens = target.pointer === '' ? [] : target.pointer.slice(1).split('/').map(unescapeJsonPointerToken);
  const [first, second, third] = tokens;
  const fragmentSegments = tokens.length === 3 && first === 'components' && third !== undefined
    ? [third]
    : tokens.length === 2 && first !== undefined && NAMED_DEFINITION_CONTAINERS.has(first) && second !== undefined
      ? [second]
      : tokens;
  const name = [...sourceSegments, ...fragmentSegments].join('.').replace(/[^A-Za-z0-9._-]/g, '_');
  return name || 'external';
}

function isBareRefObject(node: unknown): node is { readonly $ref: string } {
  return isJsonObject(node) && typeof node.$ref === 'string' && Object.keys(node).length === 1;
}

interface RootAliasCandidate {
  readonly key: string;
  readonly name: string;
}

/**
 * Every root component that is nothing but a direct `$ref` to an external
 * target (e.g. `Money: { $ref: './money.json' }`): a root-authored owner
 * object at `/components/<kind>/<Name>` holding no key besides `$ref`, whose
 * reference is not `preserve`d, resolves outside the root document. Such a
 * component names the hoisted entry itself rather than being an independent
 * schema, so its own `Name` becomes the hoist's name (see
 * {@link primaryRootAliasNames}) instead of `componentNameFor`'s path-based
 * name.
 */
function collectRootAliasCandidates(graph: ReferenceGraph, rootDocument: unknown): readonly RootAliasCandidate[] {
  const candidates: RootAliasCandidate[] = [];
  for (const site of graph.sites) {
    if (site.keyword !== '$ref' || site.documentUri !== graph.rootUri || site.preserve || !site.target || site.target.uri === graph.rootUri) continue;
    const match = /^\/components\/([^/]+)\/([^/]+)$/.exec(site.ownerPointer);
    if (!match) continue;
    if (unescapeJsonPointerToken(match[1]) !== site.kind) continue;
    if (!isBareRefObject(resolveJsonPointer(rootDocument, site.ownerPointer))) continue;
    candidates.push({ key: `${site.target.uri}#${site.target.pointer}`, name: unescapeJsonPointerToken(match[2]) });
  }
  return candidates;
}

/**
 * For each target with one or more root-alias candidates, the alias `Name`
 * that becomes the hoist's name: the smallest in code-unit order, so the
 * choice is deterministic regardless of declaration order. Every other
 * alias to the same target keeps its own root pointer and is rewritten, like
 * any other reference, to point at the winning name.
 */
function primaryRootAliasNames(candidates: readonly RootAliasCandidate[]): ReadonlyMap<string, string> {
  const namesByKey = new Map<string, string[]>();
  for (const candidate of candidates) {
    const names = namesByKey.get(candidate.key);
    if (names) names.push(candidate.name);
    else namesByKey.set(candidate.key, [candidate.name]);
  }
  const primary = new Map<string, string>();
  for (const [key, names] of namesByKey) {
    primary.set(key, [...names].sort(compareText)[0]);
  }
  return primary;
}

function assertUniqueNames(
  hoists: readonly Hoist[],
  rootComponents: unknown,
  rootUri: string,
  rootDirectory: string,
  primaryAliasRootKeys: ReadonlySet<string>,
): void {
  const claims = new Map<string, string>();
  const claim = (kind: string, name: string, origin: string, check: boolean): void => {
    const keys: readonly [string, string][] = [
      [`${kind}\u0000key\u0000${name}`, JSON.stringify(name)],
      [`${kind}\u0000id\u0000${identifier(name)}`, `identifier ${identifier(name)}`],
    ];
    for (const [key, label] of keys) {
      const existing = claims.get(key);
      if (check && existing !== undefined && existing !== origin) {
        throw new Error(`components/${kind} name collision: ${existing} and ${origin} both map to ${label}`);
      }
      if (existing === undefined) claims.set(key, origin);
    }
  };
  const components = isJsonObject(rootComponents) ? rootComponents : {};
  for (const [kind, entries] of Object.entries(components)) {
    if (!isJsonObject(entries)) continue;
    for (const name of Object.keys(entries)) {
      // The root component that names a hoist (its own bare-$ref definition) is that hoist:
      // it is claimed below, once, by the hoist loop, not as a second, separate name.
      if (primaryAliasRootKeys.has(`${kind}\u0000${name}`)) continue;
      const origin = displayLocation(rootUri, `/components/${kind}/${escapeJsonPointerToken(name)}`, rootDirectory);
      claim(kind, name, origin, false);
    }
  }
  for (const hoist of hoists) {
    claim(hoist.kind, hoist.name, displayLocation(hoist.target.uri, hoist.target.pointer, rootDirectory), true);
  }
}

export function bundleReferenceGraph(graph: ReferenceGraph): BundledDocument {
  const rootDocument = graph.documents.get(graph.rootUri)?.document;
  if (!isJsonObject(rootDocument)) throw new TypeError('root OpenAPI document must be an object');
  const result: Record<string, unknown> = structuredClone(rootDocument);
  const primaryAliasNames = primaryRootAliasNames(collectRootAliasCandidates(graph, rootDocument));
  const byKey = new Map<string, Hoist>();
  for (const site of graph.sites) {
    const target = site.target;
    if (!target || target.uri === graph.rootUri) continue;
    const key = `${target.uri}#${target.pointer}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.kind !== site.kind) {
        throw new Error(
          `${displayLocation(target.uri, target.pointer, graph.rootDirectory)} is referenced as components/${existing.kind} at ${siteLocation(existing.firstSite, graph.rootDirectory)} and as components/${site.kind} at ${siteLocation(site, graph.rootDirectory)}`,
        );
      }
      continue;
    }
    const node = resolveJsonPointer(graph.documents.get(target.uri)?.document, target.pointer);
    if (node === undefined) continue;
    const aliasName = primaryAliasNames.get(key);
    byKey.set(key, {
      key,
      target,
      kind: site.kind,
      name: aliasName ?? componentNameFor(target, graph.rootDirectory),
      node,
      firstSite: site,
      fromRootAlias: aliasName !== undefined,
    });
  }
  const hoists = [...byKey.values()].sort((a, b) => compareText(a.kind, b.kind) || compareText(a.name, b.name));
  const primaryAliasRootKeys = new Set(hoists.filter((hoist) => hoist.fromRootAlias).map((hoist) => `${hoist.kind}\u0000${hoist.name}`));
  assertUniqueNames(hoists, result.components, graph.rootUri, graph.rootDirectory, primaryAliasRootKeys);

  const rewrittenValue = (site: ReferenceSite): string | undefined => {
    if (site.preserve || !site.target) return undefined;
    if (site.target.uri === graph.rootUri) {
      return site.documentUri === graph.rootUri ? undefined : fragmentRef(site.target.pointer);
    }
    const hoist = byKey.get(`${site.target.uri}#${site.target.pointer}`);
    return hoist ? `#/components/${hoist.kind}/${escapePointerToken(hoist.name)}` : undefined;
  };
  const rewriteIn = (container: unknown, relativePointer: string, site: ReferenceSite): void => {
    const value = rewrittenValue(site);
    if (value === undefined) return;
    const owner = resolveJsonPointer(container, relativePointer);
    if (isJsonObject(owner)) Reflect.set(owner, site.property, value);
  };

  const clones = new Map<string, unknown>(hoists.map((hoist) => [hoist.key, structuredClone(hoist.node)]));
  for (const site of graph.sites) {
    if (site.documentUri === graph.rootUri) {
      rewriteIn(result, site.ownerPointer, site);
      continue;
    }
    for (const hoist of hoists) {
      const prefix = hoist.target.pointer;
      if (hoist.target.uri !== site.documentUri) continue;
      if (site.ownerPointer !== prefix && !site.ownerPointer.startsWith(`${prefix}/`)) continue;
      rewriteIn(clones.get(hoist.key), site.ownerPointer.slice(prefix.length), site);
    }
  }

  if (hoists.length) {
    const components: Record<string, unknown> = isJsonObject(result.components) ? result.components : {};
    result.components = components;
    for (const hoist of hoists) {
      const existing = components[hoist.kind];
      const section: Record<string, unknown> = isJsonObject(existing) ? existing : {};
      components[hoist.kind] = section;
      section[hoist.name] = clones.get(hoist.key);
    }
  }

  const origins = hoists.map((hoist) => ({
    prefix: `/components/${hoist.kind}/${escapeJsonPointerToken(hoist.name)}`,
    target: hoist.target,
  }));
  return {
    document: result,
    originOf(pointer: string): SourceOrigin {
      for (const { prefix, target } of origins) {
        if (pointer === prefix || pointer.startsWith(`${prefix}/`)) {
          return { uri: target.uri, pointer: `${target.pointer}${pointer.slice(prefix.length)}` };
        }
      }
      return { uri: graph.rootUri, pointer };
    },
  };
}
