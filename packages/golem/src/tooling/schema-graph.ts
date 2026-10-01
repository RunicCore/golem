/**
 * Intern schema descriptors into a dependency graph so stringify, parse, and
 * Ajv compile once per node and compose by call / $ref.
 */

import type { ModelTypeDescriptor } from '../model.js';
import { modelName } from '../model-name.js';
import {
  canonicalDescriptorKey,
  canonicalSchemaKey,
  constraintSchemaValues,
  GENERATED_MODEL_SCHEMA_REF_PREFIX,
  schemaForDescriptor,
  type JsonSchema,
  type ModelConstraint,
} from './schema.js';

export type SchemaNodeKind = 'object' | 'array' | 'tuple' | 'union' | 'intersection' | 'scalar' | 'reference' | 'operation';

export interface SchemaNode {
  readonly id: string;
  /** Human export name (`Payment`). */
  readonly name: string;
  /** Runtime codec / Ajv id (`Payment_a3f2c91b`). */
  readonly codecId: string;
  readonly descriptor: ModelTypeDescriptor;
  /** Wire JSON Schema (TSerde deserialize-param / encode output). */
  readonly jsonSchema: JsonSchema;
  /** Model JSON Schema (I* field / serialize-param). Used by validate<T>. */
  readonly modelJsonSchema: JsonSchema;
  /** True when interned wire and model schemas are the same node. */
  readonly sameSchema: boolean;
  /** What parse checks after decoding (`Id#model-only`); absent when nothing is left. */
  readonly modelOnlyJsonSchema?: JsonSchema;
  /** What stringify checks after encoding (`Id#wire-only`); absent when nothing is left. */
  readonly wireOnlyJsonSchema?: JsonSchema;
  readonly edges: readonly string[];
  readonly emitClass: boolean;
  /**
   * Resolved per-declaration validation flag. `undefined` inherits the emit
   * profile. `false` stubs `validate${id}` and parent schemas do not `$ref`
   * this node as if it had Ajv.
   */
  readonly validationEnabled?: boolean;
  readonly kind: SchemaNodeKind;
  /**
   * A model another generated module of the same job emits, by its known
   * codec id. Its schema is referenced by id; its code is not emitted here.
   */
  readonly siblingCodec?: true;
  /** An unnamed object type; model companions keep its codec functions module-private. */
  readonly anonymous?: true;
}

/** Deserialize-param descriptor attached by TSerde. */
export function serdeWireDescriptor(descriptor: ModelTypeDescriptor): ModelTypeDescriptor | undefined {
  const serde = descriptor.serde as
    | { readonly wire?: ModelTypeDescriptor; readonly wireDescriptor?: ModelTypeDescriptor }
    | undefined;
  if (!serde) return undefined;
  return serde.wireDescriptor ?? serde.wire;
}

export interface OperationNode {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly inputId?: string;
  readonly outputId?: string;
}

export interface SchemaGraph {
  readonly nodes: ReadonlyMap<string, SchemaNode>;
  readonly operations: ReadonlyMap<string, OperationNode>;
  intern(
    descriptor: ModelTypeDescriptor,
    name?: string,
    emitClass?: boolean,
    validationEnabled?: boolean,
  ): SchemaNode;
  /**
   * `constructs` selects the class or plain-object codec when one graph holds both
   * for a name and shape; without it, either matches.
   */
  nodeFor(descriptor: ModelTypeDescriptor, name?: string, constructs?: boolean): SchemaNode | undefined;
  addOperation(operation: OperationNode): void;
  seal(): void;
  topo(): readonly SchemaNode[];
}

export interface SchemaGraphOptions {
  /** Where the interned models come from; part of every computed codec id. Defaults to `typescript`. */
  readonly codecSource?: CodecBuildIdentity['source'];
  /**
   * Codec ids fixed by the job, by model short name. A named model interned
   * here takes this id; a reference to a name this graph does not define is a
   * sibling codec with this id.
   */
  readonly codecIds?: ReadonlyMap<string, string>;
  /**
   * Codec ids and aliases of models emitted elsewhere (sibling companions,
   * SDK manifests) that publish `#model-only` / `#wire-only` schemas.
   */
  readonly externalResidualIds?: { readonly modelOnly: ReadonlySet<string>; readonly wireOnly: ReadonlySet<string> };
}

function nodeKind(descriptor: ModelTypeDescriptor): SchemaNodeKind {
  switch (descriptor.kind) {
    case 'object': return 'object';
    case 'array': return 'array';
    case 'tuple': return 'tuple';
    case 'union': return 'union';
    case 'intersection': return 'intersection';
    case 'reference':
    case 'generated-model': return 'reference';
    default: return 'scalar';
  }
}

function namedIdentity(descriptor: ModelTypeDescriptor): string | undefined {
  if (descriptor.kind === 'reference') return descriptor.name;
  if (descriptor.kind === 'generated-model') return descriptor.id;
  return undefined;
}

function childDescriptors(descriptor: ModelTypeDescriptor): readonly ModelTypeDescriptor[] {
  switch (descriptor.kind) {
    case 'object': {
      const extra = typeof descriptor.additionalProperties === 'object'
        ? [descriptor.additionalProperties]
        : [];
      return [...Object.values(descriptor.properties), ...extra];
    }
    case 'array': return [descriptor.item];
    case 'tuple': return [
      ...descriptor.items,
      ...(descriptor.rest ? [descriptor.rest.item] : []),
    ];
    case 'union':
    case 'intersection': return descriptor.variants;
    default: return [];
  }
}

function identifierFromName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function codecShortName(name: string): string {
  const segment = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const cleaned = segment.replace(/[^A-Za-z0-9_]/g, '_');
  const ident = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return modelName(ident);
}

/** The raw name without its path and invalid characters, before the codec rule shortens it. */
function sameBaseName(left: string, right: string): boolean {
  const base = (name: string): string => name.slice(name.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9_]/g, '_');
  return base(left) === base(right);
}

/** FNV-1a 32-bit as 8 lowercase hex digits. Stable across Node and browsers. */
export function hash8(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface CodecShapeLookup {
  readonly codecId: (shortName: string) => string | undefined;
  readonly cycling: (shortName: string) => boolean;
}

type CodecShape = ModelTypeDescriptor | { readonly kind: 'cycle'; readonly name: string };

function namedShapeName(descriptor: ModelTypeDescriptor): string | undefined {
  if (descriptor.kind === 'generated-model') return codecShortName(descriptor.id);
  if (descriptor.kind === 'reference') return codecShortName(descriptor.name);
  return undefined;
}

/**
 * Shape used for codec ids. Named IObject refs, IModel classes, and OpenAPI
 * generated-model $refs of the same contract share one shape. Runtime
 * construct/projection flags are not part of it; codecPublicId adds the source
 * and construction separately.
 *
 * Graph intern substitutes interned children's final codec ids. Unit tests that
 * call codecPublicId without a graph keep short-name refs.
 */
function codecShapeDescriptor(
  descriptor: ModelTypeDescriptor,
  lookup?: CodecShapeLookup,
): CodecShape {
  const named = namedShapeName(descriptor);
  if (named !== undefined) {
    if (lookup?.cycling(named)) return { kind: 'cycle', name: named };
    const interned = lookup?.codecId(named);
    return { kind: 'reference', name: interned ?? named };
  }
  if (descriptor.kind === 'object') {
    return {
      kind: 'object',
      properties: Object.fromEntries(
        Object.entries(descriptor.properties)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, property]) => [name, codecShapeDescriptor(property, lookup)]),
      ),
      required: [...descriptor.required].sort(),
      additionalProperties: typeof descriptor.additionalProperties === 'object'
        ? codecShapeDescriptor(descriptor.additionalProperties, lookup)
        : descriptor.additionalProperties,
      ...(descriptor.constraints ? { constraints: descriptor.constraints } : {}),
      ...(descriptor.validations ? { validations: descriptor.validations } : {}),
      ...(descriptor.serde ? { serde: { id: descriptor.serde.id } as typeof descriptor.serde } : {}),
    } as ModelTypeDescriptor;
  }
  if (descriptor.kind === 'array') {
    return { ...descriptor, item: codecShapeDescriptor(descriptor.item, lookup) as ModelTypeDescriptor };
  }
  if (descriptor.kind === 'tuple') {
    return {
      ...descriptor,
      items: descriptor.items.map((item) => codecShapeDescriptor(item, lookup) as ModelTypeDescriptor),
      ...(descriptor.rest
        ? { rest: { ...descriptor.rest, item: codecShapeDescriptor(descriptor.rest.item, lookup) as ModelTypeDescriptor } }
        : {}),
    };
  }
  if (descriptor.kind === 'union' || descriptor.kind === 'intersection') {
    const variants = descriptor.variants.map((variant) => {
      const shape = codecShapeDescriptor(variant, lookup);
      return { shape, key: canonicalDescriptorKey(shape) };
    });
    // Sort for a stable identity; an explicit tag table follows its variants.
    const order = variants.map((_, index) => index)
      .sort((left, right) => variants[left].key.localeCompare(variants[right].key));
    const discriminator = descriptor.kind === 'union' ? descriptor.discriminator : undefined;
    return {
      ...descriptor,
      variants: order.map((index) => variants[index].shape) as ModelTypeDescriptor[],
      ...(discriminator
        ? { discriminator: { ...discriminator, variants: order.map((index) => discriminator.variants[index]) } }
        : {}),
    };
  }
  return descriptor;
}

function namedCodecRefs(descriptor: ModelTypeDescriptor): readonly string[] {
  const names = new Set<string>();
  const walk = (value: ModelTypeDescriptor): void => {
    const named = namedShapeName(value);
    if (named !== undefined) {
      names.add(named);
      return;
    }
    for (const child of childDescriptors(value)) walk(child);
    const wire = serdeWireDescriptor(value);
    if (wire && wire !== value) walk(wire);
  };
  walk(descriptor);
  return [...names];
}

/** Intern named descriptors children-first so parent hashes include nested codec ids. */
export function internDescriptors(
  graph: SchemaGraph,
  entries: ReadonlyArray<{
    readonly name: string;
    readonly descriptor: ModelTypeDescriptor;
    readonly emitClass?: boolean;
    readonly validationEnabled?: boolean;
  }>,
): ReadonlyMap<string, string> {
  const interned = new Set<(typeof entries)[number]>();
  const nodeIds = new Map<string, string>();
  const stack = new Set<string>();
  const visit = (entry: (typeof entries)[number]): void => {
    if (interned.has(entry)) return;
    if (stack.has(entry.name)) return;
    stack.add(entry.name);
    for (const child of namedCodecRefs(entry.descriptor)) {
      for (const next of entries) {
        if (codecShortName(next.name) === child) visit(next);
      }
    }
    interned.add(entry);
    nodeIds.set(entry.name, graph.intern(entry.descriptor, entry.name, entry.emitClass === true, entry.validationEnabled).id);
    stack.delete(entry.name);
  };
  for (const entry of entries) visit(entry);
  return nodeIds;
}

/** How a codec builds values: where its model comes from and whether `parse` constructs a class. */
export interface CodecBuildIdentity {
  readonly source: 'typescript' | 'openapi';
  readonly constructs: boolean;
}

/**
 * Runtime codec id: short name plus a hash of the contract shape and, when given,
 * how the codec builds values, not the file path. A plain-object codec and a class
 * codec, or a TypeScript and an OpenAPI codec, never share an id.
 */
export function codecPublicId(
  name: string,
  descriptor: ModelTypeDescriptor,
  lookup?: CodecShapeLookup,
  identity?: CodecBuildIdentity,
): string {
  const shape = codecShapeDescriptor(descriptor, lookup);
  const key = identity === undefined
    ? canonicalDescriptorKey(shape)
    : `${identity.source}:${identity.constructs ? 'class' : 'plain'}:${canonicalDescriptorKey(shape)}`;
  return `${codecShortName(name)}_${hash8(key)}`;
}

/**
 * `<file>#<name>`: the emitted class name when the entry gives one (the ttsc plugin applies
 * `modelName` to it when it loads the table and when it looks a class up), otherwise the
 * codec short name of the model.
 */
function codecDeclarationKey(source: string, name: string, className?: string): string {
  return `${source.replace(/\\/g, '/')}#${className ?? codecShortName(name)}`;
}

export function emitCodecDeclarationTable(
  entries: ReadonlyArray<{ readonly source: string; readonly name: string; readonly codecId: string; readonly className?: string }>,
  owner = '@exprtlabs/golem',
): string {
  const seen = new Map<string, string>();
  // The plugin loads keys through `modelName`, so keys it would collapse must not differ in id.
  const loaded = new Map<string, { readonly key: string; readonly codecId: string }>();
  for (const entry of entries) {
    const key = codecDeclarationKey(entry.source, entry.name, entry.className);
    const loadedKey = `${key.slice(0, key.lastIndexOf('#'))}#${modelName(key.slice(key.lastIndexOf('#') + 1))}`;
    const previous = loaded.get(loadedKey);
    if (previous !== undefined && previous.codecId !== entry.codecId) {
      throw new TypeError(
        `Codec declaration ${JSON.stringify(key)} maps to both ${previous.codecId} and ${entry.codecId}: `
        + `it loads as ${JSON.stringify(loadedKey)}, the same as ${JSON.stringify(previous.key)}.`,
      );
    }
    loaded.set(loadedKey, { key, codecId: entry.codecId });
    seen.set(key, entry.codecId);
  }
  const lines = [...seen.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, id]) => `  ${JSON.stringify(key)}: ${JSON.stringify(id)},`);
  return [
    `/* Generated by ${owner}. Do not edit. */`,
    'export const IOBJECT_PLUGIN_KEYS = {',
    ...lines,
    '} as const;',
    '',
  ].join('\n');
}

function structural(descriptor: ModelTypeDescriptor): boolean {
  return nodeKind(descriptor) === 'object';
}

function asReference(name: string): ModelTypeDescriptor {
  return { kind: 'reference', name };
}

function isPlaceholder(node: SchemaNode, named: string | undefined): boolean {
  return node.kind === 'reference' || node.codecId === named;
}

function isTypeDescriptor(value: unknown): value is ModelTypeDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'kind') === 'string';
}

function namedReference(
  node: SchemaNode,
  original: ModelTypeDescriptor,
): ModelTypeDescriptor {
  const projection = original.kind === 'reference' ? original.projection : undefined;
  // Construct is a field-type flag (class vs type alias), not intern identity.
  // TItem and Item share a codec node; only `Item` fields should construct.
  const construct = projection
    ? undefined
    : original.kind === 'reference' && original.construct === true
      ? true as const
      : original.kind === 'generated-model' && node.emitClass
        ? true as const
        : undefined;
  return {
    kind: 'reference',
    name: node.codecId,
    ...(construct ? { construct: true as const } : {}),
    ...(projection ? { projection: true as const } : {}),
    ...(original.validations ? { validations: original.validations } : {}),
    ...(original.constraints ? { constraints: original.constraints } : {}),
    ...(original.serde ? { serde: original.serde } : {}),
  };
}

function rewriteConstraint(
  constraint: ModelConstraint,
  lookup: (descriptor: ModelTypeDescriptor) => SchemaNode | undefined,
): ModelConstraint {
  const rewriteValue = (value: unknown): unknown => (
    isTypeDescriptor(value) ? rewriteToRefs(value, lookup) : value
  );
  switch (constraint.kind) {
    case 'contains':
    case 'propertyNames':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'items':
    case 'unevaluatedItems':
    case 'not':
    case 'patternProperties':
      return { ...constraint, schema: rewriteValue(constraint.schema) as typeof constraint.schema };
    case 'dependentSchemas':
      return {
        ...constraint,
        value: Object.fromEntries(
          Object.entries(constraint.value).map(([name, schema]) => [name, rewriteValue(schema) as typeof schema]),
        ),
      };
    case 'oneOf':
      return {
        ...constraint,
        schemas: constraint.schemas.map((schema) => rewriteValue(schema) as typeof schema),
      };
    case 'ifThenElse':
      return {
        ...constraint,
        if: rewriteValue(constraint.if) as typeof constraint.if,
        ...(constraint.then === undefined ? {} : { then: rewriteValue(constraint.then) as typeof constraint.then }),
        ...(constraint.else === undefined ? {} : { else: rewriteValue(constraint.else) as typeof constraint.else }),
      };
    default:
      return constraint;
  }
}

function rewriteMetadata(
  descriptor: ModelTypeDescriptor,
  lookup: (descriptor: ModelTypeDescriptor) => SchemaNode | undefined,
): ModelTypeDescriptor {
  const constraints = descriptor.constraints?.map((constraint) => rewriteConstraint(constraint, lookup));
  const wire = serdeWireDescriptor(descriptor);
  const serde = descriptor.serde && wire && wire !== descriptor
    ? { ...descriptor.serde, wire: rewriteToRefs(wire, lookup) }
    : descriptor.serde;
  if (constraints === undefined && serde === descriptor.serde) return descriptor;
  return {
    ...descriptor,
    ...(constraints ? { constraints } : {}),
    ...(serde ? { serde } : {}),
  };
}

function rewriteToRefs(
  descriptor: ModelTypeDescriptor,
  lookup: (descriptor: ModelTypeDescriptor) => SchemaNode | undefined,
): ModelTypeDescriptor {
  const named = namedIdentity(descriptor);
  let rewritten: ModelTypeDescriptor;
  if (named) {
    const node = lookup(descriptor) ?? lookup(asReference(named));
    if (node && (node.descriptor.kind === 'object' || node.siblingCodec)) {
      // Keep named references for conversion/construct. Parent Ajv schemas
      // inline an opaque object when the child did not emit a codec.
      rewritten = namedReference(node, descriptor);
    } else rewritten = descriptor;
  } else {
    switch (descriptor.kind) {
      case 'object':
        rewritten = {
          ...descriptor,
          properties: Object.fromEntries(
            Object.entries(descriptor.properties).map(([name, property]) => [
              name,
              rewriteToRefs(property, lookup),
            ]),
          ),
          additionalProperties: typeof descriptor.additionalProperties === 'object'
            ? rewriteToRefs(descriptor.additionalProperties, lookup)
            : descriptor.additionalProperties,
        };
        break;
      case 'array':
        rewritten = { ...descriptor, item: rewriteToRefs(descriptor.item, lookup) };
        break;
      case 'tuple':
        rewritten = {
          ...descriptor,
          items: descriptor.items.map((item) => rewriteToRefs(item, lookup)),
          rest: descriptor.rest
            ? { ...descriptor.rest, item: rewriteToRefs(descriptor.rest.item, lookup) }
            : descriptor.rest,
        };
        break;
      case 'union':
      case 'intersection':
        rewritten = {
          ...descriptor,
          variants: descriptor.variants.map((variant) => rewriteToRefs(variant, lookup)),
        };
        break;
      default:
        rewritten = descriptor;
        break;
    }
  }
  return rewriteMetadata(rewritten, lookup);
}

export function createSchemaGraph(
  definitions: Readonly<Record<string, ModelTypeDescriptor>> = {},
  options: SchemaGraphOptions = {},
): SchemaGraph {
  const nodes = new Map<string, SchemaNode>();
  const operations = new Map<string, OperationNode>();
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  // Interned nodes by the exact name they were interned under; short names can be ambiguous, these are not.
  const byRawName = new Map<string, string>();
  const rawNameOf = new Map<string, string>();
  const byPublicId = new Map<string, string>();
  const codecSource = options.codecSource ?? 'typescript';
  let anonymous = 0;
  let sealed = false;

  // Short names being interned, for codec shapes; raw names being interned, for cycle detection.
  const internStack = new Set<string>();
  const internRawStack = new Set<string>();
  const internLookup = (): CodecShapeLookup => ({
    cycling: (short) => internStack.has(short),
    codecId: (short) => {
      if (internStack.has(short)) return undefined;
      const nodeId = byName.get(short) ?? byPublicId.get(short);
      const node = nodeId ? nodes.get(nodeId) : undefined;
      if (!node || (node.kind === 'reference' && !node.siblingCodec)) return undefined;
      return node.codecId;
    },
  });

  const rememberShortName = (named: string, id: string): void => {
    const existing = byName.get(named);
    if (existing === undefined) {
      byName.set(named, id);
      return;
    }
    if (existing !== id) byName.delete(named);
  };

  const nodeFor = (descriptor: ModelTypeDescriptor, name?: string, constructs?: boolean): SchemaNode | undefined => {
    const named = name ?? namedIdentity(descriptor);
    if (named) {
      if (descriptor.kind === 'object' || (name !== undefined && descriptor.kind !== 'reference' && descriptor.kind !== 'generated-model')) {
        const lookup = internLookup();
        const hashed = (constructs === undefined ? [true, false] : [constructs])
          .map((constructs) => byPublicId.get(codecPublicId(named, descriptor, lookup, { source: codecSource, constructs })))
          .find((id) => id !== undefined);
        if (hashed) return nodes.get(hashed);
      }
      const publicHit = byPublicId.get(named);
      if (publicHit) return nodes.get(publicHit);
      const id = byRawName.get(named) ?? byName.get(named);
      return id ? nodes.get(id) : undefined;
    }
    const id = byKey.get(canonicalDescriptorKey(descriptor));
    return id ? nodes.get(id) : undefined;
  };

  const cyclePlaceholder = (raw: string, named: string, descriptor: ModelTypeDescriptor): SchemaNode => {
    const rawId = byRawName.get(raw);
    const rawExisting = rawId ? nodes.get(rawId) : undefined;
    if (rawExisting) return rawExisting;
    const shortId = byName.get(named);
    const shortExisting = shortId ? nodes.get(shortId) : undefined;
    const shortRaw = shortExisting ? rawNameOf.get(shortExisting.id) : undefined;
    if (shortExisting && (shortRaw === undefined || sameBaseName(shortRaw, raw))) return shortExisting;
    const id = identifierFromName(nodes.has(identifierFromName(named)) ? raw : named);
    const placeholder: SchemaNode = {
      id,
      name: named,
      codecId: named,
      descriptor,
      jsonSchema: true,
      modelJsonSchema: true,
      sameSchema: true,
      edges: [],
      emitClass: false,
      kind: nodeKind(descriptor),
    };
    nodes.set(id, placeholder);
    rememberShortName(named, id);
    byRawName.set(raw, id);
    rawNameOf.set(id, raw);
    return placeholder;
  };

  const intern = (
    descriptor: ModelTypeDescriptor,
    name?: string,
    emitClass = false,
    validationEnabled?: boolean,
  ): SchemaNode => {
    if (sealed) throw new TypeError('Schema graph is sealed.');
    const applyFlags = (existing: SchemaNode): SchemaNode => {
      const nextEmit = emitClass || existing.emitClass;
      const nextValidation = validationEnabled !== undefined ? validationEnabled : existing.validationEnabled;
      if (nextEmit === existing.emitClass && nextValidation === existing.validationEnabled) return existing;
      const next: SchemaNode = {
        ...existing,
        emitClass: nextEmit,
        ...(nextValidation === undefined ? {} : { validationEnabled: nextValidation }),
      };
      nodes.set(existing.id, next);
      return next;
    };
    if (descriptor.kind === 'generated-model' || descriptor.kind === 'reference') {
      const raw = name ?? namedIdentity(descriptor) ?? 'Generated';
      const named = codecShortName(raw);
      const interned = byRawName.get(raw);
      const rawHit = interned === undefined ? undefined : nodes.get(interned);
      if (rawHit) return applyFlags(rawHit);
      const found = nodeFor(descriptor, named) ?? nodeFor(asReference(named), named);
      // A short-name hit interned under another raw name is a different schema.
      const hitRaw = found === undefined ? undefined : rawNameOf.get(found.id);
      const existing = hitRaw === undefined || sameBaseName(hitRaw, raw) ? found : undefined;
      if (existing) return applyFlags(existing);
      // A reference to an ambiguous short name must not take the id of a node interned under it.
      const taken = nodes.get(identifierFromName(named));
      const id = taken && taken.kind !== 'reference' ? identifierFromName(`${raw}__reference`) : identifierFromName(named);
      const siblingId = descriptor.kind === 'reference' ? options.codecIds?.get(named) : undefined;
      const placeholder: SchemaNode = {
        id,
        name: named,
        codecId: siblingId ?? named,
        descriptor,
        jsonSchema: { type: 'object' },
        modelJsonSchema: { type: 'object' },
        sameSchema: true,
        edges: [],
        emitClass: false,
        kind: 'reference',
        ...(validationEnabled === undefined ? {} : { validationEnabled }),
        ...(siblingId === undefined ? {} : { siblingCodec: true as const }),
      };
      if (siblingId !== undefined) byPublicId.set(siblingId, id);
      nodes.set(id, placeholder);
      rememberShortName(named, id);
      if (raw !== named) rememberShortName(raw, id);
      byRawName.set(raw, id);
      rawNameOf.set(id, raw);
      return placeholder;
    }
    const raw = name ?? namedIdentity(descriptor);
    const named = raw ? codecShortName(raw) : undefined;
    if (raw && named && internRawStack.has(raw)) return cyclePlaceholder(raw, named, descriptor);
    if (namedIdentity(descriptor) && !name) {
      const existing = nodeFor(descriptor);
      if (existing) return applyFlags(existing);
    }
    if (!named && !structural(descriptor)) {
      const id = `__scalar_${(anonymous += 1).toString(36)}`;
      return {
        id,
        name: id,
        codecId: id,
        descriptor,
        jsonSchema: true,
        modelJsonSchema: true,
        sameSchema: true,
        edges: [],
        emitClass: false,
        kind: 'scalar',
      };
    }
    if (!named) {
      const existingId = byKey.get(canonicalDescriptorKey(descriptor));
      if (existingId) {
        const existing = nodes.get(existingId);
        if (existing) return existing;
      }
    }
    const stackKey = named ?? `__anon_stack_${(anonymous += 1).toString(36)}`;
    const shortOnStack = internStack.has(stackKey);
    internStack.add(stackKey);
    if (raw) internRawStack.add(raw);
    const nestedEdges: string[] = [];
    const internNested = (child: ModelTypeDescriptor): void => {
      if (namedIdentity(child) || structural(child)) {
        const childNode = namedIdentity(child)
          ? intern(child)
          : intern(child, undefined, false, validationEnabled);
        if (!childNode.id.startsWith('__scalar_')) nestedEdges.push(childNode.id);
      } else {
        for (const nested of childDescriptors(child)) internNested(nested);
      }
      const wire = serdeWireDescriptor(child);
      if (wire && wire !== child) internNested(wire);
    };
    for (const child of childDescriptors(descriptor)) internNested(child);
    for (const constraint of descriptor.constraints ?? []) {
      for (const value of constraintSchemaValues(constraint)) {
        if (isTypeDescriptor(value)) internNested(value);
      }
    }
    // An unnamed object type is identified by its shape, so its id is stable across unrelated edits
    // and two files' anonymous types never share an id unless they are the same codec.
    const computedId = codecPublicId(named ?? 'Anonymous', descriptor, internLookup(), { source: codecSource, constructs: emitClass });
    const publicId = named ? options.codecIds?.get(named) ?? computedId : computedId;
    if (!shortOnStack) internStack.delete(stackKey);
    if (raw) internRawStack.delete(raw);
    // A placeholder made for this exact raw name stands in for the node; another raw name's is a different schema.
    const rawPlaceholderId = raw ? byRawName.get(raw) : undefined;
    const rawPlaceholder = rawPlaceholderId ? nodes.get(rawPlaceholderId) : undefined;
    const shortHitId = named ? byName.get(named) : undefined;
    const shortHit = shortHitId ? nodes.get(shortHitId) : undefined;
    const shortHitRaw = shortHit ? rawNameOf.get(shortHit.id) : undefined;
    const shortExisting = rawPlaceholder
      ?? (shortHit && raw && shortHitRaw !== undefined && !sameBaseName(shortHitRaw, raw) && isPlaceholder(shortHit, named)
        ? undefined
        : shortHit);
    if (named && publicId) {
      const hashedId = byPublicId.get(publicId);
      if (hashedId) {
        const existing = nodes.get(hashedId);
        if (existing) return applyFlags(existing);
      }
      const cycleHit = shortExisting && shortExisting.codecId === named && shortExisting.kind !== 'reference';
      // The same short name with a different shape keeps both nodes.
      if (!cycleHit && shortExisting && shortExisting.kind !== 'reference' && shortExisting.codecId === publicId) {
        return applyFlags(shortExisting);
      }
    }
    const preferredId = identifierFromName(named ?? computedId);
    const taken = nodes.get(preferredId);
    const cycleHit = Boolean(named && shortExisting && shortExisting.codecId === named && shortExisting.kind !== 'reference');
    const id = cycleHit && shortExisting
      ? shortExisting.id
      : shortExisting?.kind === 'reference'
        ? shortExisting.id
        : taken && publicId && taken.codecId !== publicId
          ? identifierFromName(publicId)
          : preferredId;
    const placeholder: SchemaNode = {
      id,
      name: named ?? id,
      codecId: publicId ?? id,
      descriptor,
      jsonSchema: true,
      modelJsonSchema: true,
      sameSchema: true,
      edges: [...new Set(nestedEdges)].filter((edge) => edge !== id),
      emitClass,
      kind: nodeKind(descriptor),
      ...(validationEnabled === undefined ? {} : { validationEnabled }),
      ...(named ? {} : { anonymous: true as const }),
    };
    if (shortExisting?.kind === 'reference' && shortExisting.id !== id) {
      nodes.delete(shortExisting.id);
    }
    nodes.set(id, placeholder);
    if (!byKey.has(canonicalDescriptorKey(descriptor))) {
      byKey.set(canonicalDescriptorKey(descriptor), id);
    }
    if (publicId) byPublicId.set(publicId, id);
    // A job-fixed id replaces the local hash; lookups by that hash still find the node.
    if (computedId && computedId !== publicId && !byPublicId.has(computedId)) byPublicId.set(computedId, id);
    if (named) rememberShortName(named, id);
    if (raw && raw !== named) rememberShortName(raw, id);
    if (raw) {
      byRawName.set(raw, id);
      rawNameOf.set(id, raw);
    }
    return placeholder;
  };

  const seal = (): void => {
    const rewrittenNodes = new Map<string, ModelTypeDescriptor>();
    for (const [id, node] of nodes) {
      rewrittenNodes.set(id, rewriteToRefs(node.descriptor, (descriptor) => nodeFor(descriptor)));
    }
    // A sibling codec's schema is registered by its own module; reference it by id.
    const definitionsMap = Object.fromEntries(
      [...nodes.values()].map((node) => [node.codecId, node.siblingCodec
        ? { kind: 'generated-model', id: node.codecId } as ModelTypeDescriptor
        : rewrittenNodes.get(node.id) ?? node.descriptor]),
    );
    const opaqueReferenceIds = new Set(
      [...nodes.values()]
        .filter((node) => node.validationEnabled === false)
        .flatMap((node) => [node.codecId, node.name, node.id]),
    );
    for (const [id, node] of nodes) {
      const rewritten = rewrittenNodes.get(id) ?? node.descriptor;
      const options = {
        definitions: definitionsMap,
        executableBindings: true,
        opaqueReferenceIds,
      } as const;
      const jsonSchema = schemaForDescriptor(rewritten, { ...options, representation: 'wire' });
      const modelJsonSchema = schemaForDescriptor(rewritten, { ...options, representation: 'model' });
      nodes.set(id, {
        ...node,
        descriptor: rewritten,
        jsonSchema,
        modelJsonSchema,
        sameSchema: canonicalSchemaKey(jsonSchema) === canonicalSchemaKey(modelJsonSchema),
      });
    }
    // Residual schemas: iterate to a fixed point so a reference (recursive ones
    // included) points at a residual schema only when that model has one.
    const residualIds = {
      modelOnly: new Set<string>(options.externalResidualIds?.modelOnly ?? []),
      wireOnly: new Set<string>(options.externalResidualIds?.wireOnly ?? []),
    };
    // External codecs (another module or an SDK) publish their own residual schemas.
    const residualCandidates = [...nodes.entries()].filter(([, node]) =>
      !node.sameSchema && node.validationEnabled !== false && !node.siblingCodec
      && node.kind !== 'reference' && node.descriptor.kind !== 'generated-model' && node.descriptor.kind !== 'reference');
    const derive = (id: string, node: SchemaNode, plane: 'model-only' | 'wire-only'): JsonSchema =>
      schemaForDescriptor(rewrittenNodes.get(id) ?? node.descriptor, {
        definitions: definitionsMap,
        executableBindings: true,
        opaqueReferenceIds,
        representation: plane,
        residualReferences: residualIds,
        referencePrefix: GENERATED_MODEL_SCHEMA_REF_PREFIX,
      });
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, node] of residualCandidates) {
        for (const plane of ['model-only', 'wire-only'] as const) {
          const found = plane === 'model-only' ? residualIds.modelOnly : residualIds.wireOnly;
          if (found.has(node.codecId) || derive(id, node, plane) === true) continue;
          for (const alias of [node.codecId, node.name, node.id]) found.add(alias);
          changed = true;
        }
      }
    }
    for (const [id, node] of residualCandidates) {
      const modelOnly = derive(id, node, 'model-only');
      const wireOnly = derive(id, node, 'wire-only');
      nodes.set(id, {
        ...node,
        ...(modelOnly === true ? {} : { modelOnlyJsonSchema: modelOnly }),
        ...(wireOnly === true ? {} : { wireOnlyJsonSchema: wireOnly }),
      });
    }
    sealed = true;
  };

  internDescriptors(
    { intern } as SchemaGraph,
    Object.entries(definitions).map(([name, descriptor]) => ({ name, descriptor })),
  );

  return {
    nodes,
    operations,
    intern,
    nodeFor,
    addOperation(operation) {
      operations.set(operation.id, operation);
    },
    seal,
    topo() {
      const visiting = new Set<string>();
      const ordered: SchemaNode[] = [];
      const seen = new Set<string>();
      const visit = (id: string): void => {
        if (seen.has(id) || id.startsWith('__scalar_')) return;
        if (visiting.has(id)) return;
        visiting.add(id);
        const node = nodes.get(id);
        if (!node) return;
        for (const edge of node.edges) visit(edge);
        visiting.delete(id);
        seen.add(id);
        ordered.push(node);
      };
      for (const id of nodes.keys()) visit(id);
      return ordered;
    },
  };
}
