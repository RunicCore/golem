import { isBinaryMediaType, isBuiltinTextMediaType } from './client/codecs.js';
import { asRecord, isJsonObject, objectEntries, type JsonObject } from './json.js';
import { identifier, NameScope, propertyName } from '@exprtlabs/golem/generator-api';
import { refName } from './names.js';
import {
  effectiveSchemaTypes,
  parameterSchema,
  resolveLocal,
  type NormalizedOperation,
  type NormalizedResponse,
  type OpenApiMediaType,
  type OpenApiSchema,
} from './normalize.js';
import { manifestMarker } from '@exprtlabs/golem/manifest';
import { generatedBanner } from './package-info.js';
import { projectSchema, collectCanonicalResources, nextSchemaBase, resolveSchemaTarget, schemaDocumentBase, schemaTargetIdentity, type ResolvedSchemaTarget, type ResourceIndex } from './schema-projection.js';

export type TextSchemaKind = 'string' | 'unknown' | 'non-string' | 'ambiguous';

export interface TextSchemaClassification {
  readonly kind: TextSchemaKind;
  readonly schemaType: string;
}

export interface TextCodecRequirement {
  readonly option: 'bodyEncoders' | 'responseDecoders';
  readonly schemaType: string;
}

const NON_STRING_JSON_TYPES = new Set(['number', 'integer', 'boolean', 'object', 'array']);

interface TextSchemaEnv {
  readonly document: unknown;
  readonly resources: ResourceIndex;
  readonly currentBase: string;
  readonly visiting: Set<string>;
  readonly visitingNodes: Set<object>;
}

function unknownTextSchema(schemaType = 'unknown'): TextSchemaClassification {
  return { kind: 'unknown', schemaType };
}

function allOfTextSchemas(
  left: TextSchemaClassification,
  right: TextSchemaClassification,
): TextSchemaClassification {
  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;
  if (left.kind === 'ambiguous' || right.kind === 'ambiguous') {
    return { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  if (left.kind === 'string' && right.kind === 'string') return left;
  if (left.kind === 'non-string' && right.kind === 'non-string') {
    return left.schemaType === right.schemaType ? left : { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  return { kind: 'ambiguous', schemaType: 'ambiguous' };
}

function anyOfTextSchemas(parts: readonly TextSchemaClassification[]): TextSchemaClassification {
  if (!parts.length) return unknownTextSchema();
  if (parts.every((part) => part.kind === 'string')) return { kind: 'string', schemaType: 'string' };
  if (parts.every((part) => part.kind === 'unknown')) return unknownTextSchema();
  if (parts.every((part) => part.kind === 'non-string')) {
    const types = new Set(parts.map((part) => part.schemaType));
    if (types.size === 1) return parts[0] ?? { kind: 'non-string', schemaType: 'ambiguous' };
  }
  return { kind: 'ambiguous', schemaType: 'ambiguous' };
}

function classifyConstValue(value: unknown): TextSchemaClassification {
  if (typeof value === 'string') return { kind: 'string', schemaType: 'string' };
  if (value === null) return { kind: 'non-string', schemaType: 'null' };
  if (typeof value === 'number') return { kind: 'non-string', schemaType: 'number' };
  if (typeof value === 'boolean') return { kind: 'non-string', schemaType: 'boolean' };
  if (Array.isArray(value)) return { kind: 'non-string', schemaType: 'array' };
  return { kind: 'non-string', schemaType: 'object' };
}

function withNullAlternative(
  classification: TextSchemaClassification,
  includesNull: boolean,
): TextSchemaClassification {
  if (!includesNull) return classification;
  if (classification.kind === 'string') return { kind: 'ambiguous', schemaType: 'string | null' };
  if (classification.kind === 'non-string' && classification.schemaType !== 'null') {
    return { kind: 'ambiguous', schemaType: `${classification.schemaType} | null` };
  }
  return classification;
}

function classifyTextSchemaLocal(schema: JsonObject): TextSchemaClassification {
  if (schema.const !== undefined) return classifyConstValue(schema.const);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return { kind: 'ambiguous', schemaType: 'never' };
    const hasNull = schema.enum.some((value) => value === null);
    const concrete = schema.enum.filter((value) => value !== null);
    if (concrete.length === 0) return { kind: 'non-string', schemaType: 'null' };
    const kinds = new Set(concrete.map((value) => typeof value));
    if (kinds.size === 1 && kinds.has('string')) {
      return withNullAlternative({ kind: 'string', schemaType: 'string' }, hasNull);
    }
    if (kinds.size === 1) {
      const [schemaType] = kinds;
      return withNullAlternative(
        { kind: 'non-string', schemaType: schemaType ?? 'ambiguous' },
        hasNull,
      );
    }
    return { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  const types = effectiveSchemaTypes(schema);
  const concrete = types.filter((type) => type !== 'null');
  const includesNull = types.includes('null');
  if (concrete.includes('string') && concrete.some((type) => type !== 'string')) {
    return { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  if (concrete.length === 1 && concrete[0] === 'string') {
    if (schema.format === 'binary') {
      return withNullAlternative({ kind: 'non-string', schemaType: 'binary' }, includesNull);
    }
    return withNullAlternative({ kind: 'string', schemaType: 'string' }, includesNull);
  }
  if (concrete.length === 1 && concrete[0] && NON_STRING_JSON_TYPES.has(concrete[0])) {
    return withNullAlternative({ kind: 'non-string', schemaType: concrete[0] }, includesNull);
  }
  if (concrete.length > 1) return { kind: 'ambiguous', schemaType: 'ambiguous' };
  if (includesNull) {
    return { kind: 'non-string', schemaType: 'null' };
  }
  if (schema.properties || schema.additionalProperties !== undefined) {
    return { kind: 'non-string', schemaType: 'object' };
  }
  if (Array.isArray(schema.prefixItems) || schema.items !== undefined) {
    return { kind: 'non-string', schemaType: 'array' };
  }
  return unknownTextSchema();
}

function classifyTextSchemaNode(
  schema: unknown,
  env: TextSchemaEnv,
): TextSchemaClassification {
  if (schema === null || schema === undefined || schema === true) return unknownTextSchema();
  if (schema === false) return { kind: 'ambiguous', schemaType: 'never' };
  if (!isJsonObject(schema)) return unknownTextSchema();
  if (env.visitingNodes.has(schema)) return { kind: 'ambiguous', schemaType: 'ambiguous' };
  env.visitingNodes.add(schema);
  try {
    const currentBase = nextSchemaBase(schema, env.currentBase, env.resources);
    const nested: TextSchemaEnv = { ...env, currentBase };
    const reference = typeof schema.$ref === 'string'
      ? schema.$ref
      : typeof schema.$dynamicRef === 'string'
        ? schema.$dynamicRef
        : undefined;
    let fromRef: TextSchemaClassification | undefined;
    if (reference !== undefined) {
      const target = resolveSchemaTarget(reference, currentBase, env.resources, env.document);
      if (!target) {
        fromRef = { kind: 'ambiguous', schemaType: 'unresolved' };
      } else {
        const identity = schemaTargetIdentity(target);
        if (env.visiting.has(identity)) {
          fromRef = { kind: 'ambiguous', schemaType: 'ambiguous' };
        } else {
          env.visiting.add(identity);
          try {
            fromRef = classifyTextSchemaNode(target.schema, { ...nested, currentBase: target.currentBase });
          } finally {
            env.visiting.delete(identity);
          }
        }
      }
    }
    const local = classifyTextSchemaLocal(schema);
    const allOf = Array.isArray(schema.allOf)
      ? schema.allOf.map((item) => classifyTextSchemaNode(item, nested))
      : [];
    const alternatives = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : undefined;
    const fromAlternatives = alternatives
      ? anyOfTextSchemas(alternatives.map((item) => classifyTextSchemaNode(item, nested)))
      : undefined;
    let result = [fromRef, local, ...allOf, fromAlternatives].reduce<TextSchemaClassification>(
      (combined, part) => (part ? allOfTextSchemas(combined, part) : combined),
      unknownTextSchema(),
    );
    if (
      result.kind === 'unknown'
      && (schema.if !== undefined || schema.then !== undefined || schema.else !== undefined)
    ) {
      result = { kind: 'ambiguous', schemaType: 'ambiguous' };
    }
    return result;
  } finally {
    env.visitingNodes.delete(schema);
  }
}

export function classifyTextSchema(schema: unknown, document: unknown): TextSchemaClassification {
  return classifyTextSchemaNode(schema, {
    document,
    resources: collectCanonicalResources(document),
    currentBase: schemaDocumentBase(document),
    visiting: new Set<string>(),
    visitingNodes: new Set<object>(),
  });
}

export function textCodecRequirement(
  media: Pick<OpenApiMediaType, 'contentType' | 'schema'>,
  option: 'bodyEncoders' | 'responseDecoders',
  document: unknown,
): TextCodecRequirement | undefined {
  if (!isBuiltinTextMediaType(media.contentType)) return undefined;
  const classified = classifyTextSchema(media.schema, document);
  if (classified.kind === 'string' || classified.kind === 'unknown') return undefined;
  const direction = option === 'bodyEncoders' ? 'input' : 'output';
  return {
    option,
    schemaType: schemaType(media.schema, schemaContext(document, { direction })),
  };
}

export interface SchemaTypeContext {
  readonly direction?: 'input' | 'output';
  readonly qualifier?: string;
  readonly anchors?: ReadonlyMap<string, string>;
  readonly recordType?: { readonly name: string; used: boolean };
  /** Present only when a component shadows the global `Blob` in the emitted module. */
  readonly blobType?: { readonly name: string; used: boolean };
  readonly document?: unknown;
  readonly resources?: ResourceIndex;
  readonly currentBase?: string;
  readonly inlining?: ReadonlySet<string>;
}

function generatedRecordType(
  scope: NameScope,
  declaredNames: readonly string[],
): { readonly name: string; used: boolean } {
  const reserved = new Set(declaredNames);
  let name = '__OpenApiRecord';
  let suffix = 0;
  while (reserved.has(name) || scope.has(name)) {
    suffix += 1;
    name = `__OpenApiRecord${suffix}`;
  }
  scope.claim(name, 'internal mapped Record utility type');
  return { name, used: false };
}

/** Alias the global `Blob` when a component named `Blob` shadows it in the emitted module. */
function generatedBlobType(
  scope: NameScope,
  declaredNames: readonly string[],
): { readonly name: string; used: boolean } | undefined {
  if (!declaredNames.includes('Blob')) return undefined;
  const reserved = new Set(declaredNames);
  let name = '__OpenApiBlob';
  for (let suffix = 1; reserved.has(name) || scope.has(name); suffix += 1) name = `__OpenApiBlob${suffix}`;
  scope.claim(name, 'internal global Blob alias');
  return { name, used: false };
}

function blobType(context: SchemaTypeContext): string {
  const utility = context.blobType;
  if (!utility) return 'Blob';
  utility.used = true;
  return utility.name;
}

/** `T[]` never names the global `Array`, which a component may shadow. */
function arrayType(item: string): string {
  return /^[\w$.]+$/.test(item) ? `${item}[]` : `(${item})[]`;
}

function recordType(context: SchemaTypeContext, valueType: string): string {
  const utility = context.recordType;
  if (!utility) return `Record<string, ${valueType}>`;
  utility.used = true;
  return `${utility.name}<string, ${valueType}>`;
}

function emitRecordType(
  output: string[],
  index: number,
  utility: { readonly name: string; used: boolean },
): void {
  if (!utility.used) return;
  output.splice(index, 0, `type ${utility.name}<K extends string | number | symbol, V> = { [P in K]: V };`, '');
}

function emitBlobType(output: string[], index: number, utility: { readonly name: string; used: boolean } | undefined): void {
  // The module's own `Blob` shadows the global name, so reach it through globalThis.
  if (utility?.used) output.splice(index, 0, `type ${utility.name} = InstanceType<typeof globalThis.Blob>;`, '');
}

function componentAnchorTypes(document: unknown): Map<string, string> {
  const anchors = new Map<string, string>();
  const ambiguous = new Set<string>();
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  for (const [name, schema] of objectEntries(schemas)) {
    if (!isJsonObject(schema)) continue;
    for (const anchor of [schema.$anchor, schema.$dynamicAnchor]) {
      if (typeof anchor !== 'string') continue;
      const reference = `#${anchor}`;
      if (anchors.has(reference)) ambiguous.add(reference);
      else anchors.set(reference, identifier(name));
    }
  }
  for (const reference of ambiguous) anchors.delete(reference);
  return anchors;
}

export function schemaContext(
  document: unknown,
  context: SchemaTypeContext = {},
  componentName?: string,
  componentSchema?: unknown,
): SchemaTypeContext {
  const anchors = new Map(context.anchors || componentAnchorTypes(document));
  if (componentName && isJsonObject(componentSchema)) {
    if (typeof componentSchema.$anchor === 'string') {
      anchors.set(`#${componentSchema.$anchor}`, identifier(componentName));
    }
    if (typeof componentSchema.$dynamicAnchor === 'string') {
      anchors.set(`#${componentSchema.$dynamicAnchor}`, identifier(componentName));
    }
  }
  return {
    ...context,
    document,
    anchors,
    resources: context.resources ?? collectCanonicalResources(document),
    currentBase: context.currentBase ?? schemaDocumentBase(document),
  };
}

export function schemaType(schema: unknown, context: SchemaTypeContext = {}): string {
  const projected = context.direction
    ? projectSchema(schema, { document: context.document ?? {}, direction: context.direction })
    : schema;
  return schemaTypeNode(projected, context);
}

function prefixItemsType(schema: JsonObjectLike, context: SchemaTypeContext): string {
  const prefix = (Array.isArray(schema.prefixItems) ? schema.prefixItems : [])
    .map((item) => schemaTypeNode(item, context));
  const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
  const max = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
  const additional = schema.items === false
    ? null
    : schema.items !== undefined && schema.items !== null
      ? schemaTypeNode(schema.items, context)
      : 'unknown';
  if (max !== undefined && max < min) return 'never';
  if (additional === null && min > prefix.length) return 'never';
  const variants: string[] = [];
  const lastExact = additional === null
    ? (max === undefined ? prefix.length : Math.min(prefix.length, max))
    : Math.min(prefix.length, max === undefined ? prefix.length : max);
  const minExact = Math.max(0, Math.min(min, prefix.length));
  for (let length = minExact; length <= lastExact; length += 1) {
    if (length === 0) variants.push('[]');
    else variants.push(`[${prefix.slice(0, length).join(', ')}]`);
  }
  if (additional !== null && (max === undefined || max > prefix.length || min > prefix.length)) {
    variants.push(`[${prefix.join(', ')}${prefix.length ? ', ' : ''}...${arrayType(additional)}]`);
  }
  const unique = [...new Set(variants)];
  return unique.length ? unique.join(' | ') : 'never';
}

function projectedResourceSchema(schema: unknown, context: SchemaTypeContext): unknown {
  if (!context.direction || context.document === undefined) return schema;
  return projectSchema(schema, {
    document: context.document,
    direction: context.direction,
    resources: context.resources,
  });
}

function cyclicSchemaRef(
  schema: unknown,
  currentBase: string,
  resources: ResourceIndex | undefined,
  inlining: ReadonlySet<string>,
  document?: unknown,
): boolean {
  if (!isJsonObject(schema) || !resources) return false;
  const reference = typeof schema.$ref === 'string'
    ? schema.$ref
    : typeof schema.$dynamicRef === 'string'
      ? schema.$dynamicRef
      : null;
  if (typeof reference !== 'string') return false;
  const target = resolveSchemaTarget(reference, nextSchemaBase(schema, currentBase, resources), resources, document);
  return Boolean(target && inlining.has(schemaTargetIdentity(target)));
}

function schemaWithoutCyclicRefs(
  schema: unknown,
  currentBase: string,
  resources: ResourceIndex | undefined,
  inlining: ReadonlySet<string>,
  document?: unknown,
): unknown {
  const cyclic: Record<string, unknown> = { ...asRecord(schema) };
  delete cyclic.$ref;
  delete cyclic.$dynamicRef;
  const dropCyclic = (value: unknown): boolean => !cyclicSchemaRef(value, currentBase, resources, inlining, document);
  if (isJsonObject(cyclic.properties)) {
    cyclic.properties = Object.fromEntries(objectEntries(cyclic.properties).filter(([, value]) => dropCyclic(value)));
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
    const children = cyclic[keyword];
    if (Array.isArray(children)) cyclic[keyword] = children.filter(dropCyclic);
  }
  if (cyclicSchemaRef(cyclic.items, currentBase, resources, inlining, document)) delete cyclic.items;
  return cyclic;
}

function inlinedTargetType(target: ResolvedSchemaTarget, context: SchemaTypeContext): string {
  const resources = context.resources;
  const identity = schemaTargetIdentity(target);
  const inner: SchemaTypeContext = {
    ...context,
    currentBase: target.currentBase,
    resources,
  };
  if (context.inlining?.has(identity)) {
    return schemaTypeNode(
      projectedResourceSchema(
        schemaWithoutCyclicRefs(target.schema, target.currentBase, resources, context.inlining, context.document),
        context,
      ),
      inner,
    );
  }
  const inlining = new Set(context.inlining);
  inlining.add(identity);
  return schemaTypeNode(projectedResourceSchema(target.schema, context), { ...inner, inlining });
}

function referencedSchemaType(reference: string, context: SchemaTypeContext): string {
  const resources = context.resources;
  const currentBase = context.currentBase ?? '';
  if (resources) {
    const target = resolveSchemaTarget(reference, currentBase, resources, context.document);
    if (target) {
      if (target.exactComponent) return `${context.qualifier || ''}${target.exactComponent.typeName}`;
      return inlinedTargetType(target, context);
    }
  }
  const name = refName(reference);
  return name ? `${context.qualifier || ''}${name}` : 'unknown';
}

function schemaTypeNode(schema: unknown, context: SchemaTypeContext = {}): string {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!isJsonObject(schema)) return 'unknown';
  const resources = context.resources ?? (context.document ? collectCanonicalResources(context.document) : undefined);
  const currentBase = nextSchemaBase(
    schema,
    context.currentBase ?? (context.document ? schemaDocumentBase(context.document) : ''),
    resources,
  );
  const inner: SchemaTypeContext = { ...context, resources, currentBase };
  if (typeof schema.$dynamicRef === 'string' || typeof schema.$ref === 'string') {
    const reference = String(schema.$dynamicRef || schema.$ref);
    const anchored = inner.anchors && inner.anchors.get(reference);
    if (anchored) return `${inner.qualifier || ''}${anchored}`;
  }
  if (typeof schema.$ref === 'string') {
    return referencedSchemaType(schema.$ref, inner);
  }
  if (typeof schema.$dynamicRef === 'string') {
    return referencedSchemaType(schema.$dynamicRef, inner);
  }
  if (schema.not === true) return 'never';
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return 'never';
    const excluded = isJsonObject(schema.not)
      ? new Set(
        schema.not.const !== undefined
          ? [JSON.stringify(schema.not.const)]
          : Array.isArray(schema.not.enum)
            ? schema.not.enum.map((value) => JSON.stringify(value))
            : [],
      )
      : new Set<string>();
    const values = schema.enum
      .map((value) => JSON.stringify(value))
      .filter((value) => !excluded.has(value));
    return values.length ? values.join(' | ') : 'never';
  }
  const types = effectiveSchemaTypes(schema);
  const nullable = types.includes('null');
  const concrete = types.filter((type) => type !== 'null');
  const primitiveType = (type: string): string => {
    switch (type) {
    case 'string':
      return schema.format === 'binary' ? blobType(inner) : 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': {
      if (Array.isArray(schema.prefixItems)) return prefixItemsType(schema, inner);
      return schema.items === false ? '[]' : arrayType(schemaTypeNode(schema.items, inner));
    }
    case 'object': return objectType(schema, inner);
    case 'null': return 'null';
    default:
      return 'unknown';
    }
  };
  const baseParts = concrete.length
    ? concrete.map((type) => primitiveType(type))
    : nullable
      ? ['null']
    : schema.properties || schema.additionalProperties !== undefined
      ? [objectType(schema, inner)]
      : Array.isArray(schema.prefixItems) || schema.items
        ? [primitiveType('array')]
        : [];
  let result = baseParts.length === 1
    ? baseParts[0]
    : baseParts.map((part) => `(${part})`).join(' | ');
  if (schema.oneOf || schema.anyOf) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
    const union = variants
      .map((item) => `(${schemaTypeNode(item, inner)})`)
      .join(' | ');
    result = result ? `(${result}) & (${union})` : union;
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf
      .map((item) => schemaTypeNode(item, inner))
      .filter((part) => part !== 'unknown');
    if (parts.length) {
      const intersection = parts.map((part) => `(${part})`).join(' & ');
      result = result ? `(${result}) & ${intersection}` : intersection;
    }
  }
  if (!result) result = 'unknown';
  return nullable && result !== 'unknown' && result !== 'null' ? `${result} | null` : result;
}

function objectType(schema: JsonObjectLike, context: SchemaTypeContext): string {
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const properties = objectEntries(schema.properties);
  const propertyTypes = properties.map(([, value]) => schemaTypeNode(value, context));
  const members = properties.map(([name, value]) => {
    const description = isJsonObject(value) && value.description
      ? `  /** ${String(value.description).replace(/\*\//g, '*\\/').replace(/\s+/g, ' ')} */\n`
      : '';
    return `${description}  ${propertyName(name)}${required.has(name) ? '' : '?'}: ${schemaTypeNode(value, context)};`;
  });
  if (schema.additionalProperties) {
    const additionalType = schema.additionalProperties === true
      ? 'unknown'
      : schemaType(schema.additionalProperties, context);
    const optional = properties.some(([name]) => !required.has(name));
    const indexTypes = additionalType === 'unknown'
      ? ['unknown']
      : [...new Set([additionalType, ...propertyTypes, ...(optional ? ['undefined'] : [])])];
    members.push(`  [key: string]: ${indexTypes.join(' | ')};`);
  }
  if (members.length) return `{\n${members.join('\n')}\n}`;
  return schema.additionalProperties === false ? recordType(context, 'never') : recordType(context, 'unknown');
}

type JsonObjectLike = { readonly [key: string]: unknown };

function inputType(operation: NormalizedOperation, context: SchemaTypeContext = {}): string {
  const groups: Record<string, NormalizedOperation['parameters'][number][]> = {
    path: [],
    query: [],
    header: [],
    cookie: [],
  };
  const queryString = operation.parameters.find((parameter) => parameter.in === 'querystring');
  const lines: string[] = [];
  for (const parameter of operation.parameters) {
    if (!groups[parameter.in]) continue;
    groups[parameter.in].push(parameter);
  }
  if (queryString) {
    const schema = parameterSchema(queryString);
    lines.push(`  querystring${queryString.required ? '' : '?'}: ${schemaType(schema, context)};`);
  }
  for (const [location, parameters] of Object.entries(groups)) {
    if (!parameters.length) continue;
    const requiredGroup = location === 'path' || parameters.some((parameter) => parameter.required);
    const fields = parameters.map((parameter) =>
      `    ${propertyName(parameter.name)}${parameter.required || location === 'path' ? '' : '?'}: ${schemaType(parameterSchema(parameter), context)};`
    );
    lines.push(`  ${location}${requiredGroup ? '' : '?'}: {\n${fields.join('\n')}\n  };`);
  }
  if (operation.requestContent.length === 1) {
    lines.push(`  body${operation.requestBody?.required ? '' : '?'}: ${schemaType(operation.requestContent[0]?.schema ?? null, context)};`);
  } else if (operation.requestContent.length > 1) {
    const variants = operation.requestContent.map((media) =>
      `{ contentType: ${JSON.stringify(media.contentType)}; value: ${schemaType(media.schema, context)} }`
    ).join(' | ');
    lines.push(`  body${operation.requestBody?.required ? '' : '?'}: ${variants};`);
  }
  return lines.length ? `{\n${lines.join('\n')}\n}` : recordType(context, 'never');
}

function responseBodyType(response: NormalizedResponse, context: SchemaTypeContext = {}): string {
  if (!response.content || response.content.length === 0) return 'void';
  const types = response.content.map((media) => mediaBodyType(media, context));
  return [...new Set(types)].map((type) => `(${type})`).join(' | ');
}

export function mediaBodyType(media: OpenApiMediaType, context: SchemaTypeContext = {}): string {
  if (media.itemSchemaPresent) {
    return `AsyncIterable<${schemaType(media.itemSchema, context)}>`;
  }
  if (media.schema === null && isBinaryMediaType(media.contentType)) return blobType(context);
  return schemaType(media.schema, context);
}

function operationBodyType(operation: NormalizedOperation, success: boolean, context: SchemaTypeContext = {}): string {
  const responses = operation.responses.filter((response) => response.success === success);
  if (!responses.length) return 'unknown';
  return [...new Set(responses.map((response) => responseBodyType(response, context)))].join(' | ');
}

function responseHeadersType(document: unknown, response: NormalizedResponse, context: SchemaTypeContext = {}): string {
  const members = objectEntries(response.headers).map(([name, rawHeader]) => {
    const header = resolveLocal(document, rawHeader);
    return `readonly ${propertyName(name)}?: ${schemaType(parameterSchema(header), context)}`;
  });
  return members.length ? `{ ${members.join('; ')} }` : recordType(context, 'never');
}

function responseMatchType(status: string): string {
  if (status === 'default') return "'default'";
  if (/^[1-5]XX$/i.test(status)) return "'range'";
  return "'status'";
}

function responseStatusType(status: string): string {
  if (/^\d{3}$/.test(status)) return String(Number(status));
  return 'number';
}

function responseVariantTypes(document: unknown, response: NormalizedResponse, context: SchemaTypeContext = {}): string[] {
  const status = responseStatusType(response.status);
  const matched = responseMatchType(response.status);
  const headers = responseHeadersType(document, response, context);
  if (!response.content || response.content.length === 0) {
    return [`{ matched: ${matched}; status: ${status}; contentType: null; body: void; headers: ${headers} }`];
  }
  return response.content.map((media) => {
    const body = mediaBodyType(media, context);
    return `{ matched: ${matched}; status: ${status}; contentType: ${JSON.stringify(media.contentType)}; body: ${body}; headers: ${headers} }`;
  });
}

export function generateTypes(
  document: unknown,
  operations: readonly NormalizedOperation[],
  plan?: {
    readonly typesUsesInputSchemas: boolean;
    readonly typesUsesOutputSchemas: boolean;
  },
): string {
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const scope = new NameScope('types.ts');
  const useInput = plan ? plan.typesUsesInputSchemas : Object.keys(schemas).length > 0 && operations.length > 0;
  const useOutput = plan ? plan.typesUsesOutputSchemas : Object.keys(schemas).length > 0 && operations.length > 0;
  if (useInput) scope.claim('InputSchemas', 'import binding InputSchemas');
  if (useOutput) scope.claim('OutputSchemas', 'import binding OutputSchemas');
  const recordTypeName = generatedRecordType(scope, [
    ...objectEntries(schemas).map(([name]) => identifier(name)),
    ...operations.flatMap((operation) => [
      `${operation.typeName}OperationInput`,
      `${operation.typeName}OperationSuccessBody`,
      `${operation.typeName}OperationErrorBody`,
      `${operation.typeName}OperationHttpResponse`,
    ]),
  ]);
  const blobTypeName = generatedBlobType(scope, objectEntries(schemas).map(([name]) => identifier(name)));
  const baseContext = schemaContext(document, { recordType: recordTypeName, blobType: blobTypeName });
  const output = [
    generatedBanner(),
    manifestMarker(),
    ...(useInput ? ["import type * as InputSchemas from './input-schemas.js';"] : []),
    ...(useOutput ? ["import type * as OutputSchemas from './output-schemas.js';"] : []),
    '',
  ];
  const recordTypeIndex = output.length;
  for (const [name, rawSchema] of objectEntries(schemas)) {
    const schema = resolveLocal(document, rawSchema);
    const typeName = identifier(name);
    scope.claim(typeName, `component schema ${JSON.stringify(name)}`);
    const type = schemaType(
      schema,
      schemaContext(document, baseContext, name, schema),
    );
    const description = isJsonObject(schema) && schema.description
      ? `/** ${String(schema.description).replace(/\*\//g, '*\\/').replace(/\s+/g, ' ')} */\n`
      : '';
    output.push(`${description}export type ${typeName} = ${type};`, '');
  }
  if (Object.keys(schemas).length === 0 && operations.length === 0) output.push('export {};');
  for (const operation of operations) {
    const inputContext = schemaContext(document, {
      direction: 'input',
      qualifier: useInput ? 'InputSchemas.' : '',
      recordType: recordTypeName,
      blobType: blobTypeName,
    });
    const outputContext = schemaContext(document, {
      direction: 'output',
      qualifier: useOutput ? 'OutputSchemas.' : '',
      recordType: recordTypeName,
      blobType: blobTypeName,
    });
    scope.claim(`${operation.typeName}OperationInput`, `operation ${JSON.stringify(operation.name)} input type`);
    scope.claim(`${operation.typeName}OperationSuccessBody`, `operation ${JSON.stringify(operation.name)} success body`);
    scope.claim(`${operation.typeName}OperationErrorBody`, `operation ${JSON.stringify(operation.name)} error body`);
    scope.claim(`${operation.typeName}OperationHttpResponse`, `operation ${JSON.stringify(operation.name)} http response`);
    output.push(`export type ${operation.typeName}OperationInput = ${inputType(operation, inputContext)};`, '');
    output.push(`export type ${operation.typeName}OperationSuccessBody = ${operationBodyType(operation, true, outputContext)};`, '');
    output.push(`export type ${operation.typeName}OperationErrorBody = ${operationBodyType(operation, false, outputContext)};`, '');
    output.push(
      `export type ${operation.typeName}OperationHttpResponse = ${operation.responses.flatMap((response) => responseVariantTypes(document, response, outputContext)).join(' | ') || 'never'};`,
      '',
    );
  }
  emitRecordType(output, recordTypeIndex, recordTypeName);
  emitBlobType(output, recordTypeIndex, blobTypeName);
  return `${output.join('\n').trim()}\n`;
}

export function generateDirectionalSchemas(document: unknown, direction: 'input' | 'output'): string {
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const scope = new NameScope(`${direction}-schemas.ts`);
  const recordTypeName = generatedRecordType(scope, objectEntries(schemas).map(([name]) => identifier(name)));
  const blobTypeName = generatedBlobType(scope, objectEntries(schemas).map(([name]) => identifier(name)));
  const baseContext = schemaContext(document, { direction, recordType: recordTypeName, blobType: blobTypeName });
  const output = [
    generatedBanner(),
    `/** Component schemas projected for ${direction === 'input' ? 'request' : 'response'} data. */`,
    '',
  ];
  const recordTypeIndex = output.length;
  for (const [name, rawSchema] of objectEntries(schemas)) {
    const schema = resolveLocal(document, rawSchema);
    const typeName = identifier(name);
    scope.claim(typeName, `component schema ${JSON.stringify(name)}`);
    const context = schemaContext(document, baseContext, name, schema);
    output.push(`export type ${typeName} = ${schemaType(schema, context)};`, '');
  }
  if (Object.keys(schemas).length === 0) output.push('export {};');
  emitRecordType(output, recordTypeIndex, recordTypeName);
  emitBlobType(output, recordTypeIndex, blobTypeName);
  return `${output.join('\n').trim()}\n`;
}
