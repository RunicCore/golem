/**
 * Ajv's `discriminator` keyword rejects the OpenAPI `mapping` property and
 * requires each `oneOf` branch to state its tag as a string `const`/`enum`.
 * OpenAPI documents instead map tag values to schema references. Lower that
 * form before compiling: each mapped branch is wrapped with its tag values,
 * so validation keeps the mapping's meaning.
 */

import { escapePointerToken, unescapePointerToken } from './json-pointer.js';

type SchemaRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveUri(reference: string, base: string | undefined): string {
  if (base !== undefined) {
    try { return new URL(reference, base).href; } catch { /* a non-hierarchical base keeps the reference */ }
  }
  return reference;
}

/** Schema resources by absolute `$id`, and the resource base of every schema node. */
interface SchemaIndex {
  readonly root: SchemaRecord;
  readonly resources: ReadonlyMap<string, SchemaRecord>;
  readonly bases: WeakMap<object, string | undefined>;
}

function indexSchema(root: SchemaRecord): SchemaIndex {
  const resources = new Map<string, SchemaRecord>();
  const bases = new WeakMap<object, string | undefined>();
  const visit = (value: unknown, base: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, base);
      return;
    }
    if (!isRecord(value) || bases.has(value)) return;
    const id = typeof value.$id === 'string' ? resolveUri(value.$id, base).replace(/#$/, '') : undefined;
    if (id !== undefined) resources.set(id, value);
    const current = id ?? base;
    bases.set(value, current);
    for (const item of Object.values(value)) visit(item, current);
  };
  visit(root, undefined);
  return { root, resources, bases };
}

/**
 * The schema a reference points at within the indexed document, following a
 * resource `$id` and a JSON Pointer fragment. A bare component name is the
 * OpenAPI shorthand for `#/components/schemas/<name>`.
 */
function referencedSchema(index: SchemaIndex, reference: string, base: string | undefined): SchemaRecord | undefined {
  const target = /^[^/:#]+$/.test(reference) ? `#/components/schemas/${escapePointerToken(reference)}` : reference;
  const hash = target.indexOf('#');
  const uri = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? '' : target.slice(hash + 1);
  const resource = uri === ''
    ? (base === undefined ? index.root : index.resources.get(base) ?? index.root)
    : index.resources.get(resolveUri(uri, base));
  if (!resource || (fragment !== '' && !fragment.startsWith('/'))) return undefined;
  let current: unknown = resource;
  for (const token of fragment === '' ? [] : fragment.slice(1).split('/')) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[unescapePointerToken(token)];
  }
  return isRecord(current) ? current : undefined;
}

/**
 * The schema a reference denotes. A schema that is only a `$ref` is an alias
 * of its target, so aliases are followed; an alias cycle has no schema.
 */
function resolveReference(index: SchemaIndex, reference: string, base: string | undefined): SchemaRecord | undefined {
  let current = referencedSchema(index, reference, base);
  const seen = new Set<SchemaRecord>();
  while (current && typeof current.$ref === 'string' && Object.keys(current).length === 1) {
    if (seen.has(current)) throw new TypeError(`Schema reference ${JSON.stringify(reference)} is a cycle of $ref aliases.`);
    seen.add(current);
    const next = referencedSchema(index, current.$ref, index.bases.get(current));
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * The component a document reference names, when it cannot be resolved in
 * this schema: the last pointer token (`#/components/schemas/Pet%20Food`) or a
 * bare name. Other identifiers match only exactly.
 */
function componentName(reference: string): string | undefined {
  if (reference.includes('#/')) {
    const token = reference.slice(reference.lastIndexOf('/') + 1);
    return token ? unescapePointerToken(token) : undefined;
  }
  return /^[^/:#]+$/.test(reference) ? reference : undefined;
}

function branchReference(branch: unknown): string | undefined {
  return isRecord(branch) && typeof branch.$ref === 'string' ? branch.$ref : undefined;
}

function lowerNode(node: SchemaRecord, original: SchemaRecord, index: SchemaIndex): SchemaRecord {
  const discriminator = node.discriminator;
  if (!isRecord(discriminator)) return node;
  const { discriminator: _dropped, ...rest } = node;
  const branches: readonly unknown[] | undefined = Array.isArray(node.oneOf) ? node.oneOf
    : Array.isArray(node.anyOf) ? node.anyOf : undefined;
  const keyword = Array.isArray(node.oneOf) ? 'oneOf' : 'anyOf';
  // Ajv's discriminator applies only to oneOf; elsewhere it is an annotation.
  if (!branches || (keyword === 'anyOf' && !isRecord(discriminator.mapping))) return rest;
  if (!isRecord(discriminator.mapping)) return node;
  const property = discriminator.propertyName;
  if (typeof property !== 'string') throw new TypeError('A discriminator mapping requires a propertyName.');
  const base = index.bases.get(original);
  const references = branches.map(branchReference);
  const resolved = references.map((reference) => reference === undefined ? undefined : resolveReference(index, reference, base));
  const names = references.map((reference) => reference === undefined ? undefined : componentName(reference));
  const values = branches.map((): string[] => []);
  for (const [value, target] of Object.entries(discriminator.mapping)) {
    if (typeof target !== 'string') throw new TypeError(`Discriminator mapping ${JSON.stringify(value)} must name a schema.`);
    // Match by schema identity; a reference to a resource outside this schema falls back to its component name.
    const schema = resolveReference(index, target, base);
    let branch = schema === undefined ? -1 : resolved.findIndex((candidate) => candidate === schema);
    if (branch < 0) branch = references.findIndex((reference) => reference === target);
    if (branch < 0 && (schema === undefined || resolved.some((candidate) => candidate === undefined))) {
      const name = componentName(target);
      branch = name === undefined ? -1 : names.findIndex((candidate, position) =>
        candidate === name && (schema === undefined || resolved[position] === undefined));
    }
    if (branch < 0) {
      throw new TypeError(`Discriminator mapping ${JSON.stringify(value)} targets ${JSON.stringify(target)}, which is not a ${keyword} branch.`);
    }
    values[branch].push(value);
  }
  // A branch without an explicit mapping keeps the implicit value: its component name.
  const tagged = branches.map((branch, position) => {
    const name = names[position];
    const tags = values[position].length > 0 ? values[position] : name === undefined ? [] : [name];
    if (tags.length === 0) return branch;
    return {
      properties: { [property]: tags.length === 1 ? { const: tags[0] } : { enum: tags } },
      required: [property],
      allOf: [branch],
    };
  });
  const everyTagged = tagged.every((branch, position) => branch !== branches[position]);
  return {
    ...rest,
    [keyword]: tagged,
    // Ajv's discriminator needs oneOf with a tag on every branch.
    ...(keyword === 'oneOf' && everyTagged ? { discriminator: { propertyName: property } } : {}),
  };
}

/** A copy of `schema` whose discriminator mappings are lowered; unchanged parts are shared. */
export function lowerDiscriminatorMappings<Schema>(schema: Schema): Schema {
  if (!isRecord(schema)) return schema;
  const index = indexSchema(schema);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(visit);
      return items.some((item, position) => item !== value[position]) ? items : value;
    }
    if (!isRecord(value)) return value;
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const next = visit(item);
      if (next !== item) changed = true;
      return [key, next] as const;
    });
    const node = changed ? Object.fromEntries(entries) : value;
    return lowerNode(node, value, index);
  };
  return visit(schema) as Schema;
}
