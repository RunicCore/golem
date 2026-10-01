/**
 * Emit specialized JSON stringify/parse functions from a schema graph.
 * Nested nodes compose by call; bodies are never inlined twice. TSerde and
 * Date convert in the same pass as concat / JSON.parse.
 */

import type { ModelTypeDescriptor } from '../model.js';
import type { SchemaGraph, SchemaNode } from './schema-graph.js';
import { codecShortName, serdeWireDescriptor } from './schema-graph.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX, generatedModelShortName, type JsonSchema } from './schema.js';
import {
  AMBIGUOUS_UNION_CONVERSION_ERROR,
  OBJECT_UNION_DISCRIMINATOR_ERROR,
  descriptorNeedsConversion,
  emitScalarOrArrayConversion,
  isScalarishDescriptor,
  discriminatorMatch,
  emitDispatch,
  literalDiscriminator,
  objectDiscriminator,
  objectValueExpression,
  presentUnionIndices,
  presentUnionVariants,
  unionDispatch,
  type DispatchOptions,
  scalarOrArrayItem,
  type ObjectTypeDescriptor,
  type UnionTypeDescriptor,
} from './union-conversion.js';

export interface StringifySerdeResolver {
  readonly deserialize: (id: string, value: string) => string;
  readonly serialize: (id: string, value: string) => string;
}

export interface NestedImportedSerde {
  readonly stringify: string;
  readonly fromWire: string;
  readonly toWire: string;
  /** Direct generated helper for converted anonymous object dependencies. */
  readonly fill?: string;
}

export interface CodecRuntimeOptions {
  readonly validationEnabled?: boolean;
  readonly validationBindingsExpr?: string;
  /** Module-local output from `createValidatorSet` for standalone profiles. */
  readonly validatorSetExpr?: string;
  readonly serde?: StringifySerdeResolver;
  readonly nestedConstruct?: (name: string) => string;
  readonly nestedGenerated?: (id: string) => string;
  readonly nestedImportedSerde?: (id: string) => NestedImportedSerde | undefined;
  /** Internal fill helpers needed by other generated graph modules. */
  readonly exportedFillFunctionIds?: ReadonlySet<string>;
  readonly issueSource?: 'TypeScript' | 'OpenAPI';
  /** Type expression of a local node's emitted JSON type; `toWireFormat${id}` returns it. */
  readonly wireType?: (node: SchemaNode) => string | undefined;
  /** Type expression of a local node's decoded value: parse, fromWireFormat, validate and assert produce it; stringify and toWireFormat accept it. */
  readonly fieldsType?: (node: SchemaNode) => string | undefined;
  /** Codec ids of sibling models that register a separate wire schema (`${id}#wire`). */
  readonly siblingWireCodecIds?: ReadonlySet<string>;
  /** Local codecs whose wire stringify other generated modules import. */
  readonly exportedWireStringifyIds?: ReadonlySet<string>;
  /** Export anonymous codecs' functions: OpenAPI group modules import them from each other. Model companions keep them private. */
  readonly exportAnonymousCodecs?: boolean;
  /** Codecs whose functions stay module-private, such as a model job's derived projections. */
  readonly privateCodec?: (node: SchemaNode) => boolean;
}

interface EmitCtx {
  readonly graph: SchemaGraph;
  readonly validatorSetExpr?: string;
  readonly serde?: StringifySerdeResolver;
  readonly nestedConstruct?: (name: string) => string;
  readonly nestedGenerated?: (id: string) => string;
  readonly nestedImportedSerde?: (id: string) => NestedImportedSerde | undefined;
  readonly exportedFillFunctionIds?: ReadonlySet<string>;
  readonly issueSource: 'TypeScript' | 'OpenAPI';
  readonly wireType?: (node: SchemaNode) => string | undefined;
  readonly fieldsType?: (node: SchemaNode) => string | undefined;
  readonly wireIdentity?: boolean;
  /** Nodes whose `stringify<Id>Wire` function this module emits; wire stringify calls them instead of inlining. */
  readonly wireStringifyIds?: ReadonlySet<string>;
  /** Sibling codecs whose companion exports a wire stringify (`wireStringifyExportName`). */
  readonly siblingWireCodecIds?: ReadonlySet<string>;
  readonly exportedWireStringifyIds?: ReadonlySet<string>;
  readonly exportAnonymousCodecs?: boolean;
  readonly privateCodec?: (node: SchemaNode) => boolean;
  /** Nodes being inlined into the current wire stringify, to reject unbounded expansion. */
  readonly wireInlining?: ReadonlySet<string>;
  readonly inlineLocals?: Set<string>;
}

const TRUSTED = '{ validate: false }';
// Generated modules import these as `type ValidateOptions as __GolemValidateOptions` and
// `type SerdeOptions as __GolemSerdeOptions` from @exprtlabs/golem/serde.
const VALIDATE_OPTIONS = '__GolemValidateOptions';
const SERDE_OPTIONS = '__GolemSerdeOptions';

export function stringifyFunctionName(id: string): string {
  return `stringify${id}`;
}

/**
 * Export name of a codec's wire-JSON stringify. A companion that references
 * the codec as a sibling writes its already encoded wire value with it.
 */
export function wireStringifyExportName(codecId: string): string {
  return `__golemStringifyWire_${codecId.replace(/[^A-Za-z0-9_$]/g, '_')}`;
}

export function fillFunctionName(id: string): string {
  return `fill${id}`;
}

export function parseFunctionName(id: string): string {
  return `parse${id}`;
}

export function fromWireFunctionName(id: string): string {
  return `fromWireFormat${id}`;
}

export function toWireFunctionName(id: string): string {
  return `toWireFormat${id}`;
}

export function validateFunctionName(id: string): string {
  return `validate${id}`;
}

function access(expression: string, name: string): string {
  const record = expression === 'value' || expression === 'wire' || expression === 'record'
    || / as Record<string, unknown>\)$/.test(expression)
    ? expression
    : `(${expression} as Record<string, unknown>)`;
  return `${record}[${JSON.stringify(name)}]`;
}

function emitJsonLiteral(value: unknown): string {
  if (value === null) return "'null'";
  if (value === true) return "'true'";
  if (value === false) return "'false'";
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON literal numbers must be finite.');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(JSON.stringify(value));
  return `stringifyJsonScalar(${JSON.stringify(value)} as never)`;
}

function memberPrefix(name: string, leadingComma: boolean): string {
  return JSON.stringify(`${leadingComma ? ',' : ''}${JSON.stringify(name)}:`);
}

function serdeTags(descriptor: ModelTypeDescriptor): {
  readonly serde?: { readonly id: string };
  readonly date?: true;
} {
  return descriptor as ModelTypeDescriptor & {
    readonly serde?: { readonly id: string };
    readonly date?: true;
  };
}

function isObjectish(descriptor: ModelTypeDescriptor): boolean {
  return descriptor.kind === 'object' || descriptor.kind === 'reference' || descriptor.kind === 'generated-model';
}

function emitRequiredObjectConcat(
  properties: ReadonlyArray<readonly [string, ModelTypeDescriptor]>,
  expression: string,
  ctx: EmitCtx,
): string {
  const chunks = properties.map(([name, property], index) => emitInlineObjectField(
    name,
    property,
    true,
    expression,
    index,
    index > 0,
    ctx,
  ));
  return `${chunks.join(' + ')} + '}'`;
}

function occurrenceCount(source: string, value: string): number {
  if (value.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const next = source.indexOf(value, from);
    if (next < 0) return count;
    count++;
    from = next + value.length;
  }
}

function emitInlineObjectField(
  name: string,
  property: ModelTypeDescriptor,
  required: boolean,
  expression: string,
  index: number,
  leadingComma: boolean,
  ctx: EmitCtx,
): string {
  const read = access(expression, name);
  const value = emitValue(property, read, ctx);
  const repeated = occurrenceCount(value, read) + (required ? 0 : 1) > 1;
  if (!repeated) {
    const member = `${memberPrefix(name, leadingComma)} + ${value}`;
    return required ? member : `(${read} !== undefined ? ${member} : '')`;
  }
  const local = `__golemInlineField${ctx.inlineLocals?.size ?? index}`;
  ctx.inlineLocals?.add(local);
  const converted = value.replaceAll(read, local);
  const member = `${memberPrefix(name, leadingComma)} + ${converted}`;
  return required
    ? `(${local} = ${read}, ${member})`
    : `(${local} = ${read}, (${local} !== undefined ? ${member} : ''))`;
}

function inlineLocalDeclarations(ctx: EmitCtx): string[] {
  return [...(ctx.inlineLocals ?? [])].map((name) => `  let ${name}: unknown;`);
}

function emitValue(
  descriptor: ModelTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  if (descriptor.kind === 'generated-model') {
    const named = ctx.graph.nodeFor(descriptor);
    if (named) {
      return `${stringifyFunctionName(named.id)}(${expression} as never, ${TRUSTED})`;
    }
    return `stringifyJsonScalar(encodeGeneratedModel(${expression}) as never)`;
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    const wire = serdeWireDescriptor(descriptor) ?? { kind: 'unknown' as const };
    if (ctx.wireIdentity) return emitValue(wire, expression, ctx);
    const serialized = ctx.serde
      ? ctx.serde.serialize(tags.serde.id, expression)
      : expression;
    return emitValue(wire, serialized, ctx);
  }
  const named = ctx.graph.nodeFor(descriptor);
  if (named?.siblingCodec && ctx.wireIdentity) {
    // An encoded wire value of a sibling codec: its companion's wire stringify writes it.
    return ctx.siblingWireCodecIds?.has(named.codecId)
      ? `${wireStringifyExportName(named.codecId)}(${expression} as never)`
      : `stringify${named.id}(${expression} as never, ${TRUSTED})`;
  }
  if (named && isObjectish(descriptor)) {
    if (
      ctx.wireIdentity
      && named.descriptor.kind === 'object'
      && (descriptorNeedsConversion(named.descriptor) || !named.sameSchema)
    ) {
      // Call the node's own wire stringify: inlining would repeat the child for
      // every path to it and never terminate for a recursive model.
      if (ctx.wireStringifyIds?.has(named.id)) return `${stringifyFunctionName(named.id)}Wire(${expression} as never)`;
      if (ctx.wireInlining?.has(named.id)) {
        throw new Error(`Recursive model ${named.name} has no wire stringify function to call; enable validation for it.`);
      }
      return emitObjectInline(named.descriptor, expression, { ...ctx, wireInlining: new Set([...(ctx.wireInlining ?? []), named.id]) });
    }
    return `${stringifyFunctionName(named.id)}(${expression} as never, ${TRUSTED})`;
  }
  if (descriptor.kind === 'date' || tags.date) {
    if (ctx.wireIdentity) return `stringifyJsonString(${expression} as string)`;
    return `stringifyJsonString(serializeDate(${expression}))`;
  }
  if (descriptor.kind === 'string') return `stringifyJsonString(${expression} as string)`;
  if (descriptor.kind === 'number') return `stringifyJsonNumber(${expression} as number)`;
  if (descriptor.kind === 'boolean') return `stringifyJsonBoolean(${expression} as boolean)`;
  if (descriptor.kind === 'null') return "'null'";
  if (descriptor.kind === 'literal') return emitJsonLiteral(descriptor.value);
  if (descriptor.kind === 'array') {
    const itemNode = ctx.graph.nodeFor(descriptor.item);
    const item = itemNode && isObjectish(descriptor.item) && !ctx.wireIdentity
      ? `${stringifyFunctionName(itemNode.id)}(item as never, ${TRUSTED})`
      : emitValue(descriptor.item, 'item', ctx);
    return `stringifyJsonArray(${expression} as ArrayLike<unknown>, (item) => ${item})`;
  }
  if (descriptor.kind === 'tuple') {
    const item = emitTupleItem(descriptor, item => emitValue(item, '_item', ctx), 'stringifyJsonScalar(_item as never)');
    return `(Array.isArray(${expression}) ? ((_tuple: readonly unknown[]) => stringifyJsonArray(_tuple, (_item, _index) => ${item}))(${expression} as readonly unknown[]) : stringifyJsonScalar(${expression} as never))`;
  }
  if (descriptor.kind === 'union') {
    const present = presentUnionVariants(descriptor);
    if (present.length === 1 && present.length !== descriptor.variants.length) {
      const converted = emitValue(present[0], expression, ctx);
      return `(${expression} == null ? 'null' : (${converted}))`;
    }
    const array = scalarOrArrayItem(present);
    if (array) {
      const item = emitValue(array.item, 'item', ctx);
      const scalar = emitValue(array.item, expression, ctx);
      if (
        item === 'stringifyJsonScalar(item as never)'
        && scalar === `stringifyJsonScalar(${expression} as never)`
      ) {
        return `stringifyJsonScalar(${expression} as never)`;
      }
      return `(Array.isArray(${expression}) ? stringifyJsonArray(${expression} as ArrayLike<unknown>, (item) => ${item}) : (${scalar}))`;
    }
    const tagged = emitTaggedVariantUnion(
      descriptor,
      presentUnionIndices(descriptor),
      expression,
      ctx,
      (variant) => {
        if (!ctx.wireIdentity) {
          const node = ctx.graph.nodeFor(variant);
          if (node && isObjectish(variant)) {
            return `${stringifyFunctionName(node.id)}(${expression} as never, ${TRUSTED})`;
          }
        }
        return emitValue(variant, expression, ctx);
      },
      'encode-json',
      { unresolved: 'skip' },
    );
    if (tagged !== undefined) return tagged;
    const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
    if (objects.length > 1) {
      const structured = objects.some((object) => {
        const node = ctx.graph.nodeFor(object);
        return Boolean(node) || Object.keys(object.properties).length > 0 || object.additionalProperties === false;
      });
      if (structured) throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
    }
    if (present.every(isScalarishDescriptor)) {
      return `stringifyJsonScalar(${expression} as never)`;
    }
    const generated = present.filter((variant): variant is Extract<ModelTypeDescriptor, { kind: 'generated-model' }> =>
      variant.kind === 'generated-model');
    if (generated.length === 1) {
      const generatedText = emitValue(generated[0], expression, ctx);
      const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
      if (objects.length > 0 && !objectDiscriminator(objects)) throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
      const tagged = objectTagMatch(objects, expression);
      if (tagged.length) {
        const objectText = objects.length === 1
          ? emitValue(objects[0], expression, ctx)
          : emitTaggedObjects(descriptor, expression, ctx, (object) => emitValue(object, expression, ctx), 'encode-json');
        return `(${objectValueExpression(expression)} && !(${tagged.join(' || ')}) ? ${generatedText} : ${objectText})`;
      }
      if (present.every((variant) => variant === generated[0] || isScalarishDescriptor(variant))) {
        return `(${objectValueExpression(expression)} ? ${generatedText} : stringifyJsonScalar(${expression} as never))`;
      }
    }
    const objectsOrModels = present.filter((variant) =>
      variant.kind === 'object' || variant.kind === 'reference' || variant.kind === 'generated-model');
    if (
      objectsOrModels.length === 1
      && present.every((variant) => variant === objectsOrModels[0] || isScalarishDescriptor(variant))
    ) {
      const converted = emitValue(objectsOrModels[0], expression, ctx);
      return `(${objectValueExpression(expression)} ? ${converted} : stringifyJsonScalar(${expression} as never))`;
    }
    const conversions = present.map((variant) => emitValue(variant, expression, ctx));
    if (conversions.every((converted) => converted === `stringifyJsonScalar(${expression} as never)`)) {
      return `stringifyJsonScalar(${expression} as never)`;
    }
    throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return `${stringifyFunctionName(node.id)}(${expression} as never, ${TRUSTED})`;
    return emitObjectInline(descriptor, expression, ctx);
  }
  return `stringifyJsonScalar(${expression} as never)`;
}

/** Select a tuple element by its actual position, including a variable-length rest. */
function emitTupleItem(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'tuple' }>,
  emit: (item: ModelTypeDescriptor) => string,
  fallback = '_item',
): string {
  const rest = descriptor.rest;
  const suffixLength = rest ? descriptor.items.length - rest.index : 0;
  let value = rest ? emit(rest.item) : fallback;
  for (let index = descriptor.items.length - 1; index >= 0; index--) {
    const position = rest && index >= rest.index
      ? `Math.max(${rest.index}, _tuple.length - ${suffixLength}) + ${index - rest.index}`
      : String(index);
    value = `(_index === ${position} ? ${emit(descriptor.items[index])} : ${value})`;
  }
  return value;
}

function emitObjectInline(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
  ctx: EmitCtx,
): string {
  const required = new Set(descriptor.required);
  const properties = Object.entries(descriptor.properties);
  if (properties.length === 0) {
    if (descriptor.additionalProperties === false) return "'{}'";
    return `stringifyJsonScalar(${expression} as never)`;
  }
  if (properties.every(([name]) => required.has(name))) {
    return `'{' + ${emitRequiredObjectConcat(properties, expression, ctx)}`;
  }
  const parts = properties.map(([name, property], index) => emitInlineObjectField(
    name,
    property,
    required.has(name),
    expression,
    index,
    false,
    ctx,
  ));
  return `'{' + [${parts.join(', ')}].filter(Boolean).join(',') + '}'`;
}

function emitObjectStringify(
  fn: string,
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  ctx: EmitCtx,
): string {
  const required = new Set(descriptor.required);
  const properties = Object.entries(descriptor.properties);
  if (properties.length === 0) {
    if (descriptor.additionalProperties === false) {
      return `function ${fn}(_value: Record<string, unknown>, _options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {\n  return '{}';\n}\n`;
    }
    return `function ${fn}(value: Record<string, unknown>, _options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {\n  return stringifyJsonScalar(value as never);\n}\n`;
  }
  if (properties.every(([name]) => required.has(name))) {
    const concatenated = emitRequiredObjectConcat(properties, 'value', ctx);
    return [
      `function ${fn}(value: Record<string, unknown>, _options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {`,
      ...inlineLocalDeclarations(ctx),
      `  return '{' + ${concatenated};`,
      '}',
      '',
    ].join('\n');
  }
  const lines: string[] = [
    `function ${fn}(value: Record<string, unknown>, _options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {`,
    "  let out = '{';",
    '  let sep = false;',
  ];
  for (const [index, [name, property]] of properties.entries()) {
    const read = access('value', name);
    const value = emitValue(property, read, ctx);
    const local = `__golemField${index}`;
    const needsSnapshot = occurrenceCount(value, read) + (required.has(name) ? 0 : 1) > 1;
    const valueExpr = needsSnapshot ? value.replaceAll(read, local) : value;
    const fieldExpr = needsSnapshot ? local : read;
    const key = JSON.stringify(`${JSON.stringify(name)}:`);
    if (needsSnapshot) lines.push(`  const ${local} = ${read};`);
    if (required.has(name)) {
      lines.push(
        '  if (sep) out += ",";',
        `  out += ${key};`,
        `  out += ${valueExpr};`,
        '  sep = true;',
      );
    } else {
      lines.push(
        `  if (${fieldExpr} !== undefined) {`,
        '    if (sep) out += ",";',
        `    out += ${key};`,
        `    out += ${valueExpr};`,
        '    sep = true;',
        '  }',
      );
    }
  }
  lines.splice(1, 0, ...inlineLocalDeclarations(ctx));
  lines.push("  return out + '}';", '}', '');
  return lines.join('\n');
}

export function emitStringifyFunction(
  node: SchemaNode,
  graph: SchemaGraph,
  serde?: StringifySerdeResolver,
  extra?: Partial<EmitCtx>,
): string {
  const ctx: EmitCtx = {
    graph,
    serde,
    nestedConstruct: extra?.nestedConstruct,
    nestedGenerated: extra?.nestedGenerated,
    nestedImportedSerde: extra?.nestedImportedSerde,
    issueSource: extra?.issueSource ?? 'TypeScript',
    wireIdentity: extra?.wireIdentity,
    wireStringifyIds: extra?.wireStringifyIds,
    siblingWireCodecIds: extra?.siblingWireCodecIds,
    wireInlining: extra?.wireIdentity ? new Set([node.id]) : undefined,
    inlineLocals: new Set(),
  };
  const fn = stringifyFunctionName(node.id);
  let source: string;
  if (node.descriptor.kind === 'object') source = emitObjectStringify(fn, node.descriptor, ctx);
  else if (node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference') {
    source = `function ${fn}(value: unknown, options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {\n  return requireObjectCodec(${JSON.stringify(node.codecId)}).stringify(value as never, options);\n}\n`;
  } else {
    const value = emitValue(node.descriptor, '(value as never)', ctx);
    source = [
      `function ${fn}(value: unknown, _options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {`,
      ...inlineLocalDeclarations(ctx),
      `  return ${value};`,
      '}',
      '',
    ].join('\n');
  }
  return source;
}

export function emitParseFunction(node: SchemaNode): string {
  const parse = parseFunctionName(node.id);
  const fromWire = fromWireFunctionName(node.id);
  return `function ${parse}(text: string, options?: ${SERDE_OPTIONS}): unknown {\n  return ${fromWire}(parseJson(text), options);\n}\n`;
}

export function emitGraphStringify(graph: SchemaGraph, serde?: StringifySerdeResolver): string {
  return graph.topo().map((node) => emitStringifyFunction(node, graph, serde)).join('\n');
}

function asRecord(expression: string): string {
  return `(${expression} as Record<string, unknown>)`;
}

function shouldConstructNested(descriptor: ModelTypeDescriptor, ctx: EmitCtx): boolean {
  const node = ctx.graph.nodeFor(descriptor);
  return (descriptor.kind === 'reference' && descriptor.construct === true)
    || (descriptor.kind === 'generated-model' && node?.emitClass === true);
}

function nestedFromWireOptions(descriptor: ModelTypeDescriptor, ctx: EmitCtx): string {
  if (!shouldConstructNested(descriptor, ctx)) return TRUSTED;
  const node = ctx.graph.nodeFor(descriptor);
  const id = node?.codecId
    ?? (descriptor.kind === 'reference' ? descriptor.name : descriptor.kind === 'generated-model' ? descriptor.id : undefined);
  if (!id) return TRUSTED;
  const ctor = ctx.nestedConstruct?.(id) ?? `requireIModelClass(${JSON.stringify(id)})`;
  return `{ validate: false, construct: ${ctor} }`;
}

function extrasAllowed(descriptor: ModelTypeDescriptor): boolean {
  return descriptor.kind !== 'object' || descriptor.additionalProperties !== false;
}

function emitClosedIdentityObject(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
): string | undefined {
  const required = new Set(descriptor.required);
  const names = Object.keys(descriptor.properties);
  if (names.length === 0) return undefined;
  if (names.some((name) => name === '__proto__' || !required.has(name))) return undefined;
  return `(${emitComputedRecord(names.map((name) => [name, access(expression, name)]))})`;
}

function emitInternedObjectDecode(
  node: SchemaNode,
  descriptor: ModelTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  if (shouldConstructNested(descriptor, ctx)) {
    // Nested values belong to input the outermost call already isolated, so a
    // model emitted in this module converts them without copying again.
    const local = !isExternalCodecNode(node) && !(ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id));
    return local
      ? `convertFromWire${node.id}(${expression}, ${nestedFromWireOptions(descriptor, ctx)}, true)`
      : `${fromWireFunctionName(node.id)}(${expression}, ${nestedFromWireOptions(descriptor, ctx)})`;
  }
  if (
    node.kind === 'object'
    && node.descriptor.kind === 'object'
    && !descriptorNeedsConversion(node.descriptor)
  ) {
    if (extrasAllowed(node.descriptor)) return expression;
    const closed = emitClosedIdentityObject(node.descriptor, expression);
    if (closed) return closed;
  }
  if (node.kind === 'object') {
    const imported = ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id);
    return `${imported?.fill ?? fillFunctionName(node.id)}({} as Record<string, unknown>, ${asRecord(expression)})`;
  }
  return `${fromWireFunctionName(node.id)}(${expression}, ${TRUSTED})`;
}

function mergeResolvedObjects(
  parts: readonly (ObjectTypeDescriptor | undefined)[],
): ObjectTypeDescriptor | undefined {
  const objects = parts.filter((part): part is ObjectTypeDescriptor => part !== undefined);
  if (objects.length === 0) return undefined;
  if (objects.length === 1) return objects[0];
  const properties: Record<string, ModelTypeDescriptor> = {};
  const required: string[] = [];
  let additionalProperties: ObjectTypeDescriptor['additionalProperties'] = true;
  for (const object of objects) {
    Object.assign(properties, object.properties);
    required.push(...object.required);
    additionalProperties = object.additionalProperties;
  }
  return {
    kind: 'object',
    properties,
    required: [...new Set(required)],
    additionalProperties,
  };
}

function resolveObjectDescriptor(
  descriptor: ModelTypeDescriptor,
  ctx: EmitCtx,
): ObjectTypeDescriptor | undefined {
  if (descriptor.kind === 'object') return descriptor;
  if (descriptor.kind === 'intersection') {
    return mergeResolvedObjects(descriptor.variants.map((variant) => resolveObjectDescriptor(variant, ctx)));
  }
  const short = descriptor.kind === 'generated-model'
    ? codecShortName(descriptor.id)
    : descriptor.kind === 'reference'
      ? codecShortName(descriptor.name)
      : undefined;
  const node = ctx.graph.nodeFor(descriptor)
    ?? (short ? ctx.graph.nodeFor(descriptor, short) : undefined);
  if (node?.descriptor && node.descriptor !== descriptor) {
    if (node.descriptor.kind === 'object') return node.descriptor;
    if (node.descriptor.kind === 'intersection') return resolveObjectDescriptor(node.descriptor, ctx);
  }
  const hashedBase = short && /_[0-9a-f]{8}$/i.test(short) ? short.replace(/_[0-9a-f]{8}$/i, '') : undefined;
  const ids = new Set(
    [
      descriptor.kind === 'generated-model' ? descriptor.id : undefined,
      descriptor.kind === 'reference' ? descriptor.name : undefined,
      short,
      hashedBase,
      node?.codecId,
      node?.name,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  for (const candidate of ctx.graph.nodes.values()) {
    if (!ids.has(candidate.codecId) && !ids.has(candidate.name) && !ids.has(candidate.id)) continue;
    if (candidate.descriptor.kind === 'object') return candidate.descriptor;
    if (candidate.descriptor.kind === 'intersection') return resolveObjectDescriptor(candidate.descriptor, ctx);
  }
  return undefined;
}

function tagAccess(expression: string, property: string): string {
  return `((${expression}) as Record<string, unknown>)[${JSON.stringify(property)}]`;
}

/**
 * Dispatch the union variants at `indices` by tag (and by class for a
 * generated model instance). Returns undefined when the variants carry no
 * inferable tag and `unresolved` is 'skip'.
 */
function emitTaggedVariantUnion(
  union: UnionTypeDescriptor,
  indices: readonly number[],
  expression: string,
  ctx: EmitCtx,
  convert: (variant: ModelTypeDescriptor) => string,
  direction: DispatchOptions['direction'],
  options?: { readonly unresolved?: 'throw' | 'skip' },
): string | undefined {
  const variants = indices.map((index) => union.variants[index]);
  const objectFor = (variant: ModelTypeDescriptor) => resolveObjectDescriptor(variant, ctx);
  if (variants.length === 0 || (!union.discriminator && variants.some((variant) => !objectFor(variant)))) return undefined;
  const dispatch = unionDispatch(union, indices, objectFor);
  const conversions = variants.map((variant) => convert(variant));
  if (!dispatch) {
    if (direction !== 'encode-json' && conversions.every((converted) => converted === expression)) return expression;
    if (options?.unresolved === 'skip') return undefined;
    throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
  }
  return emitDispatch({
    expression,
    property: dispatch.property,
    direction,
    nullish: direction === 'encode-json' ? "'null'" : undefined,
    canonicalTag: union.discriminator !== undefined,
    branches: variants.map((variant, position) => ({
      values: dispatch.values[position],
      className: variantClassName(variant, ctx),
      convert: conversions[position],
      writesTag: (() => {
        const object = objectFor(variant);
        return object ? object.properties[dispatch.property] !== undefined : undefined;
      })(),
    })),
  });
}

/**
 * The class expression of a variant whose values are model instances: a
 * generated model, or a reference the codec constructs. Only a class the
 * emitting module binds is used, so a guard never looks up a registry.
 */
function variantClassName(variant: ModelTypeDescriptor, ctx: EmitCtx): string | undefined {
  const name = variant.kind === 'generated-model'
    ? ctx.nestedGenerated?.(variant.id)
    : variant.kind === 'reference' && shouldConstructNested(variant, ctx)
      ? ctx.nestedConstruct?.(ctx.graph.nodeFor(variant)?.codecId ?? variant.name)
      : undefined;
  // A resolver answers 'undefined' for a model it emits no class for.
  return name === 'undefined' ? undefined : name;
}

/** Object variants of a union mixed with one generated model; their literal tags must dispatch. */
function emitTaggedObjects(
  union: UnionTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
  convert: (variant: ModelTypeDescriptor) => string,
  direction: DispatchOptions['direction'],
): string {
  const indices = presentUnionIndices(union).filter((index) => union.variants[index].kind === 'object');
  const converted = emitTaggedVariantUnion(union, indices, expression, ctx, convert, direction);
  if (converted === undefined) throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
  return converted;
}

/** Match any required literal tag of `objects`, for mixing them with one generated model. */
function objectTagMatch(objects: readonly ObjectTypeDescriptor[], expression: string): string[] {
  return objects.flatMap((object) => [...literalDiscriminator(object)].map(([name, values]) =>
    discriminatorMatch(tagAccess(expression, name), values)));
}

function emitUnionDecode(
  descriptor: UnionTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  const present = presentUnionVariants(descriptor);
  if (present.length === 1 && present.length !== descriptor.variants.length) {
    const converted = emitDecodeValue(present[0], expression, ctx);
    return converted === expression ? expression : `${expression} == null ? ${expression} : (${converted})`;
  }
  const array = scalarOrArrayItem(present);
  if (array) {
    const item = emitDecodeValue(array.item, 'item', ctx);
    const scalar = emitDecodeValue(array.item, expression, ctx);
    const mapped = item === 'item'
      ? expression
      : `(${expression} as readonly unknown[]).map((item) => ${item})`;
    return emitScalarOrArrayConversion(expression, mapped, scalar);
  }
  const tagged = emitTaggedVariantUnion(
    descriptor,
    presentUnionIndices(descriptor),
    expression,
    ctx,
    (variant) => emitDecodeValue(variant, expression, ctx),
    'decode',
  );
  if (tagged !== undefined) return tagged;
  const generated = present.filter((variant): variant is Extract<ModelTypeDescriptor, { kind: 'generated-model' }> =>
    variant.kind === 'generated-model');
  if (generated.length === 1) {
    const className = ctx.nestedGenerated?.(generated[0].id);
    if (className) {
      const converted = `${expression} instanceof ${className} ? ${expression} : decodeGeneratedModelTrusted(${className}, ${expression})`;
      const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
      const discriminator = objectDiscriminator(objects);
      if (objects.length > 0 && !discriminator) throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
      const tagged = objectTagMatch(objects, expression);
      if (tagged.length) {
        return `(${objectValueExpression(expression)} && !(${tagged.join(' || ')}) ? ${converted} : ${expression})`;
      }
      return `(${objectValueExpression(expression)} ? ${converted} : ${expression})`;
    }
  }
  const refs = present.filter((variant): variant is Extract<ModelTypeDescriptor, { kind: 'reference' }> =>
    variant.kind === 'reference' && variant.construct === true);
  if (refs.length > 0 && refs.length === present.length) {
    const branches: string[] = [];
    for (const ref of refs) {
      const node = ctx.graph.nodeFor(ref);
      const object = node?.descriptor.kind === 'object' ? node.descriptor : undefined;
      if (!object) throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
      const tags = objectTagMatch([object], expression);
      if (tags.length === 0) throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
      branches.push(`${tags.join(' && ')} ? ${emitDecodeValue(ref, expression, ctx)}`);
    }
    return `(${objectValueExpression(expression)} ? ${[...branches, expression].join(' : ')} : ${expression})`;
  }
  const conversions = present.map((variant) => emitDecodeValue(variant, expression, ctx));
  if (conversions.every((converted) => converted === expression)) return expression;
  const objectsOrModels = present.filter((variant) =>
    variant.kind === 'object' || variant.kind === 'reference' || variant.kind === 'generated-model');
  if (
    objectsOrModels.length === 1
    && present.every((variant) =>
      variant === objectsOrModels[0]
      || ['string', 'number', 'boolean', 'bigint', 'literal'].includes(variant.kind))
  ) {
    const converted = emitDecodeValue(objectsOrModels[0], expression, ctx);
    return `${objectValueExpression(expression)} ? (${converted}) : ${expression}`;
  }
  if (!descriptorNeedsConversion(descriptor)) return expression;
  throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
}

function emitUnionEncode(
  descriptor: UnionTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  const present = presentUnionVariants(descriptor);
  if (present.length === 1 && present.length !== descriptor.variants.length) {
    const converted = emitEncodeValue(present[0], expression, ctx);
    return converted === expression ? expression : `${expression} == null ? ${expression} : (${converted})`;
  }
  const array = scalarOrArrayItem(present);
  if (array) {
    const item = emitEncodeValue(array.item, 'item', ctx);
    const scalar = emitEncodeValue(array.item, expression, ctx);
    const mapped = item === 'item'
      ? expression
      : `(${expression} as readonly unknown[]).map((item) => ${item})`;
    return emitScalarOrArrayConversion(expression, mapped, scalar);
  }
  const tagged = emitTaggedVariantUnion(
    descriptor,
    presentUnionIndices(descriptor),
    expression,
    ctx,
    (variant) => emitEncodeValue(variant, expression, ctx),
    'encode-value',
    { unresolved: 'skip' },
  );
  if (tagged !== undefined) return tagged;
  const generated = present.filter((variant): variant is Extract<ModelTypeDescriptor, { kind: 'generated-model' }> =>
    variant.kind === 'generated-model');
  if (generated.length === 1) {
    const generatedText = emitEncodeValue(generated[0], expression, ctx);
    const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
    if (objects.length > 0 && !objectDiscriminator(objects)) throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
    const taggedObjects = objectTagMatch(objects, expression);
    if (taggedObjects.length) {
      const objectText = objects.length === 1
        ? emitEncodeValue(objects[0], expression, ctx)
        : emitTaggedObjects(descriptor, expression, ctx, (object) => emitEncodeValue(object, expression, ctx), 'encode-value');
      return `(${objectValueExpression(expression)} && !(${taggedObjects.join(' || ')}) ? ${generatedText} : ${objectText})`;
    }
    if (present.every((variant) => variant === generated[0] || isScalarishDescriptor(variant))) {
      return `(${objectValueExpression(expression)} ? ${generatedText} : ${expression})`;
    }
  }
  const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
  if (objects.length === present.length && objects.some(descriptorNeedsConversion)) {
    throw new Error(OBJECT_UNION_DISCRIMINATOR_ERROR);
  }
  const conversions = present.map((variant) => emitEncodeValue(variant, expression, ctx));
  if (conversions.every((converted) => converted === expression)) return expression;
  const objectsOrModels = present.filter((variant) =>
    variant.kind === 'object' || variant.kind === 'reference' || variant.kind === 'generated-model');
  if (
    objectsOrModels.length === 1
    && present.every((variant) =>
      variant === objectsOrModels[0]
      || ['string', 'number', 'boolean', 'bigint', 'literal'].includes(variant.kind))
  ) {
    const converted = emitEncodeValue(objectsOrModels[0], expression, ctx);
    return `${objectValueExpression(expression)} ? (${converted}) : ${expression}`;
  }
  if (!descriptorNeedsConversion(descriptor)) return expression;
  throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
}

function emitDecodeValue(descriptor: ModelTypeDescriptor, expression: string, ctx: EmitCtx): string {
  if (descriptor.kind === 'generated-model') {
    const className = ctx.nestedGenerated?.(descriptor.id);
    if (className) return `decodeGeneratedModelTrusted(${className}, ${expression})`;
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    const deserialized = ctx.serde ? ctx.serde.deserialize(tags.serde.id, expression) : expression;
    const wire = serdeWireDescriptor(descriptor);
    if (wire?.kind === 'string') {
      return `(typeof ${expression} === 'string' ? ${deserialized} : ${expression})`;
    }
    if (wire?.kind === 'number') {
      return `(typeof ${expression} === 'number' ? ${expression} : ${deserialized})`;
    }
    if (wire?.kind === 'boolean') {
      return `(typeof ${expression} === 'boolean' ? ${expression} : ${deserialized})`;
    }
    if (wire && (wire.kind === 'object' || wire.kind === 'reference' || wire.kind === 'generated-model')) {
      return `(${objectValueExpression(expression)} ? ${deserialized} : ${expression})`;
    }
    return deserialized;
  }
  if (descriptor.kind === 'date' || tags.date) {
    return `(${expression} instanceof Date ? ${expression} : deserializeDate(${expression}))`;
  }
  if (descriptor.kind === 'union') {
    return emitUnionDecode(descriptor, expression, ctx);
  }
  if (descriptor.kind === 'object' && typeof descriptor.additionalProperties === 'object') {
    if (!descriptorNeedsConversion(descriptor)) {
      const named = ctx.graph.nodeFor(descriptor);
      if (named) return emitInternedObjectDecode(named, descriptor, expression, ctx);
      return expression;
    }
    const decoded = emitDecodeValue(descriptor.additionalProperties, 'value', ctx);
    return `Object.fromEntries(Object.entries((${expression} ?? {}) as Record<string, unknown>).map(([key, value]) => [key, ${decoded}]))`;
  }
  const named = ctx.graph.nodeFor(descriptor);
  if (named && isObjectish(descriptor)) {
    return emitInternedObjectDecode(named, descriptor, expression, ctx);
  }
  if (descriptor.kind === 'array') {
    const item = emitDecodeValue(descriptor.item, 'item', ctx);
    return `Array.isArray(${expression}) ? ${emitArrayCopy(expression, item)} : ${expression}`;
  }
  if (descriptor.kind === 'tuple') {
    const item = emitTupleItem(descriptor, item => emitDecodeValue(item, '_item', ctx));
    return `Array.isArray(${expression}) ? (${expression} as readonly unknown[]).map((_item, _index, _tuple) => ${item}) : ${expression}`;
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return emitInternedObjectDecode(node, descriptor, expression, ctx);
    return emitDecodedRecord(descriptor, expression, ctx);
  }
  return expression;
}

/** A new array of `expression` whose items are `item`; an unchanged item is copied without a callback. */
function emitArrayCopy(expression: string, item: string): string {
  const array = `(${expression} as readonly unknown[])`;
  return item === 'item' ? `${array}.slice()` : `${array}.map((item) => ${item})`;
}

function emitComputedRecord(fields: readonly (readonly [string, string])[]): string {
  if (fields.length === 0) return '{}';
  return `{ ${fields.map(([name, value]) => `[${JSON.stringify(name)}]: ${value}`).join(', ')} }`;
}

function emitDecodedRecord(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
  ctx: EmitCtx,
): string {
  const fields = Object.entries(descriptor.properties);
  if (fields.length === 0) return expression;
  return emitComputedRecord(fields.map(([name, property]) => [
    name,
    emitDecodeValue(property, access(expression, name), ctx),
  ]));
}

function emitFillPropertyWrite(name: string, decoded: string, indent = '    '): string {
  if (name === '__proto__') {
    return `${indent}defineModelProperty(out, ${JSON.stringify(name)}, ${decoded});`;
  }
  return `${indent}out[${JSON.stringify(name)}] = ${decoded};`;
}

function emitFillFunction(
  node: SchemaNode,
  ctx: EmitCtx,
  descriptor: ModelTypeDescriptor = node.descriptor,
): { readonly source: string; readonly copyIdentity: boolean; readonly hasConvertedWrites: boolean } {
  const fn = fillFunctionName(node.id);
  const exported = ctx.exportedFillFunctionIds?.has(node.id) ? 'export ' : '';
  if (descriptor.kind !== 'object') {
    return {
      source: `${exported}function ${fn}(out: Record<string, unknown>, _wire: Record<string, unknown>): Record<string, unknown> {\n  return out;\n}\n`,
      copyIdentity: false,
      hasConvertedWrites: false,
    };
  }
  const properties = Object.entries(descriptor.properties);
  const additional = typeof descriptor.additionalProperties === 'object'
    ? descriptor.additionalProperties
    : undefined;
  const additionalConstraint = descriptor.constraints?.find((constraint) => constraint.kind === 'additionalProperties');
  const additionalSchema = additional
    ?? (additionalConstraint && additionalConstraint.kind === 'additionalProperties'
      && additionalConstraint.schema !== false
      && !(typeof additionalConstraint.schema === 'object'
        && additionalConstraint.schema !== null
        && 'kind' in additionalConstraint.schema
        && (additionalConstraint.schema.kind === 'never' || additionalConstraint.schema.kind === 'undefined'))
      ? additionalConstraint.schema
      : undefined);
  const patternConstraints = (descriptor.constraints ?? []).filter(
    (constraint) => constraint.kind === 'patternProperties',
  );
  if (properties.length === 0 && !additionalSchema && patternConstraints.length === 0) {
    return {
      source: `${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {\n  return Object.assign(out, wire);\n}\n`,
      copyIdentity: false,
      hasConvertedWrites: false,
    };
  }
  const required = new Set(descriptor.required);
  const identityWrites: string[] = [];
  const propertyWrites: string[] = [];
  let copyIdentity = false;
  let hasConvertedWrites = false;
  for (const [name, property] of properties) {
    const identity = access('wire', name);
    const decoded = emitDecodeValue(property, identity, ctx);
    const converted = name === '__proto__' || decoded !== identity;
    if (converted) hasConvertedWrites = true;
    else copyIdentity = true;
    if (!converted && required.has(name) && name !== '__proto__') {
      identityWrites.push(emitFillPropertyWrite(name, decoded));
      continue;
    }
    if (!converted) {
      identityWrites.push(
        `    if (Object.prototype.hasOwnProperty.call(wire, ${JSON.stringify(name)})) {`,
        emitFillPropertyWrite(name, decoded, '      '),
        '    }',
      );
      continue;
    }
    propertyWrites.push(
      `  if (Object.prototype.hasOwnProperty.call(wire, ${JSON.stringify(name)})) {`,
      emitFillPropertyWrite(name, decoded),
      '  }',
    );
  }
  const declaration = copyIdentity
    ? `${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>, copyIdentity = true): Record<string, unknown> {`
    : `${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {`;
  const lines: string[] = [
    declaration,
    ...(identityWrites.length > 0
      ? ['  if (copyIdentity) {', ...identityWrites, '  }']
      : []),
    ...propertyWrites,
  ];
  if (additionalSchema || patternConstraints.length > 0) {
    const known = properties.map(([name]) => JSON.stringify(name)).join(', ');
    lines.push(
      `  for (const key of Object.keys(wire)) {`,
      `    if (${known ? `[${known}].includes(key)` : 'false'}) continue;`,
    );
    for (const pattern of patternConstraints) {
      if (pattern.kind !== 'patternProperties') continue;
      const schema = typeof pattern.schema === 'object' && pattern.schema !== null && 'kind' in pattern.schema
        ? pattern.schema
        : undefined;
      const decoded = schema ? emitDecodeValue(schema as never, 'wire[key]', ctx) : 'wire[key]';
      if (decoded !== 'wire[key]') hasConvertedWrites = true;
      lines.push(
        `    if (new RegExp(${JSON.stringify(pattern.pattern)}).test(key)) {`,
        `      defineModelProperty(out, key, ${decoded});`,
        '      continue;',
        '    }',
      );
    }
    if (additionalSchema && typeof additionalSchema === 'object' && additionalSchema !== null && 'kind' in additionalSchema) {
      const decoded = emitDecodeValue(additionalSchema as never, 'wire[key]', ctx);
      if (decoded !== 'wire[key]') hasConvertedWrites = true;
      lines.push(`    defineModelProperty(out, key, ${decoded});`);
    }
    lines.push('  }');
  }
  lines.push('  return out;', '}', '');
  return { source: lines.join('\n'), copyIdentity, hasConvertedWrites };
}

function emitEncodeValue(descriptor: ModelTypeDescriptor, expression: string, ctx: EmitCtx): string {
  if (descriptor.kind === 'generated-model') {
    const named = ctx.graph.nodeFor(descriptor);
    if (named) {
      return `${toWireFunctionName(named.id)}(${expression} as never, ${TRUSTED})`;
    }
    return `encodeGeneratedModel(${expression})`;
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    return ctx.serde ? ctx.serde.serialize(tags.serde.id, expression) : expression;
  }
  if (descriptor.kind === 'date' || tags.date) return `serializeDate(${expression})`;
  const named = ctx.graph.nodeFor(descriptor);
  if (named && isObjectish(descriptor)) {
    return `${toWireFunctionName(named.id)}(${expression} as never, ${TRUSTED})`;
  }
  if (descriptor.kind === 'array') {
    const item = emitEncodeValue(descriptor.item, 'item', ctx);
    return `Array.isArray(${expression}) ? ${emitArrayCopy(expression, item)} : ${expression}`;
  }
  if (descriptor.kind === 'tuple') {
    const item = emitTupleItem(descriptor, item => emitEncodeValue(item, '_item', ctx));
    return `Array.isArray(${expression}) ? (${expression} as readonly unknown[]).map((_item, _index, _tuple) => ${item}) : ${expression}`;
  }
  if (descriptor.kind === 'union') {
    return emitUnionEncode(descriptor, expression, ctx);
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return `${toWireFunctionName(node.id)}(${expression} as never, ${TRUSTED})`;
    return emitEncodedRecord(descriptor, expression, ctx);
  }
  return expression;
}

function emitEncodedRecord(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
  ctx: EmitCtx,
): string {
  const fields = Object.entries(descriptor.properties);
  if (fields.length === 0) {
    if (descriptor.additionalProperties !== false) return `{ ...${asRecord(expression)} }`;
    return expression;
  }
  const required = new Set(descriptor.required);
  const values = fields.map(([name, property], index) => {
    const read = access(expression, name);
    const value = emitEncodeValue(property, read, ctx);
    // An optional field whose value is undefined is omitted, as stringify and JSON.stringify do.
    if (!required.has(name) && !value.startsWith('...')) {
      const local = allocateInlineLocal(ctx, '__golemField') ?? `__golemField${index}`;
      const entry = `(${local} !== undefined ? { [${JSON.stringify(name)}]: ${value.replaceAll(read, local)} } : undefined)`;
      return [name, ctx.inlineLocals ? `...(${local} = ${read}, ${entry})` : `...((${local}) => ${entry})(${read})`] as const;
    }
    if (occurrenceCount(value, read) <= 1) return [name, value] as const;
    const local = allocateInlineLocal(ctx, '__golemField');
    if (!local) {
      const fallbackLocal = `__golemField${index}`;
      return [name, `((${fallbackLocal}) => ${value.replaceAll(read, fallbackLocal)})(${read})`] as const;
    }
    return [name, `(${local} = ${read}, ${value.replaceAll(read, local)})`] as const;
  });
  const record = `{ ${values.map(([name, value]) => value.startsWith('...')
    ? value
    : `[${JSON.stringify(name)}]: ${value}`).join(', ')} }`;
  // Inline nested records can receive a getter expression from their parent.
  // Bind that object only when its expression would otherwise be evaluated
  // more than once; ordinary top-level `value`/`record` paths stay direct.
  if (/^[A-Za-z_$][\w$]*$/.test(expression) || occurrenceCount(record, expression) <= 1) return record;
  const local = allocateInlineLocal(ctx, '__golemRecord');
  if (!local) {
    return `((__golemRecord) => (${record.replaceAll(expression, '__golemRecord')}))(${expression})`;
  }
  return `(${local} = ${expression}, ${record.replaceAll(expression, local)})`;
}

function allocateInlineLocal(
  ctx: EmitCtx,
  prefix: '__golemField' | '__golemRecord',
): string | undefined {
  const inlineLocals = ctx.inlineLocals;
  if (!inlineLocals) return undefined;
  const local = `${prefix}${inlineLocals.size}`;
  inlineLocals.add(local);
  return local;
}

function modelValidator(id: string, failFast: boolean): string {
  return failFast ? `validate${id}Fast` : `validate${id}All`;
}

function wireValidator(id: string, failFast: boolean, sameSchema: boolean): string {
  if (sameSchema) return modelValidator(id, failFast);
  return failFast ? `validate${id}WireFast` : `validate${id}WireAll`;
}

type SchemaPlane = 'model' | 'wire' | 'model-only' | 'wire-only';

function residualValidator(id: string, plane: 'model-only' | 'wire-only', failFast: boolean): string {
  const name = plane === 'model-only' ? 'ModelOnly' : 'WireOnly';
  return `validate${id}${name}${failFast ? 'Fast' : 'All'}`;
}

function modelOnlyAssertName(node: SchemaNode): string {
  return `__golemAssertModelOnly_${node.id}`;
}

function wireOnlyAssertName(node: SchemaNode): string {
  return `__golemAssertWireOnly_${node.id}`;
}

function emitSerdeValidates(validationEnabled: boolean): string {
  return validationEnabled
    ? '  const validates = serdeValidates(options, true);'
    : '  serdeValidates(options, false);';
}

function emitAjvGuard(
  node: SchemaNode,
  value: string,
  plane: SchemaPlane,
  issueSource: 'TypeScript' | 'OpenAPI',
): string {
  const wire = plane === 'wire' && !node.sameSchema;
  const representation = plane === 'wire' || plane === 'wire-only' ? 'Wire' : 'Model';
  const reference = plane === 'model-only' || plane === 'wire-only'
    ? `${node.codecId}#${plane}`
    : wire ? `${node.codecId}#wire` : node.codecId;
  const validator = (fast: boolean): string => plane === 'model-only' || plane === 'wire-only'
    ? residualValidator(node.id, plane, fast)
    : wire ? wireValidator(node.id, fast, false) : modelValidator(node.id, fast);
  return `assertModelValue(${value}, options, ${validator(true)}, ${validator(false)}, ${JSON.stringify(reference)}, IssueRepresentation.${representation}, IssueSource.${issueSource});`;
}

function hoistedModelSchemaName(node: SchemaNode): string {
  return `__resolvedModelSchema_${node.id}`;
}

function hoistedWireSchemaName(node: SchemaNode): string {
  return `__resolvedWireSchema_${node.id}`;
}

function hoistedResidualSchemaName(node: SchemaNode, plane: 'model-only' | 'wire-only'): string {
  return plane === 'model-only' ? `__resolvedModelOnlySchema_${node.id}` : `__resolvedWireOnlySchema_${node.id}`;
}

function emitHoistedSchema(name: string, payload: string, id: string, representation: SchemaPlane): string {
  const plane = representation === 'model' ? '' : `, '${representation}'`;
  return [
    `const ${name} = resolveGeneratedModelSchemaRefs(${payload} as object${plane}) as object;`,
    `objectAjvFast.addSchema(structuredClone(${name}) as object, ${JSON.stringify(id)});`,
    `objectAjvAll.addSchema(structuredClone(${name}) as object, ${JSON.stringify(id)});`,
  ].join('\n');
}

function emitNodeRuntime(
  node: SchemaNode,
  ctx: EmitCtx,
  validationEnabled: boolean,
  hoistedSchemas = false,
): string {
  if (node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference') {
    const imported = node.descriptor.kind === 'generated-model'
      ? ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id)
      : undefined;
    if (imported) return '';
    const id = JSON.stringify(node.codecId);
    return [
      emitStringifyFunction(node, ctx.graph, ctx.serde),
      `export function ${fromWireFunctionName(node.id)}(wire: unknown, options?: ${SERDE_OPTIONS}): unknown {`,
      `  return requireObjectCodec(${id}).fromWireFormat(wire, options);`,
      '}',
      '',
      `export function ${toWireFunctionName(node.id)}(value: unknown, options?: ${SERDE_OPTIONS}): unknown {`,
      `  return requireObjectCodec(${id}).toWireFormat(value as never, options);`,
      '}',
      '',
      `export function ${parseFunctionName(node.id)}(text: string, options?: ${SERDE_OPTIONS}): unknown {`,
      `  return requireObjectCodec(${id}).parse(text, options);`,
      '}',
      '',
    ].join('\n');
  }

  const stringifySrc = emitStringifyFunction(node, ctx.graph, ctx.serde, ctx);
  const stringifyName = stringifyFunctionName(node.id);
  const fillName = fillFunctionName(node.id);
  const fromWire = fromWireFunctionName(node.id);
  const toWire = toWireFunctionName(node.id);
  const parseName = parseFunctionName(node.id);
  const validateName = validateFunctionName(node.id);
  const assertName = `assert${node.id}`;
  const exported = (node.anonymous && !ctx.exportAnonymousCodecs) || ctx.privateCodec?.(node) ? '' : 'export ';
  const fieldsType = ctx.fieldsType?.(node);
  const modelType = fieldsType ?? 'Record<string, unknown>';
  const wireAssertName = `__golemAssertWire_${node.id}`;
  const convertName = `convertFromWire${node.id}`;
  // An allOf-style intersection of objects (including referenced models) converts
  // as the merged object, so inherited fields such as dates are decoded too.
  const objectDescriptor = node.descriptor.kind === 'object'
    ? node.descriptor
    : node.descriptor.kind === 'intersection'
      && node.descriptor.variants.every(variant => resolveObjectDescriptor(variant, ctx) !== undefined)
      ? resolveObjectDescriptor(node.descriptor, ctx)
      : undefined;
  const emitsValidatedWire = validationEnabled && !node.sameSchema;
  const encodedStringifyContext: EmitCtx = { ...ctx, inlineLocals: new Set() };
  const encodedWireContext: EmitCtx = { ...ctx, inlineLocals: new Set() };
  const encodedExpr = objectDescriptor
    ? emitEncodedRecord(objectDescriptor, 'value', encodedStringifyContext)
    : emitEncodeValue(node.descriptor, '(value as never)', encodedStringifyContext);
  const encodedRecordExpr = objectDescriptor
    ? emitEncodedRecord(objectDescriptor, 'record', encodedWireContext)
    : emitEncodeValue(node.descriptor, '(value as never)', encodedWireContext);
  const wireStringifySrc = emitsValidatedWire
    ? `${emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, wireIdentity: true })
      .replace(`function ${stringifyName}(`, `function ${stringifyName}Wire(`)}${ctx.exportedWireStringifyIds?.has(node.codecId)
      ? `export { ${stringifyName}Wire as ${wireStringifyExportName(node.codecId)} };\n`
      : ''}`
    : '';

  const wrappedStringify = [
    stringifySrc.replace(`function ${stringifyName}(`, `function ${stringifyName}Core(`),
    wireStringifySrc,
    `${exported}function ${stringifyName}(value: ${modelType}, options?: ${SERDE_OPTIONS}): string {`,
    emitSerdeValidates(validationEnabled),
    ...(emitsValidatedWire ? inlineLocalDeclarations(encodedStringifyContext) : []),
    ...(validationEnabled ? [
      '  if (validates) {',
      `    ${assertName}(value, options);`,
      ...(emitsValidatedWire ? [
        `    const wire = ${encodedExpr};`,
        // The full model check already ran; check only the JSON encoding produced.
        ...(node.wireOnlyJsonSchema !== undefined ? [`    ${wireOnlyAssertName(node)}(wire, options);`] : []),
        `    return ${stringifyName}Wire(wire as never, ${TRUSTED});`,
      ] : []),
      '  }',
    ] : []),
    `  return ${stringifyName}Core(value as never, ${TRUSTED});`,
    '}',
    '',
  ].join('\n');

  const fill = objectDescriptor ? emitFillFunction(node, ctx, objectDescriptor) : undefined;
  const fillSrc = fill?.source ?? '';
  const constructFill = fill?.hasConvertedWrites
    ? (fill.copyIdentity
      ? `${fillName}({ ...${asRecord('source')} }, ${asRecord('source')}, false)`
      : `${fillName}({ ...${asRecord('source')} }, ${asRecord('source')})`)
    : `{ ...${asRecord('source')} }`;
  const decodedExpr = objectDescriptor
    ? undefined
    : emitDecodeValue(node.descriptor, 'source', ctx);

  const convertLines: string[] = [
    `function ${convertName}(wire: unknown, options: ${SERDE_OPTIONS} | undefined, isolated: boolean): unknown {`,
    emitSerdeValidates(validationEnabled),
  ];
  if (validationEnabled) {
    convertLines.push(
      '  if (validates) {',
      `    ${node.sameSchema ? assertName : wireAssertName}(wire, options);`,
      '  }',
    );
  }
  convertLines.push(
    '  const source = isolated || wire === null || typeof wire !== \'object\' ? wire : cloneConversionInput(wire);',
  );
  if (objectDescriptor) {
    convertLines.push(
      '  let result: unknown = source;',
      "  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {",
      '    if (options?.construct) {',
      `      result = Reflect.construct(options.construct, [${constructFill}]);`,
      '    } else {',
      `      result = ${fillName}({} as Record<string, unknown>, source as Record<string, unknown>);`,
      '    }',
      '  }',
    );
  } else if (decodedExpr && decodedExpr !== 'source') {
    convertLines.push(`  const result = ${decodedExpr};`);
  } else {
    convertLines.push('  const result = source;');
  }
  if (validationEnabled && node.modelOnlyJsonSchema !== undefined) {
    // The full wire check already ran; check only what decoding produced.
    convertLines.push(
      '  if (validates) {',
      `    ${modelOnlyAssertName(node)}(result, options);`,
      '  }',
    );
  }
  convertLines.push('  return result;', '}', '');

  const fromWireLines = [
    `${exported}function ${fromWire}(wire: unknown, options?: ${SERDE_OPTIONS}): ${fieldsType ?? 'unknown'} {`,
    `  return ${convertName}(wire, options, false)${fieldsType ? ` as ${fieldsType}` : ''};`,
    '}',
    '',
  ];

  const valueParam = validationEnabled || encodedExpr.includes('value') ? 'value' : '_value';
  const wireType = ctx.wireType?.(node);

  const toWireLines = [
    `${exported}function ${toWire}(${valueParam}: ${fieldsType ?? 'unknown'}, options?: ${SERDE_OPTIONS}): ${wireType ?? 'unknown'} {`,
    emitSerdeValidates(validationEnabled),
    ...(validationEnabled ? [
      '  if (validates) {',
      `    ${assertName}(value, options);`,
      '  }',
    ] : []),
    ...(objectDescriptor ? ['  const record = value as Record<string, unknown>;'] : []),
    ...inlineLocalDeclarations(encodedWireContext),
    `  const wire = ${encodedRecordExpr};`,
    ...(validationEnabled && node.wireOnlyJsonSchema !== undefined ? [
      '  if (validates) {',
      `    ${wireOnlyAssertName(node)}(wire, options);`,
      '  }',
    ] : []),
    wireType ? `  return wire as ${wireType};` : '  return wire;',
    '}',
    '',
  ];

  const parseLines = [
    `${exported}function ${parseName}(text: string, options?: ${SERDE_OPTIONS}): ${fieldsType ?? 'unknown'} {`,
    `  return ${convertName}(parseJson(text), options, true)${fieldsType ? ` as ${fieldsType}` : ''};`,
    '}',
    '',
  ];

  const validateLines = validationEnabled
    ? [
      `${exported}function ${validateName}(value: unknown, options?: ${VALIDATE_OPTIONS}): value is ${modelType} {`,
      '  const failFast = options?.failFast !== false;',
      '  let ok: boolean;',
      '  let errors: readonly unknown[] | null | undefined;',
      '  if (options?.validationContext === undefined) {',
      `    const validator = failFast ? ${modelValidator(node.id, true)} : ${modelValidator(node.id, false)};`,
      '    ok = validator(value);',
      '    errors = validator.errors;',
      '  } else {',
      `    const validator = resolveModelValidationContextValidator(options.validationContext, ${JSON.stringify(node.codecId)}, failFast ? 'first' : 'all');`,
      '    ok = runSynchronousValidation(validator, value);',
      '    errors = validator.errors;',
      '  }',
      `  (${validateName} as { errors?: unknown }).errors = errors;`,
      '  return ok;',
      '}',
      '',
      `${exported}function ${assertName}(value: unknown, options?: ${VALIDATE_OPTIONS}): ${modelType} {`,
      `  ${emitAjvGuard(node, 'value', 'model', ctx.issueSource)}`,
      `  return value as ${modelType};`,
      '}',
      '',
    ]
    : [
      `${exported}function ${validateName}(_value: unknown, _options?: ${VALIDATE_OPTIONS}): _value is ${modelType} {`,
      '  validationUnavailable();',
      '}',
      '',
      `${exported}function ${assertName}(_value: unknown): ${modelType} {`,
      '  validationUnavailable();',
      '}',
      '',
    ];

  const planeAssert = (name: string, plane: SchemaPlane): string[] => [
    `function ${name}(value: unknown, options?: ${VALIDATE_OPTIONS}): Record<string, unknown> {`,
    `  ${emitAjvGuard(node, 'value', plane, ctx.issueSource)}`,
    '  return value as Record<string, unknown>;',
    '}',
    '',
  ];
  const wireAssertLines = validationEnabled && !node.sameSchema
    ? [
      ...planeAssert(wireAssertName, 'wire'),
      ...(node.modelOnlyJsonSchema !== undefined ? planeAssert(modelOnlyAssertName(node), 'model-only') : []),
      ...(node.wireOnlyJsonSchema !== undefined ? planeAssert(wireOnlyAssertName(node), 'wire-only') : []),
    ]
    : [];

  const modelSchemaExpr = ctx.validatorSetExpr && node.validationEnabled !== false
    ? `${ctx.validatorSetExpr}.schemas[${JSON.stringify(node.codecId)}] as object`
    : hoistedSchemas
      ? hoistedModelSchemaName(node)
      : `${jsonDataExpression(schemaPayload(node.modelJsonSchema ?? node.jsonSchema, node.codecId))} as object`;
  const wireSchemaExpr = node.sameSchema
    ? undefined
    : ctx.validatorSetExpr && node.validationEnabled !== false
      ? `${ctx.validatorSetExpr}.schemas[${JSON.stringify(`${node.codecId}#wire`)}] as object`
      : hoistedSchemas
        ? hoistedWireSchemaName(node)
        : `${jsonDataExpression(schemaPayload(node.jsonSchema, `${node.codecId}#wire`))} as object`;
  const residualSchemaExpr = (plane: 'model-only' | 'wire-only'): string | undefined => {
    const residual = plane === 'model-only' ? node.modelOnlyJsonSchema : node.wireOnlyJsonSchema;
    if (residual === undefined || !validationEnabled) return undefined;
    const id = `${node.codecId}#${plane}`;
    if (ctx.validatorSetExpr && node.validationEnabled !== false) return `${ctx.validatorSetExpr}.schemas[${JSON.stringify(id)}] as object`;
    if (hoistedSchemas) return hoistedResidualSchemaName(node, plane);
    return `${jsonDataExpression(schemaPayload(residual, id))} as object`;
  };
  const modelOnlySchemaExpr = residualSchemaExpr('model-only');
  const wireOnlySchemaExpr = residualSchemaExpr('wire-only');
  const codec = [
    `createObjectCodec(${JSON.stringify(node.codecId)}, {`,
    `  stringify: ${stringifyName} as (value: never, options?: ${SERDE_OPTIONS}) => string,`,
    `  parse: ${parseName} as (text: string, options?: ${SERDE_OPTIONS}) => never,`,
    `  validate: ${validateName},`,
    `  assert: ${assertName},`,
    `  toWireFormat: ${toWire},`,
    `  fromWireFormat: ${fromWire},`,
    `  schema: ${modelSchemaExpr},`,
    ...(wireSchemaExpr ? [`  wireSchema: ${wireSchemaExpr},`] : []),
    ...(modelOnlySchemaExpr ? [`  modelOnlySchema: ${modelOnlySchemaExpr},`] : []),
    ...(wireOnlySchemaExpr ? [`  wireOnlySchema: ${wireOnlySchemaExpr},`] : []),
    ...(ctx.validatorSetExpr && node.validationEnabled !== false ? ['  schemaRefsResolved: true,'] : []),
    `  issueSource: IssueSource.${ctx.issueSource},`,
    '});',
    '',
  ];

  return [fillSrc, wrappedStringify, convertLines.join('\n'), fromWireLines.join('\n'), toWireLines.join('\n'), parseLines.join('\n'), validateLines.join('\n'), wireAssertLines.join('\n'), codec.join('\n')].join('\n');
}

function schemaPayload(schema: JsonSchema, id: string): object {
  if (typeof schema === 'boolean') {
    return schema ? { $id: id } : { $id: id, not: true };
  }
  return { $id: id, ...schema };
}

/**
 * A generated-model `$ref` normally resolves at module load through the codec
 * registry. A model emitted in this module registers its codec only after all
 * schemas are added, so point its references at the known schema id instead.
 */
function localModelSchemaRefs(
  schema: JsonSchema,
  local: ReadonlyMap<string, string>,
  wireIds?: ReadonlySet<string>,
): JsonSchema {
  if (local.size === 0) return schema;
  const localCodecIds = new Set(local.values());
  // A wire schema references a model's wire schema when that model has one.
  const target = (id: string): string => wireIds?.has(id) ? `${id}#wire` : id;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === '$ref' && typeof item === 'string' && item.startsWith(GENERATED_MODEL_SCHEMA_REF_PREFIX)) {
        const name = item.slice(GENERATED_MODEL_SCHEMA_REF_PREFIX.length);
        const hash = name.indexOf('#');
        // A residual reference names its own plane (`Name#model-only`).
        if (hash >= 0) {
          // Residual references carry the full codec id; a local codec resolves here, before registration.
          const base = name.slice(0, hash);
          const id = localCodecIds.has(base) ? base : local.get(base) ?? local.get(base.replace(/_[0-9a-f]{8}$/, ''));
          return [key, id === undefined ? item : `${id}${name.slice(hash)}`];
        }
        const id = localCodecIds.has(name) ? name : local.get(name);
        return [key, id === undefined ? item : target(id)];
      }
      return [key, walk(item)];
    }));
  };
  return walk(schema) as JsonSchema;
}

/** Every generated-model descriptor reachable from `descriptor`. */
function generatedModelDescriptors(
  descriptor: ModelTypeDescriptor,
  found: Extract<ModelTypeDescriptor, { kind: 'generated-model' }>[] = [],
): Extract<ModelTypeDescriptor, { kind: 'generated-model' }>[] {
  switch (descriptor.kind) {
    case 'generated-model': found.push(descriptor); break;
    case 'array': generatedModelDescriptors(descriptor.item, found); break;
    case 'tuple':
      for (const item of descriptor.items) generatedModelDescriptors(item, found);
      if (descriptor.rest) generatedModelDescriptors(descriptor.rest.item, found);
      break;
    case 'object':
      for (const property of Object.values(descriptor.properties)) generatedModelDescriptors(property, found);
      if (typeof descriptor.additionalProperties === 'object') generatedModelDescriptors(descriptor.additionalProperties, found);
      break;
    case 'union':
    case 'intersection':
      for (const variant of descriptor.variants) generatedModelDescriptors(variant, found);
      break;
    default: break;
  }
  return found;
}

/**
 * Short model names that name exactly one validated codec of this module,
 * mapped to its schema id. A short name that some reference resolves outside
 * this module, or that two codecs share, keeps its registry reference.
 */
function localModelSchemaIds(
  graph: SchemaGraph,
  nodes: readonly SchemaNode[],
  validates: (node: SchemaNode) => boolean,
): Map<string, string> {
  const ids = new Map<string, Set<string>>();
  const claim = (short: string, target: string): void => {
    ids.set(short, (ids.get(short) ?? new Set()).add(target));
  };
  const local = (node: SchemaNode | undefined): string | undefined =>
    node && !isExternalCodecNode(node) && validates(node) ? node.codecId : undefined;
  for (const node of nodes) {
    // A sibling module registers this codec's schemas under its id before any validator compiles.
    if (node.siblingCodec) {
      if (validates(node)) claim(generatedModelShortName(node.codecId), node.codecId);
      continue;
    }
    const target = local(node) ?? `external:${node.codecId}`;
    claim(node.id, target);
    claim(node.codecId.replace(/_[0-9a-f]{8}$/, ''), target);
    for (const reference of generatedModelDescriptors(node.descriptor)) {
      claim(generatedModelShortName(reference.id), local(graph.nodeFor(reference)) ?? `external:${reference.id}`);
    }
  }
  return new Map([...ids].flatMap(([short, targets]) => {
    const [target] = targets;
    return targets.size === 1 && !target.startsWith('external:') ? [[short, target] as const] : [];
  }));
}

function jsonDataExpression(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Generated schema data is not JSON serializable.');
  return `JSON.parse(${JSON.stringify(json)})`;
}

export function pruneNamedImport(source: string, moduleName: string): string {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(
    new RegExp(`import \\{([^}]+)\\} from '${escaped}';\\n?`),
    (statement, names: string) => {
      const body = source.replace(statement, '');
      // A specifier is used when its local name is: `type A as B` binds B.
      const localName = (specifier: string): string => specifier.replace(/^type\s+/, '').split(/\s+as\s+/).at(-1) ?? specifier;
      const used = names
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && new RegExp(`\\b${localName(name).replace(/\$/g, '\\$')}\\b`).test(body));
      return used.length > 0 ? `import { ${used.join(', ')} } from '${moduleName}';\n` : '';
    },
  );
}

function emitAjvPair(node: SchemaNode, validationEnabled: boolean, validatorSetExpr?: string, lazy = false): string {
  if (!validationEnabled) return '';
  const validator = (name: string, set: 'first' | 'all', id: string): string => {
    const reference = JSON.stringify(id);
    if (validatorSetExpr) return `const ${name} = requireAjvSchema(${validatorSetExpr}.${set}[${reference}], ${reference});`;
    const engine = set === 'first' ? 'objectAjvFast' : 'objectAjvAll';
    return lazy
      ? `const ${name} = lazyAjvSchema(() => { addNestedCodecSchemas(); return ${engine}.getSchema(${reference}); }, ${reference});`
      : `const ${name} = requireAjvSchema(${engine}.getSchema(${reference}), ${reference});`;
  };
  const lines: string[] = [
    validator(modelValidator(node.id, true), 'first', node.codecId),
    validator(modelValidator(node.id, false), 'all', node.codecId),
  ];
  if (!node.sameSchema) {
    const wireId = `${node.codecId}#wire`;
    lines.push(
      validator(wireValidator(node.id, true, false), 'first', wireId),
      validator(wireValidator(node.id, false, false), 'all', wireId),
    );
  }
  for (const plane of ['model-only', 'wire-only'] as const) {
    if ((plane === 'model-only' ? node.modelOnlyJsonSchema : node.wireOnlyJsonSchema) === undefined) continue;
    const residualId = `${node.codecId}#${plane}`;
    lines.push(
      validator(residualValidator(node.id, plane, true), 'first', residualId),
      validator(residualValidator(node.id, plane, false), 'all', residualId),
    );
  }
  return `${lines.join('\n')}\n`;
}

function nodeValidates(node: SchemaNode, defaultEnabled: boolean): boolean {
  if (node.validationEnabled === true) return true;
  if (node.validationEnabled === false) return false;
  return defaultEnabled;
}

function isExternalCodecNode(node: SchemaNode): boolean {
  return node.kind === 'reference'
    || node.descriptor.kind === 'generated-model'
    || node.descriptor.kind === 'reference';
}

/** Ajv + specialized stringify/parse + codec registration for every graph node. */
export function emitCodecRuntime(
  graph: SchemaGraph,
  validationBindingsExprOrOptions: string | CodecRuntimeOptions = '{}',
): string {
  const options: CodecRuntimeOptions = typeof validationBindingsExprOrOptions === 'string'
    ? { validationBindingsExpr: validationBindingsExprOrOptions }
    : validationBindingsExprOrOptions;
  const defaultEnabled = options.validationEnabled !== false;
  const validates = (node: SchemaNode): boolean => nodeValidates(node, defaultEnabled);
  const bindings = options.validationBindingsExpr ?? '{}';
  const nodes = [...graph.topo()];
  const ctx: EmitCtx = {
    graph,
    // emitNodeRuntime emits stringify<Id>Wire exactly for these nodes.
    wireStringifyIds: new Set(nodes.filter((node) => !isExternalCodecNode(node) && validates(node) && !node.sameSchema).map((node) => node.id)),
    siblingWireCodecIds: options.siblingWireCodecIds,
    exportedWireStringifyIds: options.exportedWireStringifyIds,
    validatorSetExpr: options.validatorSetExpr,
    serde: options.serde,
    nestedConstruct: options.nestedConstruct,
    nestedGenerated: options.nestedGenerated,
    nestedImportedSerde: options.nestedImportedSerde,
    exportedFillFunctionIds: options.exportedFillFunctionIds,
    issueSource: options.issueSource ?? 'TypeScript',
    wireType: options.wireType,
    fieldsType: options.fieldsType,
    exportAnonymousCodecs: options.exportAnonymousCodecs,
    privateCodec: options.privateCodec,
  };
  const anyValidation = nodes.some((node) => !isExternalCodecNode(node) && validates(node));
  // Validators compile on first use when a sibling module's codec schema must be added first.
  const lazyNestedSchemas = !ctx.validatorSetExpr && nodes.some((node) => node.siblingCodec);
  const lines: string[] = [];
  if (anyValidation && !ctx.validatorSetExpr) {
    lines.push(
      `const objectAjvFast = createOpenApiSyncAjvEngine({ allErrors: false, validationBindings: ${bindings} });`,
      `const objectAjvAll = createOpenApiSyncAjvEngine({ allErrors: true, validationBindings: ${bindings} });`,
      '',
    );
    if (lazyNestedSchemas) {
      // Nested codecs reference their own nested codecs; the writer adds each schema id once.
      const ownIds = nodes.filter((node) => !isExternalCodecNode(node) && validates(node))
        .flatMap((node) => [
          node.codecId,
          ...(node.sameSchema ? [] : [`${node.codecId}#wire`]),
          ...(node.modelOnlyJsonSchema === undefined ? [] : [`${node.codecId}#model-only`]),
          ...(node.wireOnlyJsonSchema === undefined ? [] : [`${node.codecId}#wire-only`]),
        ]);
      lines.push(
        `const nestedSchemaIds = new Set<string>(${JSON.stringify(ownIds)});`,
        'function nestedSchemaWriter(schema: object, id: string): void {',
        '  if (nestedSchemaIds.has(id)) return;',
        '  nestedSchemaIds.add(id);',
        '  objectAjvFast.addSchema(schema, id);',
        '  objectAjvAll.addSchema(schema, id);',
        '}',
      );
    }
    const nestedCodecs = new Set<string>();
    const nestedSchemaLines: string[] = [];
    const localIds = localModelSchemaIds(graph, nodes, validates);
    const localWireIds = new Set([
      ...nodes.filter(node => !isExternalCodecNode(node) && validates(node) && !node.sameSchema).map(node => node.codecId),
      ...nodes.filter(node => node.siblingCodec && options.siblingWireCodecIds?.has(node.codecId)).map(node => node.codecId),
    ]);
    for (const node of nodes) {
      if (isExternalCodecNode(node)) {
        if (nestedCodecs.has(node.codecId)) continue;
        nestedCodecs.add(node.codecId);
        if (ctx.validatorSetExpr) continue;
        const ctor = node.descriptor.kind === 'generated-model' && ctx.nestedGenerated
          ? `, ${ctx.nestedGenerated(node.descriptor.id)}`
          : '';
        // A sibling codec registers when its module finishes loading, possibly after this one.
        if (node.siblingCodec) nestedSchemaLines.push(`addNestedCodecSchema(nestedSchemaWriter, ${JSON.stringify(node.codecId)}, undefined, nestedCodecIds);`);
        else if (lazyNestedSchemas) lines.push(`addNestedCodecSchema(nestedSchemaWriter, ${JSON.stringify(node.codecId)}${ctor});`);
        else lines.push(`addNestedCodecSchema([(schema, id) => objectAjvFast.addSchema(schema, id), (schema, id) => objectAjvAll.addSchema(schema, id)], ${JSON.stringify(node.codecId)}${ctor});`);
        continue;
      }
      if (!validates(node)) continue;
      const modelPayload = jsonDataExpression(schemaPayload(
        localModelSchemaRefs(node.modelJsonSchema ?? node.jsonSchema, localIds),
        node.codecId,
      ));
      lines.push(emitHoistedSchema(hoistedModelSchemaName(node), modelPayload, node.codecId, 'model'));
      if (!node.sameSchema) {
        const wireId = `${node.codecId}#wire`;
        const wirePayload = jsonDataExpression(schemaPayload(
          localModelSchemaRefs(node.jsonSchema, localIds, localWireIds),
          wireId,
        ));
        lines.push(emitHoistedSchema(hoistedWireSchemaName(node), wirePayload, wireId, 'wire'));
      }
      for (const plane of ['model-only', 'wire-only'] as const) {
        const residual = plane === 'model-only' ? node.modelOnlyJsonSchema : node.wireOnlyJsonSchema;
        if (residual === undefined) continue;
        const residualId = `${node.codecId}#${plane}`;
        // Plain refs inside a residual follow its plane: model-only → model schemas, wire-only → wire schemas.
        const residualPayload = jsonDataExpression(schemaPayload(
          localModelSchemaRefs(residual, localIds, plane === 'wire-only' ? localWireIds : undefined),
          residualId,
        ));
        lines.push(emitHoistedSchema(hoistedResidualSchemaName(node, plane), residualPayload, residualId, plane));
      }
    }
    if (lazyNestedSchemas) {
      lines.push(
        'let nestedCodecSchemasAdded = false;',
        'function addNestedCodecSchemas(): void {',
        '  if (nestedCodecSchemasAdded) return;',
        '  nestedCodecSchemasAdded = true;',
        '  const nestedCodecIds = new Set<string>();',
        ...nestedSchemaLines.map((line) => `  ${line}`),
        '}',
      );
    }
    lines.push('');
  }
  for (const node of nodes) {
    const enabled = validates(node);
    if (isExternalCodecNode(node)) {
      const runtime = emitNodeRuntime(node, ctx, enabled);
      if (runtime) lines.push(runtime);
      continue;
    }
    if (enabled) lines.push(emitAjvPair(node, true, ctx.validatorSetExpr, lazyNestedSchemas));
    lines.push(emitNodeRuntime(node, ctx, enabled, anyValidation && enabled && !ctx.validatorSetExpr));
  }
  return lines.join('\n');
}

export function emitCodecRegistration(node: SchemaNode, graph: SchemaGraph): string {
  return emitNodeRuntime(node, { graph, serde: undefined, issueSource: 'TypeScript' }, true);
}
