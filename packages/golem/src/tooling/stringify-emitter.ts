/**
 * Emit specialized JSON stringify/parse functions from a schema graph.
 * Nested nodes compose by call; bodies are never inlined twice. TSerde and
 * Date convert in the same pass as concat / JSON.parse.
 */

import type { ModelTypeDescriptor } from '../model.js';
import { presentKeysSource, presentValueSource } from '../presence.js';
import type { ValidationPlane } from '../object-codec.js';
import type { SchemaGraph, SchemaNode } from './schema-graph.js';
import { codecShortName, serdeWireDescriptor } from './schema-graph.js';
import type { JsonSchema } from './schema.js';
import { modelName, requireComposedObject, type ModelBases } from './composition.js';
import { emitArrayConversion, emitTupleConversion, JSON_SCALAR_ITEM, singleCallConverter } from './sequence-conversion.js';
import {
  AMBIGUOUS_UNION_CONVERSION_ERROR,
  descriptorNeedsConversion,
  isScalarishDescriptor,
  discriminatorMatch,
  emitDispatch,
  emitUnionConversion,
  literalDiscriminator,
  ObjectUnionDiscriminatorError,
  objectValueExpression,
  presentUnionIndices,
  unionDispatch,
  type DispatchOptions,
  type ObjectTypeDescriptor,
  type UnionConversion,
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
  /**
   * The name the module imports the validator of a root under; the root is a codec id and plane (`Id`, `Id#wire`,
   * `Id#model-only`, `Id#wire-only`). Called once for each use, so the caller knows which validators to import.
   */
  readonly validatorName?: (id: string) => string;
  /**
   * The name the module imports the fast check of a root under, by the same keys; undefined for a root that has none,
   * which keeps the validator's route. Called once for each use, as `validatorName` is.
   */
  readonly fastCheckName?: (id: string) => string | undefined;
  /** Expression of a record of the validation plan's resolved schemas by the same keys. A validated codec publishes these as its schemas; without it the codec carries its own unresolved payload. */
  readonly resolvedSchemasExpr?: string;
  readonly serde?: StringifySerdeResolver;
  readonly nestedConstruct?: (name: string, className?: string) => string;
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
  /** Whether a sibling codec's model is recursive, by codec id. A sibling the job does not know is treated as recursive. */
  readonly siblingRecursion?: ReadonlyMap<string, boolean>;
  /** Export the wire stringify of every public codec, or of those the function accepts (`wireStringifyExportName`), for other generated modules to import. */
  readonly exportWireStringify?: boolean | ((node: SchemaNode) => boolean);
  /** Export anonymous codecs' functions: OpenAPI group modules import them from each other. Model companions keep them private. */
  readonly exportAnonymousCodecs?: boolean;
  /** Codecs whose functions stay module-private, such as a model job's derived projections. */
  readonly privateCodec?: (node: SchemaNode) => boolean;
}

interface EmitCtx {
  readonly graph: SchemaGraph;
  /** The node is a recursive union: each inline array, tuple and object branch of its encoders checks its value for a cycle. */
  readonly guardInline?: boolean;
  readonly validatorName?: (id: string) => string;
  readonly fastCheckName?: (id: string) => string | undefined;
  readonly resolvedSchemasExpr?: string;
  readonly serde?: StringifySerdeResolver;
  readonly nestedConstruct?: (name: string, className?: string) => string;
  readonly nestedGenerated?: (id: string) => string;
  readonly nestedImportedSerde?: (id: string) => NestedImportedSerde | undefined;
  readonly exportedFillFunctionIds?: ReadonlySet<string>;
  readonly issueSource: 'TypeScript' | 'OpenAPI';
  readonly wireType?: (node: SchemaNode) => string | undefined;
  readonly fieldsType?: (node: SchemaNode) => string | undefined;
  readonly wireIdentity?: boolean;
  /** An object root writes each field it holds, and a missing required field is no error: validation did not run. */
  readonly lenientRoot?: boolean;
  /** Nodes whose `stringify<Id>Wire` function this module emits; wire stringify calls them instead of inlining. */
  readonly wireStringifyIds?: ReadonlySet<string>;
  /** Sibling codecs whose companion exports a wire stringify (`wireStringifyExportName`). */
  readonly siblingWireCodecIds?: ReadonlySet<string>;
  /** Whether a sibling codec's model is recursive, by codec id. A sibling the job does not know is treated as recursive. */
  readonly siblingRecursion?: ReadonlyMap<string, boolean>;
  readonly exportWireStringify?: boolean | ((node: SchemaNode) => boolean);
  readonly exportAnonymousCodecs?: boolean;
  readonly privateCodec?: (node: SchemaNode) => boolean;
  /** Nodes being inlined into the current wire stringify, to reject unbounded expansion. */
  readonly wireInlining?: ReadonlySet<string>;
  readonly inlineLocals?: Set<string>;
  /**
   * Nodes whose `stringify<Id>Core` and `toWireFormat<Id>Core` this module emits.
   * A nested trusted call to one skips its validating wrapper.
   */
  readonly localCoreIds?: ReadonlySet<string>;
  /** Local nodes whose Core keeps the all-required fast path: a lenient caller runs their public function instead. */
  readonly strictCoreIds?: ReadonlySet<string>;
  /** Expression of the trusted options passed to a nested call; the module-level constant when the module declares one. */
  readonly trustedOptions?: string;
  /** Emit stringify functions that take no options; they only run trusted. */
  readonly withoutOptions?: boolean;
  /** Counts the conversions emitted for the current node that can throw; see `fallibleConversion`. */
  readonly effects?: { fallible: number };
  /** Module-level converter functions of the current node; without it a converter is emitted inline. */
  readonly hoisted?: HoistedConverters;
  /** Whether the fill of a local node can throw, by node id. */
  readonly fillThrows?: Map<string, boolean>;
  /** Locals a decoder assigns; the function that holds the decoder declares them. Without it the decoder re-reads. */
  readonly decodeLocals?: string[];
}

interface HoistedConverters {
  readonly prefix: string;
  readonly names: Map<string, string>;
  readonly sources: string[];
}

const TRUSTED = '{ validate: false }';
const STRINGIFY_OPTIONS = '_options?: { readonly validate?: boolean; readonly failFast?: boolean }';
/** Declared once per emitted module that passes trusted options to a function in another module. */
const TRUSTED_CONSTANT = '__golemTrusted';
/**
 * The options of a nested call whose caller already checked the whole value. The mark is a symbol key from the global
 * symbol registry, so options a user writes or parses from JSON cannot carry it by accident, and every generated module
 * reads the same key. A function that has a lenient copy runs its all-required fast path for it, and any other options
 * run the lenient copy.
 */
const CHECKED_CONSTANT = '__golemChecked';
const CHECKED_KEY = '__golemMark';
// Generated modules import these as `type ValidateOptions as __GolemValidateOptions` and
// `type SerdeOptions as __GolemSerdeOptions` from @exprtlabs/golem/serde.
const VALIDATE_OPTIONS = '__GolemValidateOptions';
const SERDE_OPTIONS = '__GolemSerdeOptions';

function trustedOptions(ctx: EmitCtx): string {
  return ctx.trustedOptions ?? TRUSTED;
}

/** A nested stringify call that skips validation: the node's Core function when this module emits it. */
function nestedStringifyCall(id: string, expression: string, ctx: EmitCtx): string {
  if (ctx.localCoreIds?.has(id) && !(ctx.lenientRoot && ctx.strictCoreIds?.has(id))) {
    return `${stringifyFunctionName(id)}Core(${expression} as never)`;
  }
  const options = ctx.trustedOptions !== undefined && !ctx.lenientRoot ? CHECKED_CONSTANT : trustedOptions(ctx);
  return `${stringifyFunctionName(id)}(${expression} as never, ${options})`;
}

/** A nested toWireFormat call that skips validation: the node's Core function when this module emits it. */
function nestedToWireCall(id: string, expression: string, ctx: EmitCtx): string {
  return ctx.localCoreIds?.has(id)
    ? `${toWireFunctionName(id)}Core(${expression} as never)`
    : `${toWireFunctionName(id)}(${expression} as never, ${trustedOptions(ctx)})`;
}

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

/**
 * The wire write of a recursive model met again inside its own inline write. A model of another module has its wire
 * stringify imported; one with no encoded value under it writes as the model does; any other has no function to call.
 */
function emitRecursiveWireCall(named: SchemaNode, expression: string, ctx: EmitCtx): string {
  if (ctx.siblingWireCodecIds?.has(named.codecId)) return `${wireStringifyExportName(named.codecId)}(${expression} as never)`;
  if (named.sameSchema && !reachesEncodedValue(named.descriptor, ctx)) return nestedStringifyCall(named.id, expression, ctx);
  throw new Error(named.validationEnabled === false
    ? `Recursive model ${named.name} has validation turned off, so its wire form has no function to write it; turn validation on for it.`
    : `Internal error: recursive model ${named.name} reached its wire write with no function to call.`);
}

/** Whether a value under `descriptor` holds one a codec encodes (a date, a serde type, a model of another module or one with its own wire form). */
function reachesEncodedValue(descriptor: ModelTypeDescriptor, ctx: Pick<EmitCtx, 'graph'>, seen: Set<string> = new Set()): boolean {
  const tags = serdeTags(descriptor);
  if (tags.serde || tags.date || descriptor.kind === 'date' || descriptor.kind === 'generated-model') return true;
  if (descriptor.kind === 'reference') {
    const node = ctx.graph.nodeFor(descriptor);
    if (!node || !node.sameSchema || node.descriptor.kind === 'reference') return true;
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return reachesEncodedValue(node.descriptor, ctx, seen);
  }
  return heldDescriptors(descriptor).some((held) => reachesEncodedValue(held, ctx, seen));
}

function emitValue(
  descriptor: ModelTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  if (descriptor.kind === 'generated-model') {
    const named = ctx.graph.nodeFor(descriptor);
    if (named) {
      return nestedStringifyCall(named.id, expression, ctx);
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
      : nestedStringifyCall(named.id, expression, ctx);
  }
  if (named && isObjectish(descriptor)) {
    if (
      ctx.wireIdentity
      && (named.descriptor.kind === 'object' || (descriptor.kind === 'reference' && descriptor.projection === true))
      && (descriptorNeedsConversion(named.descriptor) || !named.sameSchema)
    ) {
      // Call the node's own wire stringify: inlining would repeat the child for
      // every path to it and never terminate for a recursive model.
      if (ctx.wireStringifyIds?.has(named.id)) return `${stringifyFunctionName(named.id)}Wire(${expression} as never)`;
      if (ctx.wireInlining?.has(named.id)) return emitRecursiveWireCall(named, expression, ctx);
      const inlining = { ...ctx, wireInlining: new Set([...(ctx.wireInlining ?? []), named.id]) };
      return named.descriptor.kind === 'object'
        ? emitObjectInline(named.descriptor, expression, inlining)
        : emitValue(named.descriptor, expression, inlining);
    }
    return nestedStringifyCall(named.id, expression, ctx);
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
    return emitArrayConversion(descriptor.item, expression, {
      output: 'json',
      item: (item, value) => {
        const itemNode = ctx.graph.nodeFor(item);
        return {
          code: itemNode && isObjectish(item) && !ctx.wireIdentity
            ? nestedStringifyCall(itemNode.id, value, ctx)
            : emitValue(item, value, ctx),
          throws: false,
        };
      },
    });
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, expression, {
      output: 'json',
      item: (item, value) => ({ code: emitValue(item, value, ctx), throws: false }),
    });
  }
  if (descriptor.kind === 'union') return emitUnionValue(descriptor, expression, ctx);
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return nestedStringifyCall(node.id, expression, ctx);
    return emitObjectInline(descriptor, expression, ctx);
  }
  return `stringifyJsonScalar(${expression} as never)`;
}

function emitObjectInline(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
  ctx: EmitCtx,
): string {
  const required = new Set(descriptor.required);
  const properties = Object.entries(descriptor.properties);
  const hasExtras = typeof descriptor.additionalProperties === 'object' || descriptor.additionalPropertiesDeclared;
  // An object with no declared field writes `{}`, unless it declares its other names as data.
  if (properties.length === 0 && !hasExtras) return "'{}'";
  if (isPlainDataMap(descriptor)) return `stringifyJsonScalar(${expression} as never)`;
  if (hasExtras) {
    // The other names are data: the encoded record keeps them, and a wire value is already encoded.
    return `stringifyJsonScalar(${ctx.wireIdentity ? expression : emitEncodedRecord(descriptor, expression, ctx)} as never)`;
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

function stringifyParameters(value: string, ctx: EmitCtx): string {
  return ctx.withoutOptions ? value : `${value}, ${STRINGIFY_OPTIONS}`;
}

/**
 * Whether the object is a map with no declared field whose values are plain data (non-numeric scalars, or lists of
 * them). The keys of a map are data, and plain values hold no model instance and need no conversion, so the native
 * JSON writer writes the value as the encoder would. A number stays out: the native writer turns NaN into null, where
 * the encoder throws on a non-finite number.
 */
function isPlainDataMap(descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>): boolean {
  const isPlainData = (value: ModelTypeDescriptor): boolean => {
    if (descriptorNeedsConversion(value)) return false;
    if (value.kind === 'array') return isPlainData(value.item);
    if (value.kind === 'union') return value.variants.every(isPlainData);
    return value.kind !== 'number' && isScalarishDescriptor(value);
  };
  return Object.keys(descriptor.properties).length === 0
    && typeof descriptor.additionalProperties === 'object'
    && isPlainData(descriptor.additionalProperties);
}

/**
 * The writer of an object with validation off that has required fields and no other names. Each declared field is read
 * once, in declaration order, into a local and converted at once when it is present. While every required field is
 * present, one joined string is the result; otherwise the present fields are written one by one from the same locals.
 */
function emitLenientObjectStringify(
  fn: string,
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  ctx: EmitCtx,
): string {
  const properties = Object.entries(descriptor.properties);
  const lines: string[] = [`function ${fn}(${stringifyParameters('value: Record<string, unknown>', ctx)}): string {`];
  const fields = properties.map(([name, property], index) => {
    const read = access('value', name);
    const field = `__golemField${index}`;
    const piece = `__golemPiece${index}`;
    lines.push(
      `  const ${field} = ${read};`,
      `  const ${piece} = ${field} !== undefined ? ${emitValue(property, field, ctx)} : undefined;`,
    );
    return { name: JSON.stringify(name), piece, required: descriptor.required.includes(name) };
  });
  // The first required field has no comma before it: a field before it carries its comma after it, and one after it before.
  const first = fields.findIndex((field) => field.required);
  const chunks = fields.map((field, index) => {
    const member = `${JSON.stringify(`${index > first ? ',' : ''}${field.name}:`)} + ${field.piece}`;
    if (field.required) return member;
    return `(${field.piece} !== undefined ? ${member}${index < first ? ' + ","' : ''} : '')`;
  });
  const present = fields.filter((field) => field.required).map((field) => `${field.piece} !== undefined`);
  lines.push(
    `  if (${present.join(' && ')}) return '{' + ${chunks.join(' + ')} + '}';`,
    "  let out = '{';",
    '  let sep = false;',
  );
  for (const field of fields) {
    lines.push(
      `  if (${field.piece} !== undefined) {`,
      '    if (sep) out += ",";',
      `    out += ${JSON.stringify(`${field.name}:`)} + ${field.piece};`,
      '    sep = true;',
      '  }',
    );
  }
  lines.splice(1, 0, ...inlineLocalDeclarations(ctx));
  lines.push("  return out + '}';", '}', '');
  return lines.join('\n');
}

function emitObjectStringify(
  fn: string,
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  ctx: EmitCtx,
): string {
  // With validation off a required field can be missing, so a lenient object writes each field that is present.
  const required = new Set(ctx.lenientRoot ? [] : descriptor.required);
  const properties = Object.entries(descriptor.properties);
  const additional = typeof descriptor.additionalProperties === 'object'
    ? descriptor.additionalProperties
    : descriptor.additionalPropertiesDeclared ? { kind: 'unknown' as const } : undefined;
  if (properties.length === 0 && !additional) {
    return `function ${fn}(${stringifyParameters('_value: Record<string, unknown>', ctx)}): string {\n  return '{}';\n}\n`;
  }
  if (isPlainDataMap(descriptor)) {
    return `function ${fn}(${stringifyParameters('value: Record<string, unknown>', ctx)}): string {\n  return stringifyJsonScalar(value as never);\n}\n`;
  }
  if (!additional && properties.every(([name]) => required.has(name))) {
    const concatenated = emitRequiredObjectConcat(properties, 'value', ctx);
    return [
      `function ${fn}(${stringifyParameters('value: Record<string, unknown>', ctx)}): string {`,
      ...inlineLocalDeclarations(ctx),
      `  return '{' + ${concatenated};`,
      '}',
      '',
    ].join('\n');
  }
  if (ctx.lenientRoot && !additional && properties.some(([name]) => descriptor.required.includes(name))) return emitLenientObjectStringify(fn, descriptor, ctx);
  const lines: string[] = [
    `function ${fn}(${stringifyParameters('value: Record<string, unknown>', ctx)}): string {`,
    "  let out = '{';",
    '  let sep = false;',
  ];
  for (const [index, [name, property]] of properties.entries()) {
    const read = access('value', name);
    const value = emitValue(property, read, ctx);
    const local = `__golemValue${index}`;
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
  if (additional) {
    // A schema for the other names: they are written after the listed names, each by that schema. Without one, a declared
    // `additionalProperties: true` makes them data of unknown type.
    lines.push(
      '  for (const key of Object.keys(value)) {',
      ...(properties.length === 0 ? [] : [`    if (${JSON.stringify(properties.map(([name]) => name))}.includes(key)) continue;`]),
      '    const __golemExtra = value[key];',
      '    if (__golemExtra === undefined) continue;',
      '    if (sep) out += ",";',
      `    out += stringifyJsonString(key) + ":" + ${emitValue(additional, '__golemExtra', ctx)};`,
      '    sep = true;',
      '  }',
    );
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
    lenientRoot: extra?.lenientRoot,
    wireStringifyIds: extra?.wireStringifyIds,
    siblingWireCodecIds: extra?.siblingWireCodecIds,
    siblingRecursion: extra?.siblingRecursion,
    localCoreIds: extra?.localCoreIds,
    strictCoreIds: extra?.strictCoreIds,
    trustedOptions: extra?.trustedOptions,
    withoutOptions: extra?.withoutOptions,
    wireInlining: extra?.wireIdentity ? new Set([node.id]) : undefined,
    inlineLocals: new Set(),
    guardInline: !extra?.wireIdentity && node.descriptor.kind === 'union' && reachesNode(node.descriptor, node.id, { graph }),
  };
  const fn = stringifyFunctionName(node.id);
  let source: string;
  // An intersection (allOf) is one merged object: the root writes its declared fields, as decode and encode do. With
  // validation off a required field can be missing, so a lenient root writes each field that is present. A checked
  // root, such as the validated wire stringify, keeps the all-required fast path.
  const merged = node.descriptor.kind === 'intersection' && node.descriptor.variants.every(variant => resolveObjectDescriptor(variant, ctx) !== undefined)
    ? resolveObjectDescriptor(node.descriptor, ctx)
    : undefined;
  const root = node.descriptor.kind === 'object' ? node.descriptor : merged;
  if (root) source = emitObjectStringify(fn, root, ctx);
  else if (node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference') {
    source = `function ${fn}(value: unknown, options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {\n  return requireObjectCodec(${JSON.stringify(node.codecId)}).stringify(value as never, options);\n}\n`;
  } else {
    const value = emitValue(node.descriptor, '(value as never)', ctx);
    source = [
      `function ${fn}(${stringifyParameters('value: unknown', ctx)}): string {`,
      ...inlineLocalDeclarations(ctx),
      `  return ${value};`,
      '}',
      '',
    ].join('\n');
  }
  const delegates = node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference';
  const startsLevel = !passesValueOn(node.descriptor, root !== undefined);
  return !ctx.wireIdentity && !delegates && startsLevel && reachesNode(node.descriptor, node.id, ctx) ? guardEncodeCycle(source) : source;
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
  if (!shouldConstructNested(descriptor, ctx)) return trustedOptions(ctx);
  const node = ctx.graph.nodeFor(descriptor);
  const id = node?.codecId
    ?? (descriptor.kind === 'reference' ? descriptor.name : descriptor.kind === 'generated-model' ? descriptor.id : undefined);
  if (!id) return trustedOptions(ctx);
  const ctor = ctx.nestedConstruct?.(id, descriptor.kind === 'reference' ? descriptor.className : undefined) ?? `requireIModelClass(${JSON.stringify(id)})`;
  return `{ validate: false, construct: ${ctor} }`;
}

function extrasAllowed(descriptor: ModelTypeDescriptor): boolean {
  return descriptor.kind !== 'object' || descriptor.additionalProperties !== false;
}

/** The schema every undeclared property of an object follows: its `additionalProperties` type or constraint. */
function additionalSchemaOf(descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>): unknown {
  if (typeof descriptor.additionalProperties === 'object') return descriptor.additionalProperties;
  const constraint = descriptor.constraints?.find((candidate) => candidate.kind === 'additionalProperties');
  return constraint && constraint.kind === 'additionalProperties'
    && constraint.schema !== false
    && !(typeof constraint.schema === 'object'
      && constraint.schema !== null
      && 'kind' in constraint.schema
      && (constraint.schema.kind === 'never' || constraint.schema.kind === 'undefined'))
    ? constraint.schema
    : undefined;
}

/** The type of the values of a map object (`Record<string, V>`); decoding copies the map and decodes each value as `V`. */
function mapValueDescriptor(descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>): ModelTypeDescriptor | undefined {
  const schema = additionalSchemaOf(descriptor);
  return typeof schema === 'object' && schema !== null && 'kind' in schema ? schema as ModelTypeDescriptor : undefined;
}

/** A value that holds no object, so assigning it copies it. */
function isScalarDescriptor(descriptor: ModelTypeDescriptor): boolean {
  switch (descriptor.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'null':
    case 'undefined':
    case 'never':
    case 'literal':
      return true;
    case 'union':
    case 'intersection':
      return descriptor.variants.every(isScalarDescriptor);
    default:
      return false;
  }
}

/**
 * A closed object of required scalar properties is copied by one literal. A property that holds an
 * object needs its own copy, which the object's `fill*` makes.
 */
function emitClosedIdentityObject(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
): string | undefined {
  const required = new Set(descriptor.required);
  const names = Object.keys(descriptor.properties);
  if (names.length === 0) return undefined;
  if (names.some((name) => name === '__proto__' || !required.has(name))) return undefined;
  if (names.some((name) => !isScalarDescriptor(descriptor.properties[name]))) return undefined;
  return `(${emitComputedRecord(names.map((name) => [name, access(expression, name)]))})`;
}

/**
 * A conversion that can throw: nested `fill*`/`convertFromWire*`/`fromWireFormat*` calls, trusted model
 * decodes, `Date` and `TSerde` decoders. A caller compares the count across one `emitDecodeValue` to learn
 * whether the expression can throw, since the field then needs to be on the conversion path for the error
 * to report it.
 */
function fallibleConversion(ctx: EmitCtx, call: string): string {
  if (ctx.effects) ctx.effects.fallible++;
  return call;
}

function fallibleCount(ctx: EmitCtx): number {
  return ctx.effects?.fallible ?? 0;
}

/** Whether an expression emitted since `before` can throw, so it runs under its field's path. */
function emittedFallible(before: number, decoded: string, ctx: EmitCtx): boolean {
  return fallibleCount(ctx) !== before || decoded.includes('unknownDiscriminatorValue(');
}

/** A decoder of `local` as a module-level function, so converting a value allocates no closure. */
function hoistConverter(local: string, decoded: string, locals: readonly string[], ctx: EmitCtx): string {
  if (decoded === `(${local} instanceof Date ? ${local} : deserializeDate(${local}))`) return 'deserializeDate';
  if (!ctx.hoisted) return `(${local}) => (${decoded})`;
  const declarations = locals.length > 0 ? `  let ${locals.map((name) => `${name}: unknown`).join(', ')};\n` : '';
  const body = `(${local}: unknown): unknown {\n${declarations}  return (${decoded});\n}\n`;
  const known = ctx.hoisted.names.get(body);
  if (known) return known;
  const name = `__golemDecode_${ctx.hoisted.prefix}_${ctx.hoisted.names.size}`;
  ctx.hoisted.names.set(body, name);
  ctx.hoisted.sources.push(`function ${name}${body}`);
  return name;
}

/** `convertModelField` for the decoder of `property` written against `local`, with the field value passed in as `input`. */
function emitFieldConversion(field: string, local: string, property: ModelTypeDescriptor, input: string, ctx: EmitCtx): string {
  const scope: EmitCtx = { ...ctx, decodeLocals: [] };
  const decoded = emitDecodeValue(property, local, scope);
  return `convertModelField("deserialize", ${field}, ${hoistConverter(local, decoded, scope.decodeLocals ?? [], ctx)}, ${input})`;
}

/** Whether the fill of `node` can throw, so a caller runs it under its field's path. */
function fillCanThrow(node: SchemaNode, ctx: EmitCtx): boolean {
  const known = ctx.fillThrows?.get(node.id);
  if (known !== undefined || !ctx.fillThrows) return known ?? true;
  // A node reached again while it is emitted is recursive, and a recursive fill throws on a cycle.
  ctx.fillThrows.set(node.id, true);
  const fill = emitFillFunction(node, { ...ctx, effects: { fallible: 0 }, hoisted: undefined, decodeLocals: undefined });
  ctx.fillThrows.set(node.id, fill.fallible);
  return fill.fallible;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++;
  return count;
}

/**
 * Whether decoding `descriptor` hands a value of the input to the result by reference, so the
 * decoder has to check it for cycles. Values of `unknown`/`any`, open objects that need no
 * conversion and `Record<string, unknown>` are carried this way; nested models check their own fields.
 */
function sharesInput(descriptor: ModelTypeDescriptor, ctx: EmitCtx, seen: Set<ModelTypeDescriptor> = new Set()): boolean {
  if (seen.has(descriptor)) return false;
  seen.add(descriptor);
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    const wire = serdeWireDescriptor(descriptor);
    return wire !== undefined && sharesInput(wire, ctx, seen);
  }
  if (tags.date) return false;
  switch (descriptor.kind) {
    case 'any':
    case 'unknown':
      return true;
    case 'array':
      return sharesInput(descriptor.item, ctx, seen);
    case 'tuple':
      return descriptor.items.some((item) => sharesInput(item, ctx, seen))
        || (descriptor.rest !== undefined && sharesInput(descriptor.rest.item, ctx, seen));
    case 'union':
    case 'intersection':
      return descriptor.variants.some((variant) => sharesInput(variant, ctx, seen));
    case 'object': {
      const values = mapValueDescriptor(descriptor);
      // A named object is decoded by its own fill, which checks the values it carries by reference.
      if (ctx.graph.nodeFor(descriptor) && !(values !== undefined && descriptorNeedsConversion(descriptor))) return false;
      // Undeclared properties of an open object are values of unknown type.
      if (values === undefined && extrasAllowed(descriptor)) return true;
      return Object.values(descriptor.properties).some((property) => sharesInput(property, ctx, seen))
        || (values !== undefined && sharesInput(values, ctx, seen))
        || (descriptor.constraints ?? []).some((constraint) => constraint.kind === 'patternProperties');
    }
    case 'reference':
    case 'generated-model': {
      if (descriptor.kind === 'generated-model' && ctx.nestedGenerated?.(descriptor.id)) return false;
      if (shouldConstructNested(descriptor, ctx)) return false;
      // A node is decoded by its own fill or convert function, which checks what it carries by reference.
      return ctx.graph.nodeFor(descriptor) === undefined;
    }
    default:
      return false;
  }
}

/** The descriptors a value of `descriptor` holds directly; a model or reference is followed through its node. */
function heldDescriptors(descriptor: ModelTypeDescriptor): readonly ModelTypeDescriptor[] {
  switch (descriptor.kind) {
    case 'array':
      return [descriptor.item];
    case 'tuple':
      return [...descriptor.items, ...(descriptor.rest !== undefined ? [descriptor.rest.item] : [])];
    case 'union':
    case 'intersection':
      return descriptor.variants;
    case 'object':
      return [...Object.values(descriptor.properties), ...(typeof descriptor.additionalProperties === 'object' ? [descriptor.additionalProperties] : [])];
    default:
      return [];
  }
}

/** Whether decoding `descriptor` can reach the model node `id` again, so a cyclic input would recurse. */
function reachesNode(
  descriptor: ModelTypeDescriptor,
  id: string,
  ctx: Pick<EmitCtx, 'graph'>,
  seen: Set<string> = new Set(),
): boolean {
  if (descriptor.kind === 'reference' || descriptor.kind === 'generated-model') {
    const node = ctx.graph.nodeFor(descriptor);
    if (!node) return false;
    if (node.id === id) return true;
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return reachesNode(node.descriptor, id, ctx, seen);
  }
  return heldDescriptors(descriptor).some((held) => reachesNode(held, id, ctx, seen));
}

/** Whether `descriptor` reaches a recursive model node, so a cyclic value under it would run a validator or encoder forever. */
function reachesRecursion(descriptor: ModelTypeDescriptor, ctx: Pick<EmitCtx, 'graph' | 'siblingRecursion'>, seen: Set<string> = new Set()): boolean {
  if (descriptor.kind === 'reference' || descriptor.kind === 'generated-model') {
    const node = ctx.graph.nodeFor(descriptor);
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    // A model of another module is a node whose descriptor is the reference itself. It guards its own encoders; the
    // job knows whether it is recursive.
    if (node.descriptor.kind === 'reference' || node.descriptor.kind === 'generated-model') return ctx.siblingRecursion?.get(node.codecId) ?? true;
    return reachesNode(node.descriptor, node.id, ctx) || reachesRecursion(node.descriptor, ctx, seen);
  }
  return heldDescriptors(descriptor).some((held) => reachesRecursion(held, ctx, seen));
}

/**
 * Whether the model `node` reaches a recursive model (itself or another). A manifest publishes it, so a job that holds
 * the model knows whether its value needs the cycle walk before a validator.
 */
export function reachesRecursiveNode(graph: SchemaGraph, node: SchemaNode, siblingRecursion?: ReadonlyMap<string, boolean>): boolean {
  return node.descriptor.kind !== 'reference' && node.descriptor.kind !== 'generated-model'
    && reachesRecursion(node.descriptor, { graph, siblingRecursion });
}

/** Whether the model `node` reaches itself, so another module that writes it in place meets it again. */
export function reachesItself(graph: SchemaGraph, node: SchemaNode): boolean {
  return node.descriptor.kind !== 'reference' && node.descriptor.kind !== 'generated-model'
    && reachesNode(node.descriptor, node.id, { graph });
}

/**
 * Whether the encoder of `descriptor` hands the same value to another encoder: a union picks a variant, and an
 * intersection that is not one merged object writes its parts. Only an encoder that starts a new level (an object,
 * array or tuple) guards the value; a guard here would meet the variant's guard on the same value and report a cycle.
 */
function passesValueOn(descriptor: ModelTypeDescriptor, writesMergedObject: boolean): boolean {
  return descriptor.kind === 'union' || (descriptor.kind === 'intersection' && !writesMergedObject);
}

/**
 * Wraps the body of a generated encoder function of `value` so that a value already being written is a cycle.
 * Only a recursive model's encoders carry it; the other encoders keep their speed.
 */
function guardEncodeCycle(source: string): string {
  const bodyStart = source.indexOf('{\n') + 2;
  const bodyEnd = source.lastIndexOf('}');
  return `${source.slice(0, bodyStart)}  beginEncode(value);\n  try {\n${source.slice(bodyStart, bodyEnd)}  } finally {\n    endEncode(value);\n  }\n}\n`;
}

function emitInternedObjectDecode(
  node: SchemaNode,
  descriptor: ModelTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  if (shouldConstructNested(descriptor, ctx)) {
    const local = !isExternalCodecNode(node) && !(ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id));
    return fallibleConversion(ctx, local
      ? `convertFromWire${node.id}(${expression}, ${nestedFromWireOptions(descriptor, ctx)})`
      : `${fromWireFunctionName(node.id)}(${expression}, ${nestedFromWireOptions(descriptor, ctx)})`);
  }
  if (
    node.kind === 'object'
    && node.descriptor.kind === 'object'
    && !descriptorNeedsConversion(node.descriptor)
  ) {
    // An open object or a map is copied by its `fill*`; only a closed object of scalars is one literal.
    const closed = extrasAllowed(node.descriptor) ? undefined : emitClosedIdentityObject(node.descriptor, expression);
    if (closed) return closed;
  }
  if (node.kind === 'object') {
    const imported = ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id);
    const call = `${imported?.fill ?? fillFunctionName(node.id)}({} as Record<string, unknown>, ${asRecord(expression)})`;
    // A local fill that cannot throw runs without its field's path.
    return imported || fillCanThrow(node, ctx) ? fallibleConversion(ctx, call) : call;
  }
  return fallibleConversion(ctx, `${fromWireFunctionName(node.id)}(${expression}, ${trustedOptions(ctx)})`);
}

/**
 * The bases of each model in the graph: the node of a model that extends others is an intersection that holds the base
 * models, so a derived model narrows each base when two parts declare one name (a covariant override).
 */
function graphModelBases(graph: SchemaGraph): ModelBases {
  return {
    basesOf(name) {
      const descriptor = graph.nodeFor({ kind: 'reference', name })?.descriptor;
      if (descriptor?.kind !== 'intersection') return [];
      return descriptor.variants.map(modelName).filter((base): base is string => base !== undefined);
    },
  };
}

function resolveObjectDescriptor(
  descriptor: ModelTypeDescriptor,
  ctx: EmitCtx,
): ObjectTypeDescriptor | undefined {
  if (descriptor.kind === 'object') return descriptor;
  if (descriptor.kind === 'intersection') {
    const objects = descriptor.variants.flatMap((variant) => resolveObjectDescriptor(variant, ctx) ?? []);
    return objects.length > 1 ? requireComposedObject(objects, graphModelBases(ctx.graph)) : objects[0];
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
  // A decoder in a function that declares its locals reads the tag once and reuses it in the variant's copy.
  const tagRead = dispatch ? access(expression, dispatch.property) : undefined;
  const tagLocal = dispatch && direction === 'decode' && ctx.decodeLocals && /^[A-Za-z_$][\w$]*$/.test(expression)
    && variants.every((variant) => variantClassName(variant, ctx) === undefined)
    ? `__golemTag${ctx.decodeLocals.length}`
    : undefined;
  if (tagLocal) ctx.decodeLocals?.push(tagLocal);
  const conversions = variants.map((variant) => {
    const converted = convert(variant);
    return tagLocal && tagRead ? converted.split(tagRead).join(tagLocal) : converted;
  });
  if (!dispatch) {
    if (direction !== 'encode-json' && conversions.every((converted) => converted === expression)) return expression;
    if (options?.unresolved === 'skip') return undefined;
    throw new ObjectUnionDiscriminatorError(variants);
  }
  return emitDispatch({
    expression,
    property: dispatch.property,
    direction,
    tagLocal,
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
      ? ctx.nestedConstruct?.(ctx.graph.nodeFor(variant)?.codecId ?? variant.name, variant.kind === 'reference' ? variant.className : undefined)
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
  if (converted === undefined) throw new ObjectUnionDiscriminatorError(union.variants);
  return converted;
}

/** Match any required literal tag of `objects`, for mixing them with one generated model. */
function objectTagMatch(objects: readonly ObjectTypeDescriptor[], expression: string, decode: boolean): string[] {
  // Decoding reads the tag by the JSON view, so an inherited or non-enumerable tag matches no object.
  const read = (name: string): string => decode
    ? `(${presentValueSource(expression, JSON.stringify(name), tagAccess(expression, name))})`
    : tagAccess(expression, name);
  return objects.flatMap((object) => [...literalDiscriminator(object)].map(([name, values]) => discriminatorMatch(read(name), values)));
}

/**
 * The branch of a recursive union that writes an inline array, tuple or object registers its value while it writes, so a
 * value that holds itself throws at its first repeat. A named node guards itself.
 */
function inlineBranchGuard(ctx: EmitCtx, expression: string): UnionConversion['guard'] {
  if (!ctx.guardInline) return undefined;
  return (variant, code) => ctx.graph.nodeFor(variant)
    ? code
    : `(() => { beginEncode(${expression}); try { return ${code}; } finally { endEncode(${expression}); } })()`;
}

function emitUnionValue(
  descriptor: UnionTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  let itemsUnchanged = true;
  const plain = `stringifyJsonScalar(${expression} as never)`;
  return emitUnionConversion(descriptor, expression, 'stringify', {
    guard: inlineBranchGuard(ctx, expression),
    convert: (variant) => emitValue(variant, expression, ctx),
    items: {
      output: 'json',
      item: (item, value) => {
        const code = emitValue(item, value, ctx);
        if (code !== JSON_SCALAR_ITEM) itemsUnchanged = false;
        return { code, throws: false };
      },
    },
    joinSequence: (items, scalar) => itemsUnchanged && scalar === plain
      ? plain
      : `(Array.isArray(${expression}) ? ${items} : (${scalar}))`,
    tagged: () => emitTaggedVariantUnion(
      descriptor,
      presentUnionIndices(descriptor),
      expression,
      ctx,
      (variant) => {
        if (!ctx.wireIdentity) {
          const node = ctx.graph.nodeFor(variant);
          if (node && isObjectish(variant)) {
            return nestedStringifyCall(node.id, expression, ctx);
          }
        }
        return emitValue(variant, expression, ctx);
      },
      'encode-json',
      { unresolved: 'skip' },
    ),
    beforeGenerated: (present) => {
      const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
      if (objects.length > 1) {
        const structured = objects.some((object) => {
          const node = ctx.graph.nodeFor(object);
          return Boolean(node) || Object.keys(object.properties).length > 0 || object.additionalProperties === false;
        });
        if (structured) throw new ObjectUnionDiscriminatorError(objects);
      }
      return present.every(isScalarishDescriptor) ? plain : undefined;
    },
    generated: {
      text: (generated) => emitValue(generated, expression, ctx),
      tagMatch: (objects) => objectTagMatch(objects, expression, false),
      objects: (objects) => objects.length === 1
        ? emitValue(objects[0], expression, ctx)
        : emitTaggedObjects(descriptor, expression, ctx, (object) => emitValue(object, expression, ctx), 'encode-json'),
    },
  });
}

function emitUnionDecode(
  descriptor: UnionTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  return emitUnionConversion(descriptor, expression, 'decode', {
    convert: (variant) => emitDecodeValue(variant, expression, ctx),
    items: {
      output: 'value',
      paths: 'deserialize',
      item: (item, value) => {
        const before = fallibleCount(ctx);
        const code = emitDecodeValue(item, value, { ...ctx, decodeLocals: undefined });
        // An item that can throw runs under its index, as a module-level function when it is hoisted.
        if (!emittedFallible(before, code, ctx)) return { code, throws: false };
        const scope: EmitCtx = { ...ctx, decodeLocals: [] };
        const decoded = emitDecodeValue(item, value, scope);
        const converter = hoistConverter(value, decoded, scope.decodeLocals ?? [], ctx);
        const call = `${converter}(${value})`;
        return { code: singleCallConverter(call, value) === converter ? call : decoded, throws: true };
      },
    },
    tagged: () => emitTaggedVariantUnion(
      descriptor,
      presentUnionIndices(descriptor),
      expression,
      ctx,
      (variant) => emitDecodeValue(variant, expression, ctx),
      'decode',
    ),
    generated: {
      text: (generated) => {
        const className = ctx.nestedGenerated?.(generated.id);
        return className
          ? `${expression} instanceof ${className} ? ${expression} : ${fallibleConversion(ctx, `decodeGeneratedModelTrusted(${className}, ${expression})`)}`
          : undefined;
      },
      tagMatch: (objects) => objectTagMatch(objects, expression, true),
      objects: () => expression,
      takesEveryObject: true,
    },
    afterGenerated: (present) => {
      const refs = present.filter((variant): variant is Extract<ModelTypeDescriptor, { kind: 'reference' }> =>
        variant.kind === 'reference' && variant.construct === true);
      if (refs.length === 0 || refs.length !== present.length) return undefined;
      const branches: string[] = [];
      for (const ref of refs) {
        const node = ctx.graph.nodeFor(ref);
        const object = node?.descriptor.kind === 'object' ? node.descriptor : undefined;
        if (!object) throw new Error(AMBIGUOUS_UNION_CONVERSION_ERROR);
        const tags = objectTagMatch([object], expression, true);
        if (tags.length === 0) throw new ObjectUnionDiscriminatorError(present);
        branches.push(`${tags.join(' && ')} ? ${emitDecodeValue(ref, expression, ctx)}`);
      }
      return `(${objectValueExpression(expression)} ? ${[...branches, expression].join(' : ')} : ${expression})`;
    },
  });
}

function emitUnionEncode(
  descriptor: UnionTypeDescriptor,
  expression: string,
  ctx: EmitCtx,
): string {
  return emitUnionConversion(descriptor, expression, 'encode', {
    guard: inlineBranchGuard(ctx, expression),
    convert: (variant) => emitEncodeValue(variant, expression, ctx),
    items: {
      output: 'value',
      item: (item, value) => ({ code: emitEncodeValue(item, value, ctx), throws: false }),
    },
    tagged: () => emitTaggedVariantUnion(
      descriptor,
      presentUnionIndices(descriptor),
      expression,
      ctx,
      (variant) => emitEncodeValue(variant, expression, ctx),
      'encode-value',
      { unresolved: 'skip' },
    ),
    generated: {
      text: (generated) => emitEncodeValue(generated, expression, ctx),
      tagMatch: (objects) => objectTagMatch(objects, expression, false),
      objects: (objects) => objects.length === 1
        ? emitEncodeValue(objects[0], expression, ctx)
        : emitTaggedObjects(descriptor, expression, ctx, (object) => emitEncodeValue(object, expression, ctx), 'encode-value'),
    },
    afterGenerated: (present) => {
      const objects = present.filter((variant): variant is ObjectTypeDescriptor => variant.kind === 'object');
      if (objects.length === present.length && objects.some((object) => descriptorNeedsConversion(object))) {
        throw new ObjectUnionDiscriminatorError(objects);
      }
      return undefined;
    },
  });
}

function emitDecodeValue(descriptor: ModelTypeDescriptor, expression: string, ctx: EmitCtx): string {
  if (descriptor.kind === 'generated-model') {
    const className = ctx.nestedGenerated?.(descriptor.id);
    if (className) return fallibleConversion(ctx, `decodeGeneratedModelTrusted(${className}, ${expression})`);
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    const deserialized = ctx.serde ? fallibleConversion(ctx, ctx.serde.deserialize(tags.serde.id, expression)) : expression;
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
    return fallibleConversion(ctx, `(${expression} instanceof Date ? ${expression} : deserializeDate(${expression}))`);
  }
  if (descriptor.kind === 'union') {
    return emitUnionDecode(descriptor, expression, ctx);
  }
  // An intersection of objects decodes as the one merged object, so each member's fields convert.
  const decodedMerge = descriptor.kind === 'intersection' ? requireComposedObject(descriptor.variants, graphModelBases(ctx.graph)) : undefined;
  if (decodedMerge) return emitDecodeValue(decodedMerge, expression, ctx);
  if (descriptor.kind === 'object' && typeof descriptor.additionalProperties === 'object') {
    const listed = Object.keys(descriptor.properties);
    // A node's fill converts each listed name by its own schema and every other name by the additional schema.
    if (listed.length > 0 || !descriptorNeedsConversion(descriptor)) {
      const named = ctx.graph.nodeFor(descriptor);
      if (named) return emitInternedObjectDecode(named, descriptor, expression, ctx);
    }
    const before = fallibleCount(ctx);
    const decoded = emitDecodeValue(descriptor.additionalProperties, 'value', { ...ctx, decodeLocals: undefined });
    const entry = emittedFallible(before, decoded, ctx)
      ? emitFieldConversion('key', 'value', descriptor.additionalProperties, 'value', ctx)
      : decoded;
    const entries = `Object.entries((${expression} ?? {}) as Record<string, unknown>)`;
    if (listed.length === 0) return `Object.fromEntries(${entries}.map(([key, value]) => [key, ${entry}]))`;
    const extras = `Object.fromEntries(${entries}.filter(([key]) => !${JSON.stringify(listed)}.includes(key)).map(([key, value]) => [key, ${entry}]))`;
    return `{ ...${extras}, ...${emitDecodedRecord(descriptor, expression, ctx)} }`;
  }
  const named = ctx.graph.nodeFor(descriptor);
  if (named && isObjectish(descriptor)) {
    return emitInternedObjectDecode(named, descriptor, expression, ctx);
  }
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, expression, {
      output: 'value',
      paths: 'deserialize',
      item: (item, value) => {
        const before = fallibleCount(ctx);
        const code = emitDecodeValue(item, value, { ...ctx, decodeLocals: undefined });
        // An item that can throw runs under its index, as a module-level function when it is hoisted.
        if (!emittedFallible(before, code, ctx)) return { code, throws: false };
        const scope: EmitCtx = { ...ctx, decodeLocals: [] };
        const decoded = emitDecodeValue(item, value, scope);
        const converter = hoistConverter(value, decoded, scope.decodeLocals ?? [], ctx);
        const call = `${converter}(${value})`;
        return { code: singleCallConverter(call, value) === converter ? call : decoded, throws: true };
      },
    });
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, expression, {
      output: 'value',
      paths: 'deserialize',
      item: (item, value) => {
        const before = fallibleCount(ctx);
        const code = emitDecodeValue(item, value, ctx);
        return { code, throws: emittedFallible(before, code, ctx) };
      },
    });
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return emitInternedObjectDecode(node, descriptor, expression, ctx);
    return emitDecodedRecord(descriptor, expression, ctx);
  }
  return expression;
}

function emitComputedRecord(fields: readonly (readonly [string, string])[]): string {
  if (fields.length === 0) return '{}';
  return `{ ${fields.map(([name, value]) => value.startsWith('...') ? value : `[${JSON.stringify(name)}]: ${value}`).join(', ')} }`;
}

function emitDecodedRecord(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
  ctx: EmitCtx,
): string {
  const fields = Object.entries(descriptor.properties);
  if (fields.length === 0) return expression;
  const required = new Set(descriptor.required);
  return emitComputedRecord(fields.map(([name, property]) => {
    const source = access(expression, name);
    const before = fallibleCount(ctx);
    const decoded = emitDecodeValue(property, source, { ...ctx, decodeLocals: undefined });
    // A source property is read once: a conversion that can throw runs under its field's path with the
    // property as its argument, and another conversion binds it to a parameter when it uses it again.
    const converted = emittedFallible(before, decoded, ctx)
      ? emitFieldConversion(JSON.stringify(name), NESTED_SOURCE, property, source, ctx)
      : countOccurrences(decoded, source) > 1
        ? `((${NESTED_SOURCE}) => ${emitDecodeValue(property, NESTED_SOURCE, ctx)})(${source})`
        : decoded;
    // An optional property that converts is read only when the input has it.
    if (!required.has(name) && decoded !== source) {
      return [name, `...(${source} !== undefined ? { [${JSON.stringify(name)}]: ${converted} } : {})`];
    }
    return [name, converted];
  }));
}

/** Parameter of an inline decoder that reads a nested property once; inner decoders shadow it. */
const NESTED_SOURCE = '__golemSource';

function emitFillPropertyWrite(name: string, decoded: string, indent = '    '): string {
  if (name === '__proto__') {
    return `${indent}defineModelProperty(out, ${JSON.stringify(name)}, ${decoded});`;
  }
  return `${indent}out[${JSON.stringify(name)}] = ${decoded};`;
}

/** Result of emitting how one source property reaches the fill output. */
interface FillValue {
  /** Statements that run before the write; they read the source property once into a local. */
  readonly statements: readonly string[];
  readonly value: string;
  /** The conversion changes the value. */
  readonly converted: boolean;
  /** The value is carried by reference, so it was checked for cycles. */
  readonly checked: boolean;
  /** The conversion can throw. */
  readonly fallible: boolean;
}

/**
 * Reads the source property once. A value the result shares with the input is checked for cycles against
 * `wire` first (a recursive node's fill registers its own wire); a conversion that can throw runs under the field's path.
 */
function emitFillValue(
  property: ModelTypeDescriptor,
  read: string,
  field: string,
  local: string,
  ctx: EmitCtx,
): FillValue {
  const before = fallibleCount(ctx);
  const decoded = emitDecodeValue(property, read, { ...ctx, decodeLocals: undefined });
  const fallible = emittedFallible(before, decoded, ctx);
  const checked = sharesInput(property, ctx);
  const converted = decoded !== read;
  if (!checked && !fallible && countOccurrences(decoded, read) <= 1) return { statements: [], value: decoded, converted, checked, fallible };
  const input = checked ? `assertPropertyAcyclic(wire, ${field}, ${read})` : read;
  if (fallible) {
    return { statements: [], value: emitFieldConversion(field, local, property, input, ctx), converted, checked, fallible };
  }
  return { statements: [`const ${local} = ${input};`], value: emitDecodeValue(property, local, ctx), converted, checked, fallible };
}

function emitFillFunction(
  node: SchemaNode,
  ctx: EmitCtx,
  descriptor: ModelTypeDescriptor = node.descriptor,
): { readonly source: string; readonly copyIdentity: boolean; readonly needsFill: boolean; readonly fallible: boolean } {
  const fn = fillFunctionName(node.id);
  const exported = ctx.exportedFillFunctionIds?.has(node.id) ? 'export ' : '';
  if (descriptor.kind !== 'object') {
    return {
      source: `${exported}function ${fn}(out: Record<string, unknown>, _wire: Record<string, unknown>): Record<string, unknown> {\n  return out;\n}\n`,
      copyIdentity: false,
      needsFill: false,
      fallible: false,
    };
  }
  const properties = Object.entries(descriptor.properties);
  const additionalSchema = additionalSchemaOf(descriptor);
  // An open object keeps its undeclared properties, as values of unknown type.
  const carriesExtras = additionalSchema === undefined && descriptor.additionalProperties !== false;
  const patternConstraints = (descriptor.constraints ?? []).filter(
    (constraint) => constraint.kind === 'patternProperties',
  );
  if (properties.length === 0 && !additionalSchema && patternConstraints.length === 0) {
    // Every property is carried over as it is and checked; an own `__proto__` stays a data property.
    return {
      source: `${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {\n  for (const key of Object.keys(wire)) {\n    const extra = wire[key];\n    if (extra === undefined) continue;\n    const value = assertPropertyAcyclic(wire, key, extra);\n    if (out !== wire) defineModelProperty(out, key, value);\n  }\n  return out;\n}\n`,
      copyIdentity: false,
      needsFill: true,
      fallible: true,
    };
  }
  const required = new Set(descriptor.required);
  // A recursive node registers the wire it decodes, so a cycle in the input stops at the repeated object.
  const recursive = reachesNode(descriptor, node.id, ctx);
  const identityWrites: string[] = [];
  const propertyWrites: string[] = [];
  let copyIdentity = false;
  let needsFill = false;
  // A recursive fill throws on a cycle; a carried value is checked for cycles.
  let fallible = recursive;
  // Fields whose write depends on presence; one Object.keys pass reads them all at the top of the function.
  const captured: [key: string, local: string][] = [];
  properties.forEach(([name, property], index) => {
    const field = JSON.stringify(name);
    // The JSON view: a wire field is present when it is own, enumerable and not undefined. Where a write depends on
    // presence, the field is read into a local by the one Object.keys pass; a carried required field reads the wire.
    const optional = !required.has(name);
    const direct = access('wire', name);
    const present = `__golemPresent${index}`;
    const readDirect = (line: string): string => line.replaceAll(present, direct);
    const fill = emitFillValue(property, present, field, `__golemWire${index}`, ctx);
    const proto = name === '__proto__';
    if (fill.converted || fill.checked || proto) needsFill = true;
    if (fill.fallible || fill.checked) fallible = true;
    if (!fill.converted && !fill.checked && !proto) {
      copyIdentity = true;
      captured.push([name, present]);
      identityWrites.push(
        `    if (${present} !== undefined) {`,
        emitFillPropertyWrite(name, fill.value, '      '),
        '    }',
      );
      return;
    }
    if (!fill.converted && !proto) {
      // Carried by reference: checked on every call, written only when the caller wants identity fields copied.
      copyIdentity = true;
      const write = (value: string): string[] => ['  if (copyIdentity) {', emitFillPropertyWrite(name, value, '    '), '  }'];
      if (optional) captured.push([name, present]);
      propertyWrites.push(...(!optional
        ? [...fill.statements.map((line) => `  ${readDirect(line)}`), ...write(readDirect(fill.value))]
        : [
          `  if (${present} !== undefined) {`,
          ...[...fill.statements, ...write(fill.value)].map((line) => line.startsWith('  ') ? `  ${line}` : `    ${line}`),
          '  }',
        ]));
      return;
    }
    captured.push([name, present]);
    propertyWrites.push(
      `  if (${present} !== undefined) {`,
      ...fill.statements.map((line) => `    ${line}`),
      emitFillPropertyWrite(name, fill.value),
      '  }',
    );
  });
  const declaration = copyIdentity
    ? `${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>, copyIdentity = true): Record<string, unknown> {`
    : `${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {`;
  const lines: string[] = [
    declaration,
    ...(captured.length > 0 ? [`  ${presentKeysSource('wire', captured, local => `${local}: unknown`)}`] : []),
    ...(identityWrites.length > 0
      ? ['  if (copyIdentity) {', ...identityWrites, '  }']
      : []),
    ...propertyWrites,
  ];
  if (additionalSchema || carriesExtras || patternConstraints.length > 0) {
    const known = properties.map(([name]) => JSON.stringify(name)).join(', ');
    lines.push(
      `  for (const key of Object.keys(wire)) {`,
      `    if (${known ? `[${known}].includes(key)` : 'false'}) continue;`,
      // An undeclared key whose value is undefined is absent, as the validator and encode treat it.
      '    const __golemExtra = wire[key];',
      '    if (__golemExtra === undefined) continue;',
    );
    const emitExtra = (schema: ModelTypeDescriptor | undefined, indent: string): string[] => {
      // A pattern without a field schema carries the value by reference.
      const value = schema === undefined
        ? { statements: [], value: 'assertPropertyAcyclic(wire, key, __golemExtra)', converted: false, checked: true, fallible: true }
        : emitFillValue(schema, '__golemExtra', 'key', '__golemValue', ctx);
      if (value.converted || value.checked) needsFill = true;
      if (value.fallible || value.checked) fallible = true;
      return [
        ...value.statements.map((line) => `${indent}${line}`),
        `${indent}defineModelProperty(out, key, ${value.value});`,
      ];
    };
    for (const pattern of patternConstraints) {
      if (pattern.kind !== 'patternProperties') continue;
      const schema = typeof pattern.schema === 'object' && pattern.schema !== null && 'kind' in pattern.schema
        ? pattern.schema as ModelTypeDescriptor
        : undefined;
      lines.push(
        `    if (new RegExp(${JSON.stringify(pattern.pattern)}).test(key)) {`,
        ...emitExtra(schema, '      '),
        '      continue;',
        '    }',
      );
    }
    if (additionalSchema && typeof additionalSchema === 'object' && additionalSchema !== null && 'kind' in additionalSchema) {
      lines.push(...emitExtra(additionalSchema as ModelTypeDescriptor, '    '));
    }
    if (carriesExtras) lines.push(...emitExtra(undefined, '    '));
    lines.push('  }');
  }
  lines.push('  return out;');
  const body = lines.splice(1);
  const source = recursive
    ? [declaration, '  beginDecode(wire);', '  try {', ...body.map((line) => `  ${line}`), '  } finally {', '    endDecode(wire);', '  }', '}', '']
    : [declaration, ...body, '}', ''];
  return { source: source.join('\n'), copyIdentity, needsFill, fallible };
}

function emitEncodeValue(descriptor: ModelTypeDescriptor, expression: string, ctx: EmitCtx): string {
  if (descriptor.kind === 'generated-model') {
    const named = ctx.graph.nodeFor(descriptor);
    if (named) {
      return nestedToWireCall(named.id, expression, ctx);
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
    return nestedToWireCall(named.id, expression, ctx);
  }
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, expression, {
      output: 'value',
      item: (item, value) => ({ code: emitEncodeValue(item, value, ctx), throws: false }),
    });
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, expression, {
      output: 'value',
      item: (item, value) => ({ code: emitEncodeValue(item, value, ctx), throws: false }),
    });
  }
  const encodedMerge = descriptor.kind === 'intersection' ? requireComposedObject(descriptor.variants, graphModelBases(ctx.graph)) : undefined;
  if (encodedMerge) return emitEncodeValue(encodedMerge, expression, ctx);
  if (descriptor.kind === 'union') {
    return emitUnionEncode(descriptor, expression, ctx);
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return nestedToWireCall(node.id, expression, ctx);
    return emitEncodedRecord(descriptor, expression, ctx);
  }
  // An intersection with a member that is no object is written as it is, without the program state of a model instance.
  if (descriptor.kind === 'intersection') return `withoutInstanceState(${expression})`;
  // A value of unknown type can hold a model instance at any depth.
  if (descriptor.kind === 'unknown' || descriptor.kind === 'any') return `withoutInstanceState(${expression})`;
  return expression;
}

function emitEncodedRecord(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: string,
  ctx: EmitCtx,
): string {
  const fields = Object.entries(descriptor.properties);
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
  // A schema for the other names: they are kept and encoded by it. Without one, a declared `additionalProperties: true`
  // keeps them as they are. Any other object writes its listed names only.
  const additional = typeof descriptor.additionalProperties === 'object' ? descriptor.additionalProperties : undefined;
  const extras = additional || descriptor.additionalPropertiesDeclared
    ? [`...Object.fromEntries(Object.entries(${asRecord(expression)}).filter(([${fields.length === 0 ? '' : 'key'}, extra]) => extra !== undefined${fields.length === 0 ? '' : ` && !${JSON.stringify(fields.map(([name]) => name))}.includes(key)`}).map(([key, extra]) => [key, ${emitEncodeValue(additional ?? { kind: 'unknown' }, 'extra', ctx)}]))`]
    : [];
  const entries = [...extras, ...values.map(([name, value]) => value.startsWith('...')
    ? value
    : `[${JSON.stringify(name)}]: ${value}`)];
  const record = entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
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

function validatorReference(ctx: EmitCtx, id: string): string {
  if (ctx.validatorName === undefined) throw new Error(`The codec of ${JSON.stringify(id)} validates, and the module names no validators to import.`);
  return ctx.validatorName(id);
}

/**
 * True when the fast check `fast` answers for `value`: no validation context decides instead (spec 7.1). The test is
 * written in each model's function, not in a shared runtime helper, so each call of a fast check sees one check only
 * and V8 can inline it.
 */
function fastPasses(fast: string, value: string): string {
  return `options?.validationContext === undefined && ${fast}(${value})`;
}

/** Whether `value` passes the validator of `reference`, from the fast check first when the root has one (spec 7.1). */
function validModelValueCall(ctx: EmitCtx, reference: string): string {
  const fast = ctx.fastCheckName?.(reference);
  const slow = `isValidModelValue(value, options, ${validatorReference(ctx, reference)}, ${JSON.stringify(reference)})`;
  return fast === undefined ? slow : `(${fastPasses(fast, 'value')}) || ${slow}`;
}

function emitModelGuard(
  node: SchemaNode,
  value: string,
  plane: ValidationPlane,
  ctx: EmitCtx,
): string {
  const wire = plane === 'wire' && !node.sameSchema;
  const representation = plane === 'wire' || plane === 'wire-only' ? 'Wire' : 'Model';
  const reference = plane === 'model-only' || plane === 'wire-only'
    ? `${node.codecId}#${plane}`
    : wire ? `${node.codecId}#wire` : node.codecId;
  // A valid value passes the fast check first, unless a validation context decides (spec 7.1).
  const fast = ctx.fastCheckName?.(reference);
  const slow = `assertModelValue(${value}, options, ${validatorReference(ctx, reference)}, ${JSON.stringify(reference)}, IssueRepresentation.${representation}, IssueSource.${ctx.issueSource});`;
  return fast === undefined ? slow : `if (!(${fastPasses(fast, value)})) ${slow}`;
}

function emitNodeRuntime(
  node: SchemaNode,
  moduleCtx: EmitCtx,
  validationEnabled: boolean,
): string {
  if (node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference') {
    const imported = node.descriptor.kind === 'generated-model'
      ? moduleCtx.nestedImportedSerde?.(node.codecId) ?? moduleCtx.nestedImportedSerde?.(node.id)
      : undefined;
    if (imported) return '';
    const id = JSON.stringify(node.codecId);
    return [
      emitStringifyFunction(node, moduleCtx.graph, moduleCtx.serde),
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

  const ctx: EmitCtx = {
    ...moduleCtx,
    effects: { fallible: 0 },
    hoisted: { prefix: node.id, names: new Map(), sources: [] },
    fillThrows: moduleCtx.fillThrows ?? new Map(),
  };
  // The validated call of a codec whose wire and model schemas agree runs this function after its check, so it keeps the
  // all-required fast path and a call with validation off runs a lenient copy. Any other call is lenient.
  const checkedCore = validationEnabled && node.sameSchema;
  const stringifySrc = emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, withoutOptions: true, lenientRoot: !checkedCore });
  const lenientSource = checkedCore ? emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, withoutOptions: true, lenientRoot: true }) : stringifySrc;
  const lenientStringify = lenientSource === stringifySrc ? '' : lenientSource.replace(`function ${stringifyFunctionName(node.id)}(`, `function ${stringifyFunctionName(node.id)}Lenient(`);
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
  // A validator and an encoder walk a cyclic value under a recursive model until the stack ends.
  const reachesCycle = reachesRecursion(node.descriptor, ctx);
  const recursiveNode = reachesNode(node.descriptor, node.id, ctx) && !passesValueOn(node.descriptor, objectDescriptor !== undefined);
  const guardInline = node.descriptor.kind === 'union' && reachesNode(node.descriptor, node.id, ctx);
  const encodedStringifyContext: EmitCtx = { ...ctx, inlineLocals: new Set(), guardInline };
  const encodedWireContext: EmitCtx = { ...ctx, inlineLocals: new Set(), guardInline };
  const encodedExpr = objectDescriptor
    ? emitEncodedRecord(objectDescriptor, 'value', encodedStringifyContext)
    : emitEncodeValue(node.descriptor, '(value as never)', encodedStringifyContext);
  const encodedRecordExpr = objectDescriptor
    ? emitEncodedRecord(objectDescriptor, 'record', encodedWireContext)
    : emitEncodeValue(node.descriptor, '(value as never)', encodedWireContext);
  const wireStringifySrc = emitsValidatedWire
    ? `${emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, wireIdentity: true, withoutOptions: true })
      .replace(`function ${stringifyName}(`, `function ${stringifyName}Wire(`)}${exported !== '' && (typeof ctx.exportWireStringify === 'function' ? ctx.exportWireStringify(node) : ctx.exportWireStringify === true)
      ? `export { ${stringifyName}Wire as ${wireStringifyExportName(node.codecId)} };\n`
      : ''}`
    : '';

  const wrappedStringify = [
    stringifySrc.replace(`function ${stringifyName}(`, `function ${stringifyName}Core(`),
    lenientStringify,
    wireStringifySrc,
    `${exported}function ${stringifyName}(value: ${modelType}, options?: ${SERDE_OPTIONS}): string {`,
    emitSerdeValidates(validationEnabled),
    ...(emitsValidatedWire ? inlineLocalDeclarations(encodedStringifyContext) : []),
    ...(validationEnabled ? [
      '  if (validates) {',
      ...(reachesCycle ? ['    assertAcyclicEncodeInput(value);'] : []),
      `    ${assertName}(value, options);`,
      ...(emitsValidatedWire ? [
        `    const wire = ${encodedExpr};`,
        // The full model check already ran; check only the JSON encoding produced.
        ...(node.wireOnlyJsonSchema !== undefined ? [`    ${wireOnlyAssertName(node)}(wire, options);`] : []),
        `    return ${stringifyName}Wire(wire as never);`,
      ] : lenientStringify ? [`    return ${stringifyName}Core(value as never);`] : []),
      '  }',
    ] : []),
    lenientStringify
      ? `  return (options as Record<symbol, unknown> | undefined)?.[${CHECKED_KEY}] === true ? ${stringifyName}Core(value as never) : ${stringifyName}Lenient(value as never);`
      : `  return ${stringifyName}Core(value as never);`,
    '}',
    '',
  ].join('\n');

  const fill = objectDescriptor ? emitFillFunction(node, ctx, objectDescriptor) : undefined;
  const fillSrc = fill?.source ?? '';
  const rootScope: EmitCtx = { ...ctx, decodeLocals: [] };
  // The wire of a node that is not an object is `unknown`; `access` reads a property of a name `wire` as a record.
  const decodedExpr = objectDescriptor
    ? undefined
    : emitDecodeValue(node.descriptor, 'wire', rootScope).replaceAll('wire[', '(wire as Record<string, unknown>)[');

  const convertLines: string[] = [
    `function ${convertName}(wire: unknown, options: ${SERDE_OPTIONS} | undefined): unknown {`,
    emitSerdeValidates(validationEnabled),
  ];
  if (validationEnabled) {
    const wireAssertCall = `${node.sameSchema ? assertName : wireAssertName}(wire, options);`;
    convertLines.push(
      '  if (validates) {',
      // A validator walks a cyclic value under a recursive model until the stack ends. A valid value pays nothing: the
      // cycle walk runs only after the validator failed, and reports the cycle in place of the failure.
      ...(reachesCycle
        ? ['    try {', `      ${wireAssertCall}`, '    } catch (error) {', '      assertWireAcyclic(wire);', '      throw error;', '    }']
        : [`    ${wireAssertCall}`]),
      '  }',
    );
  }
  if (objectDescriptor) {
    // A constructed model starts from one copy of the input; fill reads each property from that copy.
    // A recursive model also registers the input itself, so a cycle back to it is found at the first repeat.
    const recursive = objectDescriptor !== undefined && reachesNode(objectDescriptor, node.id, ctx);
    const constructed = fill?.needsFill
      ? [
        `      const copy = { ...${asRecord('wire')} };`,
        ...(recursive ? ['      beginDecode(wire);', '      try {'] : []),
        `      result = Reflect.construct(options.construct, [${fillName}(copy, copy${fill.copyIdentity ? ', false' : ''})]);`,
        ...(recursive ? ['      } finally {', '        endDecode(wire);', '      }'] : []),
      ]
      : [`      result = Reflect.construct(options.construct, [{ ...${asRecord('wire')} }]);`];
    convertLines.push(
      '  let result: unknown = wire;',
      "  if (wire !== null && typeof wire === 'object' && !Array.isArray(wire)) {",
      '    if (options?.construct) {',
      ...constructed,
      '    } else {',
      `      result = ${fillName}({} as Record<string, unknown>, wire as Record<string, unknown>);`,
      '    }',
      '  }',
    );
  } else {
    // Values the result shares with the input are checked here; a model's fill checks its own fields.
    if (sharesInput(node.descriptor, ctx)) convertLines.push('  assertWireAcyclic(wire);');
    if (rootScope.decodeLocals?.length) convertLines.push(`  let ${rootScope.decodeLocals.map((name) => `${name}: unknown`).join(', ')};`);
    convertLines.push(`  const result = ${decodedExpr && decodedExpr !== 'wire' ? decodedExpr : 'wire'};`);
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
    `  return decodeCheckedInput(${convertName}, wire, options)${fieldsType ? ` as ${fieldsType}` : ''};`,
    '}',
    '',
  ];

  const wireType = ctx.wireType?.(node);

  // The wire encoding without validation: nested trusted calls and the validating wrapper both run it.
  const toWireCore = `${toWire}Core`;
  // A model with no field and no extra names writes `{}` and reads nothing from the value.
  const readsRecord = objectDescriptor !== undefined && encodedRecordExpr !== '{}';
  const toWireCoreSource = [
    `function ${toWireCore}(${readsRecord || !objectDescriptor ? 'value' : '_value'}: ${fieldsType ?? 'unknown'}): ${wireType ?? 'unknown'} {`,
    ...(readsRecord ? ['  const record = value as Record<string, unknown>;'] : []),
    ...inlineLocalDeclarations(encodedWireContext),
    `  const wire = ${encodedRecordExpr};`,
    wireType ? `  return wire as ${wireType};` : '  return wire;',
    '}',
    '',
  ].join('\n');
  const toWireCoreLines = [recursiveNode ? guardEncodeCycle(toWireCoreSource) : toWireCoreSource];
  const toWireLines = [
    ...toWireCoreLines,
    `${exported}function ${toWire}(value: ${fieldsType ?? 'unknown'}, options?: ${SERDE_OPTIONS}): ${wireType ?? 'unknown'} {`,
    emitSerdeValidates(validationEnabled),
    ...(validationEnabled ? [
      '  if (validates) {',
      ...(reachesCycle ? ['    assertAcyclicEncodeInput(value);'] : []),
      `    ${assertName}(value, options);`,
      '  }',
    ] : []),
    ...(validationEnabled && node.wireOnlyJsonSchema !== undefined ? [
      `  const wire = ${toWireCore}(value);`,
      '  if (validates) {',
      `    ${wireOnlyAssertName(node)}(wire, options);`,
      '  }',
      '  return wire;',
    ] : [`  return ${toWireCore}(value);`]),
    '}',
    '',
  ];

  const parseLines = [
    `${exported}function ${parseName}(text: string, options?: ${SERDE_OPTIONS}): ${fieldsType ?? 'unknown'} {`,
    `  return decodeDetachedInput(${convertName}, parseJson(text), options)${fieldsType ? ` as ${fieldsType}` : ''};`,
    '}',
    '',
  ];

  const validateLines = validationEnabled
    ? [
      `${exported}function ${validateName}(value: unknown, options?: ${VALIDATE_OPTIONS}): value is ${modelType} {`,
      `  return ${validModelValueCall(ctx, node.codecId)};`,
      '}',
      '',
      `${exported}function ${assertName}(value: unknown, options?: ${VALIDATE_OPTIONS}): ${modelType} {`,
      `  ${emitModelGuard(node, 'value', 'model', ctx)}`,
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

  const planeAssert = (name: string, plane: ValidationPlane): string[] => [
    `function ${name}(value: unknown, options?: ${VALIDATE_OPTIONS}): Record<string, unknown> {`,
    `  ${emitModelGuard(node, 'value', plane, ctx)}`,
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

  const resolved = (id: string): string | undefined => ctx.resolvedSchemasExpr !== undefined && validationEnabled
    ? `${ctx.resolvedSchemasExpr}[${JSON.stringify(id)}] as object`
    : undefined;
  const modelSchemaExpr = resolved(node.codecId)
    ?? `${jsonDataExpression(schemaPayload(node.modelJsonSchema ?? node.jsonSchema, node.codecId))} as object`;
  const wireSchemaExpr = node.sameSchema
    ? undefined
    : resolved(`${node.codecId}#wire`)
      ?? `${jsonDataExpression(schemaPayload(node.jsonSchema, `${node.codecId}#wire`))} as object`;
  const residualSchemaExpr = (plane: 'model-only' | 'wire-only'): string | undefined => {
    const residual = plane === 'model-only' ? node.modelOnlyJsonSchema : node.wireOnlyJsonSchema;
    if (residual === undefined || !validationEnabled) return undefined;
    const id = `${node.codecId}#${plane}`;
    return resolved(id) ?? `${jsonDataExpression(schemaPayload(residual, id))} as object`;
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
    ...(objectDescriptor ? [`  fields: ${JSON.stringify(Object.keys(objectDescriptor.properties))},`] : []),
    `  fromWireFormat: ${fromWire},`,
    `  schema: ${modelSchemaExpr},`,
    ...(wireSchemaExpr ? [`  wireSchema: ${wireSchemaExpr},`] : []),
    ...(modelOnlySchemaExpr ? [`  modelOnlySchema: ${modelOnlySchemaExpr},`] : []),
    ...(wireOnlySchemaExpr ? [`  wireOnlySchema: ${wireOnlySchemaExpr},`] : []),
    ...(resolved(node.codecId) !== undefined ? ['  schemaRefsResolved: true,'] : []),
    `  issueSource: IssueSource.${ctx.issueSource},`,
    '});',
    '',
  ];

  return [ctx.hoisted?.sources.join('\n') ?? '', fillSrc, wrappedStringify, convertLines.join('\n'), fromWireLines.join('\n'), toWireLines.join('\n'), parseLines.join('\n'), validateLines.join('\n'), wireAssertLines.join('\n'), codec.join('\n')].join('\n');
}

function schemaPayload(schema: JsonSchema, id: string): object {
  if (typeof schema === 'boolean') {
    return schema ? { $id: id } : { $id: id, not: true };
  }
  return { $id: id, ...schema };
}

function jsonDataExpression(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Generated schema data is not JSON serializable.');
  return `JSON.parse(${JSON.stringify(json)})`;
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

/** Specialized stringify/parse/validate and codec registration for every graph node. */
export function emitCodecRuntime(
  graph: SchemaGraph,
  options: CodecRuntimeOptions = {},
): string {
  const defaultEnabled = options.validationEnabled !== false;
  const validates = (node: SchemaNode): boolean => nodeValidates(node, defaultEnabled);
  const nodes = [...graph.topo()];
  const ctx: EmitCtx = {
    graph,
    // emitNodeRuntime emits stringify<Id>Wire exactly for these nodes.
    wireStringifyIds: new Set(nodes.filter((node) => !isExternalCodecNode(node) && validates(node) && !node.sameSchema).map((node) => node.id)),
    // emitNodeRuntime emits stringify<Id>Core and toWireFormat<Id>Core for every node that is not external.
    localCoreIds: new Set(nodes.filter((node) => !isExternalCodecNode(node)).map((node) => node.id)),
    strictCoreIds: new Set(nodes.filter((node) => !isExternalCodecNode(node) && validates(node) && node.sameSchema).map((node) => node.id)),
    trustedOptions: TRUSTED_CONSTANT,
    siblingWireCodecIds: options.siblingWireCodecIds,
    siblingRecursion: options.siblingRecursion,
    exportWireStringify: options.exportWireStringify,
    validatorName: options.validatorName,
    fastCheckName: options.fastCheckName,
    resolvedSchemasExpr: options.resolvedSchemasExpr,
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
    fillThrows: new Map(),
  };
  const lines: string[] = [];
  for (const node of nodes) {
    const runtime = emitNodeRuntime(node, ctx, validates(node));
    if (runtime) lines.push(runtime);
  }
  return withModuleConstants(lines.join('\n'));
}

/** One frozen object of each kind serves every nested call that passes options to another module's function. */
function withModuleConstants(runtime: string): string {
  const constants = [
    ...(runtime.includes(TRUSTED_CONSTANT) ? [`const ${TRUSTED_CONSTANT} = Object.freeze({ validate: false });`] : []),
    ...(runtime.includes(CHECKED_KEY) || runtime.includes(CHECKED_CONSTANT) ? [`const ${CHECKED_KEY} = Symbol.for('@exprtlabs/golem:checked');`] : []),
    ...(runtime.includes(CHECKED_CONSTANT) ? [`const ${CHECKED_CONSTANT} = Object.freeze({ validate: false, [${CHECKED_KEY}]: true });`] : []),
  ];
  return constants.length ? `${constants.join('\n')}\n\n${runtime}` : runtime;
}
