/**
 * Emit specialized JSON stringify/parse functions from a schema graph.
 * Nested nodes compose by call; bodies are never inlined twice. TSerde and
 * Date convert in the same pass as concat / JSON.parse.
 */

import type { ModelTypeDescriptor } from '../model.js';
import type { ValidationPlane } from '../object-codec.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX } from '../schema-keywords.js';
import type { SchemaGraph, SchemaNode } from './schema-graph.js';
import { codecShortName, serdeWireDescriptor } from './schema-graph.js';
import type { JsonSchema } from './schema.js';
import { modelName, requireComposedObject, type ModelBases } from './composition.js';
import {
  aliased, asObjectLiteral, bindInput, bindRead, code, helper, helperName, helperSet, identifier, indentation, inputCount, inputOf, inputSlot, isEmpty, join, literal, readShape, sameCode,
  type Code, type Helper, type InputSlot, type JsonValue, type ReadShape,
} from './code.js';
import { rt, rtType } from './rt.js';
import { emitArrayConversion, emitTupleConversion, JSON_SCALAR } from './sequence-conversion.js';
import {
  AmbiguousUnionConversionError,
  descriptorNeedsConversion,
  isScalarishDescriptor,
  discriminatorMatch,
  emitDispatch,
  emitUnionConversion,
  keyIsListed,
  keyIsNotListed,
  literalDiscriminator,
  ObjectUnionDiscriminatorError,
  objectValueExpression,
  presentKeysCode,
  presentUnionIndices,
  presentValueCode,
  unionDispatch,
  type DispatchOptions,
  type ObjectTypeDescriptor,
  type UnionConversion,
  type UnionTypeDescriptor,
} from './union-conversion.js';

export interface StringifySerdeResolver {
  readonly deserialize: (id: string, value: Code) => Code;
  readonly serialize: (id: string, value: Code) => Code;
}

/** The functions of a codec that another module generated, as the names this module imports them under. */
export interface NestedImportedSerde {
  readonly stringify: Code;
  readonly fromWire: Code;
  readonly toWire: Code;
  /** Direct generated helper for converted anonymous object dependencies. */
  readonly fill?: Code;
}

export interface CodecRuntimeOptions {
  readonly validationEnabled?: boolean;
  /**
   * The name the module imports the validator of a root under; the root is a codec id and plane (`Id`, `Id#wire`,
   * `Id#model-only`, `Id#wire-only`). The name is Code that holds an imported part, so the file imports the validators its code uses.
   */
  readonly validatorName?: (id: string) => Code;
  /**
   * The name the module imports the fast check of a root under, by the same keys; undefined for a root that has none,
   * which keeps the validator's route. Called once for each use, as `validatorName` is.
   */
  readonly fastCheckName?: (id: string) => Code | undefined;
  /**
   * The names the module imports the structure check and the predicates-only pass of a root under, by the same keys;
   * undefined for a root that has none (it has a fast check, or runs the validator). Called once for each use.
   */
  readonly passCheckNames?: (id: string) => { readonly structure: Code; readonly predicates: Code } | undefined;
  /** Expression of a record of the validation plan's resolved schemas by the same keys. A validated codec publishes these as its schemas; without it the codec carries its own unresolved payload. */
  readonly resolvedSchemasExpr?: Code;
  readonly serde?: StringifySerdeResolver;
  readonly nestedConstruct?: (name: string, className?: string) => Code;
  readonly nestedGenerated?: (id: string) => Code | undefined;
  /** The codec id of the model that a schema placeholder names, so the runtime resolves it by an exact lookup. */
  readonly generatedModelCodecId?: (name: string) => string | undefined;
  readonly nestedImportedSerde?: (id: string) => NestedImportedSerde | undefined;
  /** The name of the wire stringify that the companion of a sibling codec exports; without it, `wireStringifyExportName`. */
  readonly siblingWireName?: (codecId: string) => Code;
  /** Internal fill helpers needed by other generated graph modules. */
  readonly exportedFillFunctionIds?: ReadonlySet<string>;
  readonly issueSource?: 'TypeScript' | 'OpenAPI';
  /** Type expression of a local node's emitted JSON type; `toWireFormat${id}` returns it. */
  readonly wireType?: (node: SchemaNode) => Code | undefined;
  /** Type expression of a local node's decoded value: parse, fromWireFormat, validate and assert produce it; stringify and toWireFormat accept it. */
  readonly fieldsType?: (node: SchemaNode) => Code | undefined;
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
  /**
   * The bases the generator declares for each model, by model name; without it, the bases come from the intersection that the
   * model's node holds.
   */
  readonly modelBases?: ModelBases;
}

/** The options of the module that every function of it reads, plus the state of the function being emitted. */
interface EmitCtx
  extends Pick<
    CodecRuntimeOptions,
    | 'validatorName'
    | 'fastCheckName'
    | 'passCheckNames'
    | 'resolvedSchemasExpr'
    | 'serde'
    | 'nestedConstruct'
    | 'generatedModelCodecId'
    | 'nestedGenerated'
    | 'nestedImportedSerde'
    | 'siblingWireName'
    | 'exportedFillFunctionIds'
    | 'wireType'
    | 'fieldsType'
    | 'siblingWireCodecIds'
    | 'siblingRecursion'
    | 'exportWireStringify'
    | 'exportAnonymousCodecs'
    | 'privateCodec'
    | 'modelBases'
  > {
  readonly graph: SchemaGraph;
  /** The node is a recursive union: each inline array, tuple and object branch of its encoders checks its value for a cycle. */
  readonly guardInline?: boolean;
  readonly issueSource: 'TypeScript' | 'OpenAPI';
  readonly wireIdentity?: boolean;
  /** An object root writes each field it holds, and a missing required field is no error: validation did not run. */
  readonly lenientRoot?: boolean;
  /** Nodes whose `stringify<Id>Wire` function this module emits; wire stringify calls them instead of inlining. */
  readonly wireStringifyIds?: ReadonlySet<string>;
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
  readonly trustedOptions?: Code;
  /** Emit stringify functions that take no options; they only run trusted. */
  readonly withoutOptions?: boolean;
  /** Counts the conversions emitted for the current node that can throw; see `fallibleConversion`. */
  readonly effects?: { fallible: number };
  /** Module-level converter functions of the current node; without it a converter is emitted inline. */
  readonly hoisted?: HoistedConverters;
  /** Whether the fill of a local node can throw, by node id. */
  readonly fillThrows?: Map<string, boolean>;
  /** The name of the module constant of each patternProperties pattern, by pattern text; the module declares them all once. */
  readonly patternConstants?: Map<string, Code>;
  /** Locals a decoder assigns; the function that holds the decoder declares them. Without it the decoder re-reads. */
  readonly decodeLocals?: string[];
  /**
   * Reads a union above holds in a local; a decoder below reads the input of the read where it would read the property.
   * A read is known by the text of its expression, so a scope that binds a new parameter (an item, a field source, a
   * hoisted converter) starts with none.
   */
  readonly knownReads?: readonly KnownRead[];
  /** The name of the function a stringify emitter writes, when it is not `stringify<Id>`: the module decides it before the body. */
  readonly functionName?: string;
  /** The root input of a decoder whose wire is `unknown`: a property of it is cast where it is read. */
  readonly castWire?: InputSlot;
}

/** The read of `property` of the decoded `expression`, which the union above binds to its local once the variants are written. */
interface KnownRead {
  readonly expression: Code;
  readonly property: string;
  readonly input: InputSlot;
}

interface HoistedConverters {
  readonly prefix: string;
  /** The hoisted bodies with their function names, so an equal body finds its function again. */
  readonly bodies: { readonly body: Code; readonly name: string }[];
  readonly sources: Code[];
}

const TRUSTED = code`{ validate: false }`;
const STRINGIFY_OPTIONS = code`_options?: { readonly validate?: boolean; readonly failFast?: boolean }`;
/** Declared once per emitted module that passes trusted options to a function in another module. */
const TRUSTED_HELPER: Helper = helper('__golemTrusted', () => code`const __golemTrusted = Object.freeze({ validate: false });`);
/**
 * The options of a nested call whose caller already checked the whole value. The mark is a symbol key from the global
 * symbol registry, so options a user writes or parses from JSON cannot carry it by accident, and every generated module
 * reads the same key. A function that has a lenient copy runs its all-required fast path for it, and any other options
 * run the lenient copy.
 */
const CHECKED_KEY_HELPER: Helper = helper('__golemMark', () => code`const __golemMark = Symbol.for('@exprtlabs/golem:checked');`);
const CHECKED_HELPER: Helper = helper('__golemChecked', () => code`const __golemChecked = Object.freeze({ validate: false, [${helperName(CHECKED_KEY_HELPER)}]: true });`);
// Generated modules import these as `type ValidateOptions as __GolemValidateOptions` and
// `type SerdeOptions as __GolemSerdeOptions` from @exprtlabs/golem/serde.
const VALIDATE_OPTIONS = aliased(rtType.serde.ValidateOptions, '__GolemValidateOptions');
const SERDE_OPTIONS = aliased(rtType.serde.SerdeOptions, '__GolemSerdeOptions');

function trustedOptions(ctx: EmitCtx): Code {
  return ctx.trustedOptions ?? TRUSTED;
}

/** The wire stringify of a sibling codec: the name the file imports it under. */
function siblingWireCall(codecId: string, ctx: EmitCtx): Code {
  return ctx.siblingWireName ? ctx.siblingWireName(codecId) : identifier(wireStringifyExportName(codecId));
}

/** A nested stringify call that skips validation: the node's Core function when this module emits it. */
function nestedStringifyCall(id: string, expression: Code, ctx: EmitCtx): Code {
  const value = expression;
  if (ctx.localCoreIds?.has(id) && !(ctx.lenientRoot && ctx.strictCoreIds?.has(id))) {
    return code`${identifier(`${stringifyFunctionName(id)}Core`)}(${value} as never)`;
  }
  const options = ctx.trustedOptions !== undefined && !ctx.lenientRoot ? helperName(CHECKED_HELPER) : trustedOptions(ctx);
  const imported = ctx.nestedImportedSerde?.(id);
  return code`${imported ? imported.stringify : identifier(stringifyFunctionName(id))}(${value} as never, ${options})`;
}

/** A nested toWireFormat call that skips validation: the node's Core function when this module emits it. */
function nestedToWireCall(id: string, expression: Code, ctx: EmitCtx): Code {
  const value = expression;
  return ctx.localCoreIds?.has(id)
    ? code`${identifier(`${toWireFunctionName(id)}Core`)}(${value} as never)`
    : code`${ctx.nestedImportedSerde?.(id)?.toWire ?? identifier(toWireFunctionName(id))}(${value} as never, ${trustedOptions(ctx)})`;
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

/** Whether the code is one input that stands for a record, whose properties a read takes without a cast. */
export function isRecordExpression(expression: Code): boolean {
  const [only, ...more] = expression.parts;
  return only?.kind === 'input' && more.length === 0 && only.slot.record;
}

/**
 * The read of a property of `expression`, and the shape of that read. A record that is not a plain name is cast first.
 * `bare` says the expression is already a record; a caller that reads through an input part of its own passes it.
 */
function accessRead(expression: Code, name: string, bare: boolean = isRecordExpression(expression)): { readonly read: Code; readonly shape: ReadShape } {
  const value = expression;
  const read = code`${bare ? value : code`(${value} as Record<string, unknown>)`}[${literal(name)}]`;
  return { read, shape: bare && readShape(value) === 'name' ? 'chain' : 'other' };
}

/**
 * The read of a property of a decoded expression, and its shape: the input of a read that a union above holds in a local, a
 * cast read of the root `wire`, or the read itself.
 */
function decodeRead(ctx: EmitCtx, expression: Code, name: string): { readonly read: Code; readonly shape: ReadShape } {
  const value = expression;
  const known = ctx.knownReads?.find((candidate) => candidate.property === name && sameCode(candidate.expression, value));
  if (known) return { read: inputOf(known.input), shape: known.input.shape };
  if (ctx.castWire && sameCode(value, inputOf(ctx.castWire))) return { read: code`(${inputOf(ctx.castWire)} as Record<string, unknown>)[${literal(name)}]`, shape: 'chain' };
  return accessRead(value, name);
}

function emitJsonLiteral(value: unknown): Code {
  if (value === null) return code`'null'`;
  if (value === true) return code`'true'`;
  if (value === false) return code`'false'`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON literal numbers must be finite.');
    return literal(value);
  }
  if (typeof value === 'string') return literal(JSON.stringify(value));
  return code`${rt.serde.stringifyJsonScalar}(${literal(value as JsonValue)} as never)`;
}

function memberPrefix(name: string, leadingComma: boolean): Code {
  return literal(`${leadingComma ? ',' : ''}${JSON.stringify(name)}:`);
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
  expression: Code,
  ctx: EmitCtx,
): Code {
  const chunks = properties.map(([name, property], index) => emitInlineObjectField(
    name,
    property,
    true,
    expression,
    index,
    index > 0,
    ctx,
  ));
  return code`${join(chunks, code` + `)} + '}'`;
}

/** The member of one field. Its piece reads the field as an input; the piece reads a local when it reads it more than once. */
function emitInlineObjectField(
  name: string,
  property: ModelTypeDescriptor,
  required: boolean,
  expression: Code,
  index: number,
  leadingComma: boolean,
  ctx: EmitCtx,
): Code {
  const { read, shape } = accessRead(expression, name);
  const input = inputSlot(name, shape);
  const piece = emitValue(property, inputOf(input), ctx);
  const localName = `__golemInlineField${ctx.inlineLocals?.size ?? index}`;
  const local = identifier(localName);
  // An optional field reads its input once more, in the `!== undefined` test.
  const bound = bindRead(piece, input, read, local, required ? 0 : 1);
  const member = code`${memberPrefix(name, leadingComma)} + ${bound.code}`;
  if (!bound.local) return required ? member : code`(${read} !== undefined ? ${member} : '')`;
  ctx.inlineLocals?.add(localName);
  return required
    ? code`(${local} = ${read}, ${member})`
    : code`(${local} = ${read}, (${local} !== undefined ? ${member} : ''))`;
}

function inlineLocalLines(ctx: EmitCtx): Code[] {
  return [...(ctx.inlineLocals ?? [])].map((name) => code`  let ${identifier(name)}: unknown;`);
}

/**
 * The wire write of a recursive model met again inside its own inline write. A model of another module has its wire
 * stringify imported; one with no encoded value under it writes as the model does; any other has no function to call.
 */
function emitRecursiveWireCall(named: SchemaNode, expression: Code, ctx: EmitCtx): Code {
  if (ctx.siblingWireCodecIds?.has(named.codecId)) return code`${siblingWireCall(named.codecId, ctx)}(${expression} as never)`;
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
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  if (descriptor.kind === 'generated-model') {
    const named = ctx.graph.nodeFor(descriptor);
    if (named) {
      return nestedStringifyCall(named.id, value, ctx);
    }
    return code`${rt.serde.stringifyJsonScalar}(${rt.conversion.encodeGeneratedModel}(${value}) as never)`;
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    const wire = serdeWireDescriptor(descriptor) ?? { kind: 'unknown' as const };
    if (ctx.wireIdentity) return emitValue(wire, value, ctx);
    const serialized = ctx.serde
      ? ctx.serde.serialize(tags.serde.id, value)
      : value;
    return emitValue(wire, serialized, ctx);
  }
  const named = ctx.graph.nodeFor(descriptor);
  if (named?.siblingCodec && ctx.wireIdentity) {
    // An encoded wire value of a sibling codec: its companion's wire stringify writes it.
    return ctx.siblingWireCodecIds?.has(named.codecId)
      ? code`${siblingWireCall(named.codecId, ctx)}(${value} as never)`
      : nestedStringifyCall(named.id, value, ctx);
  }
  if (named && isObjectish(descriptor)) {
    if (
      ctx.wireIdentity
      && (named.descriptor.kind === 'object' || (descriptor.kind === 'reference' && descriptor.projection === true))
      && (descriptorNeedsConversion(named.descriptor) || !named.sameSchema)
    ) {
      // Call the node's own wire stringify: inlining would repeat the child for
      // every path to it and never terminate for a recursive model.
      if (ctx.wireStringifyIds?.has(named.id)) return code`${identifier(`${stringifyFunctionName(named.id)}Wire`)}(${value} as never)`;
      if (ctx.wireInlining?.has(named.id)) return emitRecursiveWireCall(named, value, ctx);
      const inlining = { ...ctx, wireInlining: new Set([...(ctx.wireInlining ?? []), named.id]) };
      return named.descriptor.kind === 'object'
        ? emitObjectInline(named.descriptor, value, inlining)
        : emitValue(named.descriptor, value, inlining);
    }
    return nestedStringifyCall(named.id, value, ctx);
  }
  if (descriptor.kind === 'date' || tags.date) {
    if (ctx.wireIdentity) return code`${rt.serde.stringifyJsonString}(${value} as string)`;
    return code`${rt.serde.stringifyJsonString}(${rt.conversion.serializeDate}(${value}))`;
  }
  if (descriptor.kind === 'string') return code`${rt.serde.stringifyJsonString}(${value} as string)`;
  if (descriptor.kind === 'number') return code`${rt.serde.stringifyJsonNumber}(${value} as number)`;
  if (descriptor.kind === 'boolean') return code`${rt.serde.stringifyJsonBoolean}(${value} as boolean)`;
  if (descriptor.kind === 'null') return code`'null'`;
  if (descriptor.kind === 'literal') return emitJsonLiteral(descriptor.value);
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, value, {
      output: 'json',
      item: (item, itemValue) => {
        const itemNode = ctx.graph.nodeFor(item);
        return {
          code: itemNode && isObjectish(item) && !ctx.wireIdentity
            ? nestedStringifyCall(itemNode.id, itemValue, ctx)
            : emitValue(item, itemValue, ctx),
          throws: false,
        };
      },
    });
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, value, {
      output: 'json',
      item: (item, itemValue) => ({ code: emitValue(item, itemValue, ctx), throws: false }),
    });
  }
  if (descriptor.kind === 'union') return emitUnionValue(descriptor, value, ctx);
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return nestedStringifyCall(node.id, value, ctx);
    return emitObjectInline(descriptor, value, ctx);
  }
  return code`${rt.serde.stringifyJsonScalar}(${value} as never)`;
}

function emitObjectInline(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  const required = new Set(descriptor.required);
  const properties = Object.entries(descriptor.properties);
  const hasExtras = typeof descriptor.additionalProperties === 'object' || descriptor.additionalPropertiesDeclared;
  // An object with no declared field writes `{}`, unless it declares its other names as data.
  if (properties.length === 0 && !hasExtras) return code`'{}'`;
  if (isPlainDataMap(descriptor)) return code`${rt.serde.stringifyJsonScalar}(${value} as never)`;
  if (hasExtras) {
    // The other names are data: the encoded record keeps them, and a wire value is already encoded.
    return code`${rt.serde.stringifyJsonScalar}(${ctx.wireIdentity ? value : emitEncodedRecord(descriptor, value, ctx)} as never)`;
  }
  if (properties.every(([name]) => required.has(name))) {
    return code`'{' + ${emitRequiredObjectConcat(properties, value, ctx)}`;
  }
  // Each present member carries its comma before it, so the first comma is cut off and no list is built when the code runs.
  const parts = properties.map(([name, property], index) => emitInlineObjectField(
    name,
    property,
    required.has(name),
    value,
    index,
    true,
    ctx,
  ));
  return code`'{' + (${join(parts, code` + `)}).slice(1) + '}'`;
}

function stringifyParameters(value: Code, ctx: EmitCtx): Code {
  return ctx.withoutOptions ? value : code`${value}, ${STRINGIFY_OPTIONS}`;
}

/** The header of a stringify function, given the name of its value parameter. */
type StringifyHeader = (parameter: Code) => Code;

function stringifyHeader(name: Code, type: Code, ctx: EmitCtx): StringifyHeader {
  return (parameter) => code`function ${name}(${stringifyParameters(code`${parameter}: ${type}`, ctx)}): string {`;
}

/** The body lines of a stringify function with the cycle guard around them when the node reaches itself. */
function guardedBody(body: readonly Code[], guard: boolean, value: InputSlot): Code[] {
  const open = guard ? [code`  ${rt.conversion.beginEncode}(${inputOf(value)});`, code`  try {`] : [];
  const close = guard ? [code`  } finally {`, code`    ${rt.conversion.endEncode}(${inputOf(value)});`, code`  }`] : [];
  return [...open, ...body, ...close];
}

/**
 * A stringify function: its header, its body lines, and the cycle guard around the body when the node reaches itself.
 * The guard registers the value while the body writes it, so a value that holds itself throws at its first repeat. The
 * parameter is `value` when the body reads it and `_value` when it does not: the callers pass it either way, and a
 * parameter that nothing reads fails a build with noUnusedParameters.
 */
function stringifyFunction(header: StringifyHeader, body: readonly Code[], guard: boolean, value: InputSlot): Code {
  const lines = guardedBody(body, guard, value);
  const parameter = identifier(lines.some((line) => inputCount(line, value) > 0) ? 'value' : '_value');
  return bindInput(functionCode(header(parameter), lines), value, parameter);
}

/** A function: its header, its body lines and the closing brace. */
function functionCode(header: Code, body: readonly Code[]): Code {
  return join([header, ...body, code`}`, code``], code`\n`);
}

/** `build` written against the cast read `(value as never)` of `value`, the read of the parameter. */
function onCastValue(build: (cast: Code) => Code, value: Code = code`value`): Code {
  const cast = inputSlot('value as never', 'other');
  return bindInput(build(inputOf(cast)), cast, code`(${value} as never)`);
}

/** The schema of the values of a map with no declared field, or undefined for any other object. */
function fieldlessMapValues(descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>): ModelTypeDescriptor | undefined {
  return Object.keys(descriptor.properties).length === 0 && typeof descriptor.additionalProperties === 'object'
    ? descriptor.additionalProperties
    : undefined;
}

/**
 * Whether the object is a map with no declared field whose values are plain data (non-numeric scalars, or lists of
 * them). The keys of a map are data, and plain values hold no model instance and need no conversion, so the native
 * JSON writer writes the value as the encoder would. A number stays out: the native writer turns NaN into null, where
 * the encoder throws on a non-finite number. A map of numbers has its own writer, `isNumberMap`.
 */
function isPlainDataMap(descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>): boolean {
  const isPlainData = (value: ModelTypeDescriptor): boolean => {
    if (descriptorNeedsConversion(value)) return false;
    if (value.kind === 'array') return isPlainData(value.item);
    if (value.kind === 'union') return value.variants.every(isPlainData);
    return value.kind !== 'number' && isScalarishDescriptor(value);
  };
  const values = fieldlessMapValues(descriptor);
  return values !== undefined && isPlainData(values);
}

/**
 * Whether the object is a map with no declared field whose values are plain numbers. It is written by a finite check
 * of each value, which throws on NaN and Infinity as the per-entry writer does, and then by the native JSON writer. A value
 * with a `toJSON` takes the per-entry writer.
 */
function isNumberMap(descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>): boolean {
  const values = fieldlessMapValues(descriptor);
  return values !== undefined && values.kind === 'number' && !descriptorNeedsConversion(values);
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
  guard: boolean,
  value: InputSlot,
): Code {
  const properties = Object.entries(descriptor.properties);
  const header = stringifyHeader(identifier(fn), code`Record<string, unknown>`, ctx);
  const lines: Code[] = [];
  const fields = properties.map(([name, property], index) => {
    const { read } = accessRead(inputOf(value), name);
    const field = identifier(`__golemField${index}`);
    const piece = identifier(`__golemPiece${index}`);
    lines.push(
      code`  const ${field} = ${read};`,
      code`  const ${piece} = ${field} !== undefined ? ${emitValue(property, field, ctx)} : undefined;`,
    );
    return { name, piece, required: descriptor.required.includes(name) };
  });
  // The first required field has no comma before it: a field before it carries its comma after it, and one after it before.
  const first = fields.findIndex((field) => field.required);
  const chunks = fields.map((field, index) => {
    const member = code`${memberPrefix(field.name, index > first)} + ${field.piece}`;
    if (field.required) return member;
    return code`(${field.piece} !== undefined ? ${member}${index < first ? code` + ","` : code``} : '')`;
  });
  const present = join(fields.filter((field) => field.required).map((field) => code`${field.piece} !== undefined`), code` && `);
  lines.push(
    code`  if (${present}) return '{' + ${join(chunks, code` + `)} + '}';`,
    code`  let out = '{';`,
    code`  let sep = false;`,
  );
  for (const field of fields) {
    lines.push(
      code`  if (${field.piece} !== undefined) {`,
      code`    if (sep) out += ",";`,
      code`    out += ${memberPrefix(field.name, false)} + ${field.piece};`,
      code`    sep = true;`,
      code`  }`,
    );
  }
  lines.push(code`  return out + '}';`);
  return stringifyFunction(header, [...inlineLocalLines(ctx), ...lines], guard, value);
}

function emitObjectStringify(
  fn: string,
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  ctx: EmitCtx,
  guard: boolean,
  valueSlot: InputSlot,
): Code {
  const value = inputOf(valueSlot);
  // With validation off a required field can be missing, so a lenient object writes each field that is present.
  const required = new Set(ctx.lenientRoot ? [] : descriptor.required);
  const properties = Object.entries(descriptor.properties);
  const additional = typeof descriptor.additionalProperties === 'object'
    ? descriptor.additionalProperties
    : descriptor.additionalPropertiesDeclared ? { kind: 'unknown' as const } : undefined;
  const name = identifier(fn);
  if (properties.length === 0 && !additional) {
    return stringifyFunction(stringifyHeader(name, code`Record<string, unknown>`, ctx), [code`  return '{}';`], guard, valueSlot);
  }
  const header = stringifyHeader(name, code`Record<string, unknown>`, ctx);
  if (isPlainDataMap(descriptor)) {
    return stringifyFunction(header, [code`  return ${rt.serde.stringifyJsonScalar}(${value} as never);`], guard, valueSlot);
  }
  if (!additional && properties.every(([property]) => required.has(property))) {
    const concatenated = emitRequiredObjectConcat(properties, value, ctx);
    return stringifyFunction(header, [...inlineLocalLines(ctx), code`  return '{' + ${concatenated};`], guard, valueSlot);
  }
  if (ctx.lenientRoot && !additional && properties.some(([property]) => descriptor.required.includes(property))) return emitLenientObjectStringify(fn, descriptor, ctx, guard, valueSlot);
  const lines: Code[] = [
    // The native writer calls a `toJSON` of the value, which the per-entry writer below never does: a value that has one takes that writer.
    ...(isNumberMap(descriptor) ? [
      code`  if (typeof ${value}['toJSON'] !== 'function') {`,
      code`    for (const entry of Object.values(${value})) {`,
      code`      if (entry !== undefined) ${rt.serde.stringifyJsonNumber}(entry as number);`,
      code`    }`,
      code`    return JSON.stringify(${value});`,
      code`  }`,
    ] : []),
    code`  let out = '{';`,
    code`  let sep = false;`,
  ];
  for (const [index, [property, schema]] of properties.entries()) {
    const { read, shape } = accessRead(value, property);
    const input = inputSlot(property, shape);
    const piece = emitValue(schema, inputOf(input), ctx);
    const local = identifier(`__golemValue${index}`);
    // An optional field reads its input once more, in the `!== undefined` test.
    const bound = bindRead(piece, input, read, local, required.has(property) ? 0 : 1);
    const key = memberPrefix(property, false);
    if (bound.local) lines.push(code`  const ${local} = ${read};`);
    if (required.has(property)) {
      lines.push(
        code`  if (sep) out += ",";`,
        code`  out += ${key};`,
        code`  out += ${bound.code};`,
        code`  sep = true;`,
      );
    } else {
      lines.push(
        code`  if (${bound.local ? local : read} !== undefined) {`,
        code`    if (sep) out += ",";`,
        code`    out += ${key};`,
        code`    out += ${bound.code};`,
        code`    sep = true;`,
        code`  }`,
      );
    }
  }
  if (additional) {
    // A schema for the other names: they are written after the listed names, each by that schema. Without one, a declared
    // `additionalProperties: true` makes them data of unknown type.
    lines.push(
      code`  for (const key of Object.keys(${value})) {`,
      ...(properties.length === 0 ? [] : [code`    if (${keyIsListed(identifier('key'), properties.map(([property]) => property))}) continue;`]),
      code`    const __golemExtra = ${value}[key];`,
      code`    if (__golemExtra === undefined) continue;`,
      code`    if (sep) out += ",";`,
      code`    out += ${rt.serde.stringifyJsonString}(key) + ":" + ${emitValue(additional, identifier('__golemExtra'), ctx)};`,
      code`    sep = true;`,
      code`  }`,
    );
  }
  lines.push(code`  return out + '}';`);
  return stringifyFunction(header, [...inlineLocalLines(ctx), ...lines], guard, valueSlot);
}

/** The stringify function of a node. */
export function emitStringifyFunction(
  node: SchemaNode,
  graph: SchemaGraph,
  serde?: StringifySerdeResolver,
  extra?: Partial<EmitCtx>,
): Code {
  const ctx: EmitCtx = {
    graph,
    serde,
    nestedConstruct: extra?.nestedConstruct,
    siblingWireName: extra?.siblingWireName,
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
    modelBases: extra?.modelBases,
    wireInlining: extra?.wireIdentity ? new Set([node.id]) : undefined,
    inlineLocals: new Set(),
    guardInline: !extra?.wireIdentity && node.descriptor.kind === 'union' && reachesNode(node.descriptor, node.id, { graph }),
  };
  const fn = extra?.functionName ?? stringifyFunctionName(node.id);
  const valueSlot = inputSlot('value', 'name', true);
  // An intersection (allOf) is one merged object: the root writes its declared fields, as decode and encode do. With
  // validation off a required field can be missing, so a lenient root writes each field that is present. A checked
  // root, such as the validated wire stringify, keeps the all-required fast path.
  const merged = node.descriptor.kind === 'intersection' && node.descriptor.variants.every(variant => resolveObjectDescriptor(variant, ctx) !== undefined)
    ? resolveObjectDescriptor(node.descriptor, ctx)
    : undefined;
  const root = node.descriptor.kind === 'object' ? node.descriptor : merged;
  const delegates = node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference';
  const startsLevel = !passesValueOn(node.descriptor, root !== undefined);
  const guard = !ctx.wireIdentity && !delegates && startsLevel && reachesNode(node.descriptor, node.id, ctx);
  if (root) return emitObjectStringify(fn, root, ctx, guard, valueSlot);
  if (delegates) {
    return stringifyFunction(
      (parameter) => code`function ${identifier(fn)}(${parameter}: unknown, options?: { readonly validate?: boolean; readonly failFast?: boolean }): string {`,
      [code`  return ${rt.serde.requireObjectCodec}(${literal(node.codecId)}).stringify(${inputOf(valueSlot)} as never, options);`],
      false,
      valueSlot,
    );
  }
  const value = onCastValue((cast) => emitValue(node.descriptor, cast, ctx), inputOf(valueSlot));
  const header = stringifyHeader(identifier(fn), code`unknown`, ctx);
  return stringifyFunction(header, [...inlineLocalLines(ctx), code`  return ${value};`], guard, valueSlot);
}

function asRecordCode(expression: Code): Code {
  return code`(${expression} as Record<string, unknown>)`;
}

function shouldConstructNested(descriptor: ModelTypeDescriptor, ctx: EmitCtx): boolean {
  const node = ctx.graph.nodeFor(descriptor);
  return (descriptor.kind === 'reference' && descriptor.construct === true)
    || (descriptor.kind === 'generated-model' && node?.emitClass === true);
}

function nestedFromWireOptions(descriptor: ModelTypeDescriptor, ctx: EmitCtx): Code {
  if (!shouldConstructNested(descriptor, ctx)) return trustedOptions(ctx);
  const node = ctx.graph.nodeFor(descriptor);
  const id = node?.codecId
    ?? (descriptor.kind === 'reference' ? descriptor.name : descriptor.kind === 'generated-model' ? descriptor.id : undefined);
  if (!id) return trustedOptions(ctx);
  const given = ctx.nestedConstruct?.(id, descriptor.kind === 'reference' ? descriptor.className : undefined);
  const ctor = given === undefined ? code`${rt.serde.requireIModelClass}(${literal(id)})` : given;
  return code`{ validate: false, construct: ${ctor} }`;
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

/**
 * A value that holds no object, so assigning it copies it. It also accepts `never` and an intersection of scalars, which
 * `isScalarishDescriptor` (the JSON-scalar test of the union walkers) does not: a copied closed object may hold them.
 */
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
  expression: Code,
  ctx: EmitCtx,
): Code | undefined {
  const required = new Set(descriptor.required);
  const names = Object.keys(descriptor.properties);
  if (names.length === 0) return undefined;
  if (names.some((name) => name === '__proto__' || !required.has(name))) return undefined;
  if (names.some((name) => !isScalarDescriptor(descriptor.properties[name]))) return undefined;
  return code`(${emitComputedRecord(names.map((name) => ({ name, code: decodeRead(ctx, expression, name).read, spread: false })))})`;
}

/**
 * A conversion that can throw: nested `fill*`/`convertFromWire*`/`fromWireFormat*` calls, trusted model
 * decodes, `Date` and `TSerde` decoders. A caller compares the count across one `emitDecodeValue` to learn
 * whether the expression can throw, since the field then needs to be on the conversion path for the error
 * to report it.
 */
function fallibleConversion(ctx: EmitCtx, call: Code): Code {
  if (ctx.effects) ctx.effects.fallible++;
  return call;
}

function fallibleCount(ctx: EmitCtx): number {
  return ctx.effects?.fallible ?? 0;
}

/** Whether an expression emitted since `before` can throw, so it runs under its field's path. */
function emittedFallible(before: number, decoded: Code, ctx: EmitCtx): boolean {
  return fallibleCount(ctx) !== before
    || decoded.parts.some((part) => part.kind === 'runtime' && part.module === 'conversion' && part.name === 'unknownDiscriminatorValue');
}

/**
 * A decoder of the identifier `input` as a module-level function, so converting a value allocates no closure. `named` says the converter
 * is a function name, which a caller can call on the value instead of writing the decoder in place.
 */
function hoistConverter(input: Code, decoded: Code, locals: readonly string[], ctx: EmitCtx): { readonly converter: Code; readonly named: boolean } {
  if (sameCode(decoded, code`(${input} instanceof Date ? ${input} : ${rt.conversion.deserializeDate}(${input}))`)) {
    return { converter: rt.conversion.deserializeDate, named: true };
  }
  if (!ctx.hoisted) return { converter: code`(${input}) => (${decoded})`, named: false };
  const declarations = locals.length > 0 ? code`  let ${join(locals.map((name) => code`${identifier(name)}: unknown`), code`, `)};\n` : code``;
  const body = code`(${input}: unknown): unknown {\n${declarations}  return (${decoded});\n}\n`;
  const known = ctx.hoisted.bodies.find((candidate) => sameCode(candidate.body, body));
  if (known) return { converter: identifier(known.name), named: true };
  const name = `__golemDecode_${ctx.hoisted.prefix}_${ctx.hoisted.bodies.length}`;
  ctx.hoisted.bodies.push({ body, name });
  ctx.hoisted.sources.push(code`function ${identifier(name)}${body}`);
  return { converter: identifier(name), named: true };
}

/** `convertModelField` for the decoder of `property` written against `local`, with the field value passed in as `input`. */
function emitFieldConversion(field: Code, local: string, property: ModelTypeDescriptor, input: Code, ctx: EmitCtx): Code {
  const scope: EmitCtx = { ...ctx, decodeLocals: [], knownReads: undefined };
  const decoded = emitDecodeValue(property, identifier(local), scope);
  const { converter } = hoistConverter(identifier(local), decoded, scope.decodeLocals ?? [], ctx);
  return code`${rt.conversion.convertModelField}("deserialize", ${field}, ${converter}, ${input})`;
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

function emitInternedObjectDecode(
  node: SchemaNode,
  descriptor: ModelTypeDescriptor,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  if (shouldConstructNested(descriptor, ctx)) {
    const imported = ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id);
    const local = !isExternalCodecNode(node) && !imported;
    const options = nestedFromWireOptions(descriptor, ctx);
    return fallibleConversion(ctx, local
      ? code`${identifier(`convertFromWire${node.id}`)}(${value}, ${options})`
      : code`${imported ? imported.fromWire : identifier(fromWireFunctionName(node.id))}(${value}, ${options})`);
  }
  if (
    node.kind === 'object'
    && node.descriptor.kind === 'object'
    && !descriptorNeedsConversion(node.descriptor)
  ) {
    // An open object or a map is copied by its `fill*`; only a closed object of scalars is one literal.
    const closed = extrasAllowed(node.descriptor) ? undefined : emitClosedIdentityObject(node.descriptor, value, ctx);
    if (closed) return closed;
  }
  if (node.kind === 'object') {
    const imported = ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id);
    const fill = imported?.fill === undefined ? identifier(fillFunctionName(node.id)) : imported.fill;
    const call = code`${fill}({} as Record<string, unknown>, ${asRecordCode(value)})`;
    // A local fill that cannot throw runs without its field's path.
    return imported || fillCanThrow(node, ctx) ? fallibleConversion(ctx, call) : call;
  }
  const importedWire = ctx.nestedImportedSerde?.(node.codecId) ?? ctx.nestedImportedSerde?.(node.id);
  return fallibleConversion(ctx, code`${importedWire ? importedWire.fromWire : identifier(fromWireFunctionName(node.id))}(${value}, ${trustedOptions(ctx)})`);
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

/**
 * The bases the generator declares, read in the names a descriptor uses: a descriptor names a model by its name or by the
 * codec id of its node, so a model's name comes from its node and a base answers under its name and each codec id of that name.
 */
function modelBasesOf({ graph, modelBases }: EmitCtx): ModelBases {
  if (modelBases === undefined) return graphModelBases(graph);
  return {
    basesOf(id) {
      const declared = modelBases.basesOf(graph.nodeFor({ kind: 'reference', name: id })?.name ?? id);
      return declared.flatMap((base) => [base, ...[...graph.nodes.values()].filter((node) => node.name === base).map((node) => node.codecId)]);
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
    return objects.length > 1 ? requireComposedObject(objects, modelBasesOf(ctx)) : objects[0];
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
  const ids = new Set(
    [
      descriptor.kind === 'generated-model' ? descriptor.id : undefined,
      descriptor.kind === 'reference' ? descriptor.name : undefined,
      short,
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

function tagAccess(expression: Code, property: string): Code {
  return code`((${expression}) as Record<string, unknown>)[${literal(property)}]`;
}

/**
 * Dispatch the union variants at `indices` by tag (and by class for a
 * generated model instance). Returns undefined when the variants carry no
 * inferable tag and `unresolved` is 'skip'.
 */
function emitTaggedVariantUnion(
  union: UnionTypeDescriptor,
  indices: readonly number[],
  expression: Code,
  ctx: EmitCtx,
  convert: (variant: ModelTypeDescriptor, scope: EmitCtx) => Code,
  direction: DispatchOptions['direction'],
  options?: { readonly unresolved?: 'throw' | 'skip' },
): Code | undefined {
  const value = expression;
  const variants = indices.map((index) => union.variants[index]);
  const objectFor = (variant: ModelTypeDescriptor) => resolveObjectDescriptor(variant, ctx);
  if (variants.length === 0 || (!union.discriminator && variants.some((variant) => !objectFor(variant)))) return undefined;
  const dispatch = unionDispatch(union, indices, objectFor);
  // A decoder in a function that declares its locals reads the tag once and reuses it in the variant's copy: the variants
  // are decoded with that read known, so they use the local where they would read the tag.
  const tagLocal = dispatch && direction === 'decode' && ctx.decodeLocals && readShape(value) === 'name'
    && variants.every((variant) => variantClassName(variant, ctx) === undefined)
    ? `__golemTag${ctx.decodeLocals.length}`
    : undefined;
  if (tagLocal) ctx.decodeLocals?.push(tagLocal);
  const tag = inputSlot('tag', 'name');
  const scope: EmitCtx = tagLocal && dispatch
    ? { ...ctx, knownReads: [...(ctx.knownReads ?? []), { expression: value, property: dispatch.property, input: tag }] }
    : ctx;
  const conversions = variants.map((variant) => {
    const converted = convert(variant, scope);
    return tagLocal ? bindInput(converted, tag, identifier(tagLocal)) : converted;
  });
  if (!dispatch) {
    if (direction !== 'encode-json' && conversions.every((converted) => sameCode(converted, value))) return value;
    if (options?.unresolved === 'skip') return undefined;
    throw new ObjectUnionDiscriminatorError(variants);
  }
  return emitDispatch({
    expression: value,
    property: dispatch.property,
    direction,
    ...(tagLocal === undefined ? {} : { tagLocal: identifier(tagLocal) }),
    ...(direction === 'encode-json' ? { nullish: code`'null'` } : {}),
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
function variantClassName(variant: ModelTypeDescriptor, ctx: EmitCtx): Code | undefined {
  if (variant.kind === 'generated-model') return ctx.nestedGenerated?.(variant.id);
  return variant.kind === 'reference' && shouldConstructNested(variant, ctx)
    ? ctx.nestedConstruct?.(ctx.graph.nodeFor(variant)?.codecId ?? variant.name, variant.className)
    : undefined;
}

/** Object variants of a union mixed with one generated model; their literal tags must dispatch. */
function emitTaggedObjects(
  union: UnionTypeDescriptor,
  expression: Code,
  ctx: EmitCtx,
  convert: (variant: ModelTypeDescriptor, scope: EmitCtx) => Code,
  direction: DispatchOptions['direction'],
): Code {
  const indices = presentUnionIndices(union).filter((index) => union.variants[index].kind === 'object');
  const converted = emitTaggedVariantUnion(union, indices, expression, ctx, convert, direction);
  if (converted === undefined) throw new ObjectUnionDiscriminatorError(union.variants);
  return converted;
}

/** Match any required literal tag of `objects`, for mixing them with one generated model. */
function objectTagMatch(objects: readonly ObjectTypeDescriptor[], expression: Code, decode: boolean): Code[] {
  // Decoding reads the tag by the JSON view, so an inherited or non-enumerable tag matches no object.
  const read = (name: string): Code => decode
    ? code`(${presentValueCode(expression, literal(name), tagAccess(expression, name))})`
    : tagAccess(expression, name);
  return objects.flatMap((object) => [...literalDiscriminator(object)].map(([name, values]) => discriminatorMatch(read(name), values)));
}

/**
 * The branch of a recursive union that writes an inline array, tuple or object registers its value while it writes, so a
 * value that holds itself throws at its first repeat. A named node guards itself.
 */
function inlineBranchGuard(ctx: EmitCtx, expression: Code): UnionConversion['guard'] {
  if (!ctx.guardInline) return undefined;
  const value = expression;
  return (variant, converted) => ctx.graph.nodeFor(variant)
    ? converted
    : code`(() => { ${rt.conversion.beginEncode}(${value}); try { return ${converted}; } finally { ${rt.conversion.endEncode}(${value}); } })()`;
}

/** What a walker gives `emitUnion`: how it converts a variant, and the steps that only its direction has. */
interface UnionWalker extends Pick<UnionConversion, 'items' | 'joinSequence' | 'beforeGenerated' | 'afterGenerated'> {
  /** The conversion of one variant, against the union's expression. */
  readonly walk: (variant: ModelTypeDescriptor, scope: EmitCtx) => Code;
  /** The conversion of a variant under tagged dispatch, when it differs from `walk`. */
  readonly walkTagged?: (variant: ModelTypeDescriptor, scope: EmitCtx) => Code;
  /** The conversion of the generated model beside tagged objects, when it differs from `walk`. */
  readonly generatedText?: (generated: Extract<ModelTypeDescriptor, { readonly kind: 'generated-model' }>) => Code | undefined;
}

/** The dispatch direction of each union direction. A decoder reads the wire; the others write a value or JSON text. */
const UNION_DISPATCH = { stringify: 'encode-json', decode: 'decode', encode: 'encode-value' } as const;

/**
 * The one option set of the stringify, decode and encode union conversions: the variant conversion, tagged dispatch, and
 * the generated model beside tagged objects, built from the direction and the walker. The walker's own items and steps join it.
 */
function emitUnion(
  direction: keyof typeof UNION_DISPATCH,
  descriptor: UnionTypeDescriptor,
  value: Code,
  ctx: EmitCtx,
  { walk, walkTagged, generatedText, ...steps }: UnionWalker,
): Code {
  const decoding = direction === 'decode';
  const dispatch = UNION_DISPATCH[direction];
  return emitUnionConversion(descriptor, value, direction, {
    ...(decoding ? {} : { guard: inlineBranchGuard(ctx, value) }),
    convert: (variant) => walk(variant, ctx),
    tagged: () => emitTaggedVariantUnion(
      descriptor,
      presentUnionIndices(descriptor),
      value,
      ctx,
      walkTagged ?? walk,
      dispatch,
      decoding ? undefined : { unresolved: 'skip' },
    ),
    generated: {
      text: generatedText ?? ((generated) => walk(generated, ctx)),
      tagMatch: (objects) => objectTagMatch(objects, value, decoding),
      objects: (objects) => decoding
        ? value
        : objects.length === 1
          ? walk(objects[0], ctx)
          : emitTaggedObjects(descriptor, value, ctx, walk, dispatch),
      takesEveryObject: decoding,
    },
    ...steps,
  });
}

function emitUnionValue(
  descriptor: UnionTypeDescriptor,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  let itemsUnchanged = true;
  const plain = code`${rt.serde.stringifyJsonScalar}(${value} as never)`;
  return emitUnion('stringify', descriptor, value, ctx, {
    walk: (variant) => emitValue(variant, value, ctx),
    walkTagged: (variant) => {
      if (!ctx.wireIdentity) {
        const node = ctx.graph.nodeFor(variant);
        if (node && isObjectish(variant)) {
          return nestedStringifyCall(node.id, value, ctx);
        }
      }
      return emitValue(variant, value, ctx);
    },
    items: {
      output: 'json',
      item: (item, itemValue) => {
        const converted = emitValue(item, itemValue, ctx);
        if (!sameCode(converted, JSON_SCALAR)) itemsUnchanged = false;
        return { code: converted, throws: false };
      },
    },
    joinSequence: (items, scalar) => itemsUnchanged && sameCode(scalar, plain)
      ? plain
      : code`(Array.isArray(${value}) ? ${items} : (${scalar}))`,
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
  });
}

/** The decoder of an array item: an item that can throw runs under its index, as a module-level function when it is hoisted. */
function decodeItem(ctx: EmitCtx): (item: ModelTypeDescriptor, value: Code) => { readonly code: Code; readonly throws: boolean } {
  return (item, value) => {
    const before = fallibleCount(ctx);
    const decoded = emitDecodeValue(item, value, { ...ctx, decodeLocals: undefined, knownReads: undefined });
    if (!emittedFallible(before, decoded, ctx)) return { code: decoded, throws: false };
    const scope: EmitCtx = { ...ctx, decodeLocals: [], knownReads: undefined };
    const scoped = emitDecodeValue(item, value, scope);
    const { converter, named } = hoistConverter(value, scoped, scope.decodeLocals ?? [], ctx);
    return { code: named ? code`${converter}(${value})` : scoped, throws: true };
  };
}

function emitUnionDecode(
  descriptor: UnionTypeDescriptor,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  return emitUnion('decode', descriptor, value, ctx, {
    walk: (variant, scope) => emitDecodeValue(variant, value, scope),
    generatedText: (generated) => {
      const name = ctx.nestedGenerated?.(generated.id);
      return name
        ? code`${value} instanceof ${name} ? ${value} : ${fallibleConversion(ctx, code`${rt.conversion.decodeGeneratedModelTrusted}(${name}, ${value})`)}`
        : undefined;
    },
    items: { output: 'value', paths: 'deserialize', item: decodeItem(ctx) },
    afterGenerated: (present) => {
      const refs = present.filter((variant): variant is Extract<ModelTypeDescriptor, { kind: 'reference' }> =>
        variant.kind === 'reference' && variant.construct === true);
      if (refs.length === 0 || refs.length !== present.length) return undefined;
      const branches: Code[] = [];
      for (const ref of refs) {
        const node = ctx.graph.nodeFor(ref);
        const object = node?.descriptor.kind === 'object' ? node.descriptor : undefined;
        if (!object) throw new AmbiguousUnionConversionError(present);
        const tags = objectTagMatch([object], value, true);
        if (tags.length === 0) throw new ObjectUnionDiscriminatorError(present);
        branches.push(code`${join(tags, code` && `)} ? ${emitDecodeValue(ref, value, ctx)}`);
      }
      return code`(${objectValueExpression(value)} ? ${join([...branches, value], code` : `)} : ${value})`;
    },
  });
}

function emitUnionEncode(
  descriptor: UnionTypeDescriptor,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  return emitUnion('encode', descriptor, value, ctx, {
    walk: (variant) => emitEncodeValue(variant, value, ctx),
    items: {
      output: 'value',
      item: (item, itemValue) => ({ code: emitEncodeValue(item, itemValue, ctx), throws: false }),
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

function emitDecodeValue(descriptor: ModelTypeDescriptor, expression: Code, ctx: EmitCtx): Code {
  const value = expression;
  if (descriptor.kind === 'generated-model') {
    const className = ctx.nestedGenerated?.(descriptor.id);
    if (className) return fallibleConversion(ctx, code`${rt.conversion.decodeGeneratedModelTrusted}(${className}, ${value})`);
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    const deserialized = ctx.serde ? fallibleConversion(ctx, ctx.serde.deserialize(tags.serde.id, value)) : value;
    const wire = serdeWireDescriptor(descriptor);
    if (wire?.kind === 'string') {
      return code`(typeof ${value} === 'string' ? ${deserialized} : ${value})`;
    }
    if (wire?.kind === 'number') {
      return code`(typeof ${value} === 'number' ? ${value} : ${deserialized})`;
    }
    if (wire?.kind === 'boolean') {
      return code`(typeof ${value} === 'boolean' ? ${value} : ${deserialized})`;
    }
    if (wire && (wire.kind === 'object' || wire.kind === 'reference' || wire.kind === 'generated-model')) {
      return code`(${objectValueExpression(value)} ? ${deserialized} : ${value})`;
    }
    return deserialized;
  }
  if (descriptor.kind === 'date' || tags.date) {
    return fallibleConversion(ctx, code`(${value} instanceof Date ? ${value} : ${rt.conversion.deserializeDate}(${value}))`);
  }
  if (descriptor.kind === 'union') {
    return emitUnionDecode(descriptor, value, ctx);
  }
  // An intersection of objects decodes as the one merged object, so each member's fields convert.
  const decodedMerge = descriptor.kind === 'intersection' ? requireComposedObject(descriptor.variants, modelBasesOf(ctx)) : undefined;
  if (decodedMerge) return emitDecodeValue(decodedMerge, value, ctx);
  if (descriptor.kind === 'object' && typeof descriptor.additionalProperties === 'object') {
    const listed = Object.keys(descriptor.properties);
    // A node's fill converts each listed name by its own schema and every other name by the additional schema.
    if (listed.length > 0 || !descriptorNeedsConversion(descriptor)) {
      const named = ctx.graph.nodeFor(descriptor);
      if (named) return emitInternedObjectDecode(named, descriptor, value, ctx);
    }
    const before = fallibleCount(ctx);
    const decoded = emitDecodeValue(descriptor.additionalProperties, identifier('value'), { ...ctx, decodeLocals: undefined, knownReads: undefined });
    const entry = emittedFallible(before, decoded, ctx)
      ? emitFieldConversion(identifier('key'), 'value', descriptor.additionalProperties, identifier('value'), ctx)
      : decoded;
    const entries = code`Object.entries((${value} ?? {}) as Record<string, unknown>)`;
    if (listed.length === 0) return code`Object.fromEntries(${entries}.map(([key, value]) => [key, ${entry}]))`;
    const extras = code`Object.fromEntries(${entries}.filter(([key]) => ${keyIsNotListed(identifier('key'), listed)}).map(([key, value]) => [key, ${entry}]))`;
    return asObjectLiteral(code`{ ...${extras}, ...${emitDecodedRecord(descriptor, value, ctx)} }`);
  }
  const named = ctx.graph.nodeFor(descriptor);
  if (named && isObjectish(descriptor)) {
    return emitInternedObjectDecode(named, descriptor, value, ctx);
  }
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, value, { output: 'value', paths: 'deserialize', item: decodeItem(ctx) });
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, value, {
      output: 'value',
      paths: 'deserialize',
      item: (item, itemValue) => {
        const before = fallibleCount(ctx);
        const decoded = emitDecodeValue(item, itemValue, { ...ctx, knownReads: undefined });
        return { code: decoded, throws: emittedFallible(before, decoded, ctx) };
      },
    });
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return emitInternedObjectDecode(node, descriptor, value, ctx);
    return emitDecodedRecord(descriptor, value, ctx);
  }
  return value;
}

/** A field of a record literal: its name and value, or a spread that stands for several fields and is written as it is. */
interface RecordField {
  readonly name: string;
  readonly code: Code;
  readonly spread: boolean;
}

function emitComputedRecord(fields: readonly RecordField[]): Code {
  if (fields.length === 0) return asObjectLiteral(code`{}`);
  return asObjectLiteral(code`{ ${join(fields.map((field) => field.spread ? field.code : code`[${literal(field.name)}]: ${field.code}`), code`, `)} }`);
}

function emitDecodedRecord(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  const fields = Object.entries(descriptor.properties);
  if (fields.length === 0) return value;
  const required = new Set(descriptor.required);
  return emitComputedRecord(fields.map(([name, property]) => {
    const { read, shape } = decodeRead(ctx, value, name);
    const input = inputSlot(name, shape);
    const before = fallibleCount(ctx);
    const decoded = emitDecodeValue(property, inputOf(input), { ...ctx, decodeLocals: undefined });
    // A source property is read once: a conversion that can throw runs under its field's path with the
    // property as its argument, and another conversion binds it to a parameter when it uses it again.
    const converted = emittedFallible(before, decoded, ctx)
      ? emitFieldConversion(literal(name), NESTED_SOURCE, property, read, ctx)
      : inputCount(decoded, input) > 1
        ? code`((${identifier(NESTED_SOURCE)}) => ${emitDecodeValue(property, identifier(NESTED_SOURCE), { ...ctx, knownReads: undefined })})(${read})`
        : bindInput(decoded, input, read);
    // An optional property that converts is read only when the input has it.
    if (!required.has(name) && !sameCode(decoded, inputOf(input))) {
      return { name, code: code`...(${read} !== undefined ? { [${literal(name)}]: ${converted} } : {})`, spread: true };
    }
    return { name, code: converted, spread: false };
  }));
}

/** Parameter of an inline decoder that reads a nested property once; inner decoders shadow it. */
const NESTED_SOURCE = '__golemSource';

function emitFillPropertyWrite(name: string, decoded: Code, indent: number): Code {
  if (name === '__proto__') {
    return code`${indentation(indent)}${rt.conversion.defineModelProperty}(out, ${literal(name)}, ${decoded});`;
  }
  return code`${indentation(indent)}out[${literal(name)}] = ${decoded};`;
}

/** A row of a function body, moved right by `spaces`. */
function indented(row: Code, spaces: number): Code {
  return code`${indentation(spaces)}${row}`;
}

/** Result of emitting how one source property reaches the fill output. */
interface FillValue {
  /** Statements that run before the write; they read the source property once into a local. */
  readonly statements: readonly Code[];
  readonly value: Code;
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
  read: Code,
  shape: ReadShape,
  field: Code,
  local: string,
  ctx: EmitCtx,
): FillValue {
  const before = fallibleCount(ctx);
  const readInput = inputSlot('read', shape);
  const decoded = emitDecodeValue(property, inputOf(readInput), { ...ctx, decodeLocals: undefined });
  const fallible = emittedFallible(before, decoded, ctx);
  const checked = sharesInput(property, ctx);
  const converted = !sameCode(decoded, inputOf(readInput));
  if (!checked && !fallible && inputCount(decoded, readInput) <= 1) {
    return { statements: [], value: bindInput(decoded, readInput, read), converted, checked, fallible };
  }
  const input = checked ? code`${rt.conversion.assertPropertyAcyclic}(wire, ${field}, ${read})` : read;
  if (fallible) {
    return { statements: [], value: emitFieldConversion(field, local, property, input, ctx), converted, checked, fallible };
  }
  return { statements: [code`const ${identifier(local)} = ${input};`], value: emitDecodeValue(property, identifier(local), ctx), converted, checked, fallible };
}

/**
 * The name of the module constant that holds the regular expression of `pattern`, as the validator reads it, with the `u`
 * flag. The module declares one for each pattern text (`withModuleConstants`), so the expression is built once, not for
 * each key of each call. A function name is a verb followed by a node id (`fill<Id>`, `parse<Id>`), so a node id cannot
 * make the name `__golemPattern<N>`, and one pattern text has one name in the whole module.
 */
function patternConstant(ctx: EmitCtx, pattern: string): Code {
  const constants = ctx.patternConstants;
  if (!constants) throw new Error('Internal error: the emitter has no module table for the patternProperties expressions.');
  let name = constants.get(pattern);
  if (!name) {
    name = identifier(`__golemPattern${constants.size}`);
    constants.set(pattern, name);
  }
  return name;
}

function emitFillFunction(
  node: SchemaNode,
  ctx: EmitCtx,
  descriptor: ModelTypeDescriptor = node.descriptor,
): { readonly source: Code; readonly copyIdentity: boolean; readonly needsFill: boolean; readonly fallible: boolean } {
  const fn = identifier(fillFunctionName(node.id));
  const exported = ctx.exportedFillFunctionIds?.has(node.id) ? code`export ` : code``;
  if (descriptor.kind !== 'object') {
    return {
      source: functionCode(code`${exported}function ${fn}(out: Record<string, unknown>, _wire: Record<string, unknown>): Record<string, unknown> {`, [code`  return out;`]),
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
      source: functionCode(code`${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {`, [
        code`  for (const key of Object.keys(wire)) {`,
        code`    const extra = wire[key];`,
        code`    if (extra === undefined) continue;`,
        code`    const value = ${rt.conversion.assertPropertyAcyclic}(wire, key, extra);`,
        code`    if (out !== wire) ${rt.conversion.defineModelProperty}(out, key, value);`,
        code`  }`,
        code`  return out;`,
      ]),
      copyIdentity: false,
      needsFill: true,
      fallible: true,
    };
  }
  const required = new Set(descriptor.required);
  const wireRoot = inputSlot('wire', 'name', true);
  // A recursive node registers the wire it decodes, so a cycle in the input stops at the repeated object.
  const recursive = reachesNode(descriptor, node.id, ctx);
  const identityWrites: Code[] = [];
  const propertyWrites: Code[] = [];
  let copyIdentity = false;
  let needsFill = false;
  // A recursive fill throws on a cycle; a carried value is checked for cycles.
  let fallible = recursive;
  // Fields whose write depends on presence; one Object.keys pass reads them all at the top of the function.
  const captured: [key: string, local: Code][] = [];
  properties.forEach(([name, property], index) => {
    const field = literal(name);
    // The JSON view: a wire field is present when it is own, enumerable and not undefined. Where a write depends on
    // presence, the field is read into a local by the one Object.keys pass; a carried required field reads the wire.
    const optional = !required.has(name);
    const present = `__golemPresent${index}`;
    const presentName = identifier(present);
    const fill = emitFillValue(property, presentName, 'name', field, `__golemWire${index}`, ctx);
    const proto = name === '__proto__';
    if (fill.converted || fill.checked || proto) needsFill = true;
    if (fill.fallible || fill.checked) fallible = true;
    if (!fill.converted && !fill.checked && !proto) {
      copyIdentity = true;
      captured.push([name, presentName]);
      identityWrites.push(
        code`    if (${presentName} !== undefined) {`,
        emitFillPropertyWrite(name, fill.value, 6),
        code`    }`,
      );
      return;
    }
    if (!fill.converted && !proto) {
      // Carried by reference: checked on every call, written only when the caller wants identity fields copied.
      copyIdentity = true;
      const write = (value: Code): Code[] => [code`  if (copyIdentity) {`, emitFillPropertyWrite(name, value, 4), code`  }`];
      if (optional) captured.push([name, presentName]);
      if (!optional) {
        // A required field that is carried reads the wire itself, so it is written against that read.
        const direct = accessRead(inputOf(wireRoot), name);
        const carried = emitFillValue(property, direct.read, direct.shape, field, `__golemWire${index}`, ctx);
        const onWire = (piece: Code): Code => bindInput(piece, wireRoot, code`wire`);
        propertyWrites.push(...carried.statements.map((row) => indented(onWire(row), 2)), ...write(onWire(carried.value)));
      } else {
        propertyWrites.push(
          code`  if (${presentName} !== undefined) {`,
          ...fill.statements.map((row) => indented(row, 4)),
          ...write(fill.value).map((row) => indented(row, 2)),
          code`  }`,
        );
      }
      return;
    }
    captured.push([name, presentName]);
    propertyWrites.push(
      code`  if (${presentName} !== undefined) {`,
      ...fill.statements.map((row) => indented(row, 4)),
      emitFillPropertyWrite(name, fill.value, 4),
      code`  }`,
    );
  });
  const declaration = copyIdentity
    ? code`${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>, copyIdentity = true): Record<string, unknown> {`
    : code`${exported}function ${fn}(out: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {`;
  const rows: Code[] = [
    ...(captured.length > 0 ? [code`  ${presentKeysCode(identifier('wire'), captured, { declare: (local) => code`${local}: unknown` })}`] : []),
    ...(identityWrites.length > 0
      ? [code`  if (copyIdentity) {`, ...identityWrites, code`  }`]
      : []),
    ...propertyWrites,
  ];
  if (additionalSchema || carriesExtras || patternConstraints.length > 0) {
    rows.push(
      code`  for (const key of Object.keys(wire)) {`,
      ...(properties.length > 0 ? [code`    if (${keyIsListed(identifier('key'), properties.map(([name]) => name))}) continue;`] : []),
      // An undeclared key whose value is undefined is absent, as the validator and encode treat it.
      code`    const __golemExtra = wire[key];`,
      code`    if (__golemExtra === undefined) continue;`,
    );
    const emitExtra = (schema: ModelTypeDescriptor | undefined, indent: number): Code[] => {
      // A pattern without a field schema carries the value by reference.
      const value: FillValue = schema === undefined
        ? { statements: [], value: code`${rt.conversion.assertPropertyAcyclic}(wire, key, __golemExtra)`, converted: false, checked: true, fallible: true }
        : emitFillValue(schema, identifier('__golemExtra'), 'name', identifier('key'), '__golemValue', ctx);
      if (value.converted || value.checked) needsFill = true;
      if (value.fallible || value.checked) fallible = true;
      return [
        ...value.statements.map((row) => indented(row, indent)),
        indented(code`${rt.conversion.defineModelProperty}(out, key, ${value.value});`, indent),
      ];
    };
    for (const pattern of patternConstraints) {
      if (pattern.kind !== 'patternProperties') continue;
      const schema = typeof pattern.schema === 'object' && pattern.schema !== null && 'kind' in pattern.schema
        ? pattern.schema as ModelTypeDescriptor
        : undefined;
      rows.push(
        code`    if (${patternConstant(ctx, pattern.pattern)}.test(key)) {`,
        ...emitExtra(schema, 6),
        code`      continue;`,
        code`    }`,
      );
    }
    if (additionalSchema && typeof additionalSchema === 'object' && additionalSchema !== null && 'kind' in additionalSchema) {
      rows.push(...emitExtra(additionalSchema as ModelTypeDescriptor, 4));
    }
    if (carriesExtras) rows.push(...emitExtra(undefined, 4));
    rows.push(code`  }`);
  }
  rows.push(code`  return out;`);
  const body = recursive
    ? [code`  ${rt.conversion.beginDecode}(wire);`, code`  try {`, ...rows.map((row) => indented(row, 2)), code`  } finally {`, code`    ${rt.conversion.endDecode}(wire);`, code`  }`]
    : rows;
  return { source: functionCode(declaration, body), copyIdentity, needsFill, fallible };
}

function emitEncodeValue(descriptor: ModelTypeDescriptor, expression: Code, ctx: EmitCtx): Code {
  const value = expression;
  if (descriptor.kind === 'generated-model') {
    const named = ctx.graph.nodeFor(descriptor);
    if (named) {
      return nestedToWireCall(named.id, value, ctx);
    }
    return code`${rt.conversion.encodeGeneratedModel}(${value})`;
  }
  const tags = serdeTags(descriptor);
  if (tags.serde) {
    return ctx.serde ? ctx.serde.serialize(tags.serde.id, value) : value;
  }
  if (descriptor.kind === 'date' || tags.date) return code`${rt.conversion.serializeDate}(${value})`;
  const named = ctx.graph.nodeFor(descriptor);
  if (named && isObjectish(descriptor)) {
    return nestedToWireCall(named.id, value, ctx);
  }
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, value, {
      output: 'value',
      item: (item, itemValue) => ({ code: emitEncodeValue(item, itemValue, ctx), throws: false }),
    });
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, value, {
      output: 'value',
      item: (item, itemValue) => ({ code: emitEncodeValue(item, itemValue, ctx), throws: false }),
    });
  }
  const encodedMerge = descriptor.kind === 'intersection' ? requireComposedObject(descriptor.variants, modelBasesOf(ctx)) : undefined;
  if (encodedMerge) return emitEncodeValue(encodedMerge, value, ctx);
  if (descriptor.kind === 'union') {
    return emitUnionEncode(descriptor, value, ctx);
  }
  if (descriptor.kind === 'object') {
    const node = ctx.graph.nodeFor(descriptor);
    if (node) return nestedToWireCall(node.id, value, ctx);
    return emitEncodedRecord(descriptor, value, ctx);
  }
  // An intersection with a member that is no object is written as it is, without the program state of a model instance.
  if (descriptor.kind === 'intersection') return code`${rt.serde.withoutInstanceState}(${value})`;
  // A value of unknown type can hold a model instance at any depth.
  if (descriptor.kind === 'unknown' || descriptor.kind === 'any') return code`${rt.serde.withoutInstanceState}(${value})`;
  return value;
}

function emitEncodedRecord(
  descriptor: Extract<ModelTypeDescriptor, { kind: 'object' }>,
  expression: Code,
  ctx: EmitCtx,
): Code {
  const value = expression;
  const fields = Object.entries(descriptor.properties);
  const required = new Set(descriptor.required);
  // The record reads its own input: the expression is read once per field, and bound to a local when that is more than once.
  const bare = isRecordExpression(value);
  const self = inputSlot('record', readShape(value));
  const values = fields.map(([name, property], index): RecordField => {
    const { read, shape } = accessRead(inputOf(self), name, bare);
    const input = inputSlot(name, shape);
    const encoded = emitEncodeValue(property, inputOf(input), ctx);
    // An optional field whose value is undefined is omitted, as stringify and JSON.stringify do.
    if (!required.has(name)) {
      const local = identifier(allocateInlineLocal(ctx, '__golemField') ?? `__golemField${index}`);
      const entry = code`(${local} !== undefined ? { [${literal(name)}]: ${bindInput(encoded, input, local)} } : undefined)`;
      return { name, code: ctx.inlineLocals ? code`...(${local} = ${read}, ${entry})` : code`...((${local}) => ${entry})(${read})`, spread: true };
    }
    if (inputCount(encoded, input) <= 1) return { name, code: bindInput(encoded, input, read), spread: false };
    const allocated = allocateInlineLocal(ctx, '__golemField');
    if (!allocated) {
      const fallbackLocal = identifier(`__golemField${index}`);
      return { name, code: code`((${fallbackLocal}) => ${bindInput(encoded, input, fallbackLocal)})(${read})`, spread: false };
    }
    const local = identifier(allocated);
    return { name, code: code`(${local} = ${read}, ${bindInput(encoded, input, local)})`, spread: false };
  });
  // A schema for the other names: they are kept and encoded by it. Without one, a declared `additionalProperties: true`
  // keeps them as they are. Any other object writes its listed names only.
  const additional = typeof descriptor.additionalProperties === 'object' ? descriptor.additionalProperties : undefined;
  const extra = inputSlot('extra', 'name');
  const keyParameter = fields.length === 0 ? code`` : code`key`;
  const unlisted = fields.length === 0 ? code`` : code` && ${keyIsNotListed(identifier('key'), fields.map(([name]) => name))}`;
  const extras = additional || descriptor.additionalPropertiesDeclared
    ? [code`...Object.fromEntries(Object.entries(${asRecordCode(inputOf(self))}).filter(([${keyParameter}, extra]) => extra !== undefined${unlisted}).map(([key, extra]) => [key, ${bindInput(emitEncodeValue(additional ?? { kind: 'unknown' }, inputOf(extra), ctx), extra, code`extra`)}]))`]
    : [];
  const entries = [...extras, ...values.map((field) => field.spread ? field.code : code`[${literal(field.name)}]: ${field.code}`)];
  const record = entries.length === 0 ? code`{}` : code`{ ${join(entries, code`, `)} }`;
  // Inline nested records can receive a getter expression from their parent.
  // Bind that object only when its expression would otherwise be evaluated
  // more than once; ordinary top-level `value`/`record` paths stay direct.
  if (readShape(value) === 'name' || inputCount(record, self) <= 1) return asObjectLiteral(bindInput(record, self, value));
  const allocated = allocateInlineLocal(ctx, '__golemRecord');
  if (!allocated) {
    const fallbackLocal = identifier('__golemRecord');
    return code`((${fallbackLocal}) => (${bindInput(record, self, fallbackLocal)}))(${value})`;
  }
  const local = identifier(allocated);
  return code`(${local} = ${value}, ${bindInput(record, self, local)})`;
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

function emitSerdeValidates(validationEnabled: boolean): Code {
  return validationEnabled
    ? code`  const validates = ${rt.serde.serdeValidates}(options, true);`
    : code`  ${rt.serde.serdeValidates}(options, false);`;
}

function validatorReference(ctx: EmitCtx, id: string): Code {
  if (ctx.validatorName === undefined) throw new Error(`The codec of ${JSON.stringify(id)} validates, and the module names no validators to import.`);
  return ctx.validatorName(id);
}

/**
 * The validator a site runs for `value`. A root with a structure check and a predicates-only pass runs the pass when
 * the structure is valid and no validation context decides, so each predicate runs once and never before the full
 * validator on a failing structure; any other value, and any other root, runs the full validator.
 */
function validatorFor(ctx: EmitCtx, reference: string, value: Code): Code {
  const full = validatorReference(ctx, reference);
  const pass = ctx.passCheckNames?.(reference);
  return pass === undefined ? full : code`options?.validationContext === undefined && ${pass.structure}(${value}) ? ${pass.predicates} : ${full}`;
}

/**
 * True when the fast check `fast` answers for `value`: no validation context decides instead. The test is
 * written in each model's function, not in a shared runtime helper, so each call of a fast check sees one check only
 * and V8 can inline it.
 */
function fastPasses(fast: Code, value: Code): Code {
  return code`options?.validationContext === undefined && ${fast}(${value})`;
}

/** Whether `value` passes the validator of `reference`, from the fast check first when the root has one. */
function validModelValueCall(ctx: EmitCtx, reference: string): Code {
  const fast = ctx.fastCheckName?.(reference);
  const slow = code`${rt.serde.isValidModelValue}(value, options, ${validatorFor(ctx, reference, code`value`)}, ${literal(reference)})`;
  return fast === undefined ? slow : code`(${fastPasses(fast, code`value`)}) || ${slow}`;
}

function emitModelGuard(
  node: SchemaNode,
  value: Code,
  plane: ValidationPlane,
  ctx: EmitCtx,
): Code {
  const wire = plane === 'wire' && !node.sameSchema;
  const representation = plane === 'wire' || plane === 'wire-only' ? 'Wire' : 'Model';
  const reference = plane === 'model-only' || plane === 'wire-only'
    ? `${node.codecId}#${plane}`
    : wire ? `${node.codecId}#wire` : node.codecId;
  // A valid value passes the fast check first, unless a validation context decides.
  const fast = ctx.fastCheckName?.(reference);
  const slow = code`${rt.serde.assertModelValue}(${value}, options, ${validatorFor(ctx, reference, value)}, ${literal(reference)}, ${rt.serde.IssueRepresentation}.${identifier(representation)}, ${rt.serde.IssueSource}.${identifier(ctx.issueSource)});`;
  return fast === undefined ? slow : code`if (!(${fastPasses(fast, value)})) ${slow}`;
}

/** The rows of a block, one to a line. */
function rowsToText(rows: readonly Code[]): Code {
  return join(rows, code`\n`);
}

/** The blocks of a file, one after another. A block that writes nothing leaves no blank line. */
function blocksToText(blocks: readonly Code[]): Code {
  return join(blocks.filter((block) => !isEmpty(block)), code`\n`);
}

interface NodeFields {
  /** The fields type the generator names, when it names one. */
  readonly code: Code | undefined;
  readonly orUnknown: Code;
  readonly modelType: Code;
}

/** What the output sections of one node's runtime share: its function names, its emission context and the facts about its model. */
interface NodeRuntime {
  readonly node: SchemaNode;
  readonly ctx: EmitCtx;
  readonly validationEnabled: boolean;
  readonly names: { readonly fromWire: Code; readonly toWire: Code; readonly parse: Code };
  readonly stringifyId: Code;
  readonly validateId: Code;
  readonly assertId: Code;
  readonly wireAssertId: Code;
  readonly modelOnlyAssertId: Code;
  readonly wireOnlyAssertId: Code;
  readonly convertId: Code;
  /** `export ` when the node's functions are exported, else nothing. */
  readonly exported: Code;
  /** The type of the node's fields. Built at its first call: the type it names can declare an import, so the call decides the import order. */
  readonly fields: () => NodeFields;
  /** The merged object of an object or an allOf-style intersection of objects, which converts field by field. */
  readonly objectDescriptor: ObjectTypeDescriptor | undefined;
  /** A validator and an encoder walk a cyclic value under a recursive model until the stack ends. */
  readonly reachesCycle: boolean;
  readonly guardInline: boolean;
}

/** The runtime of a node whose codec another module owns: a stringify function and calls to the registered object codec. */
function emitExternalNodeRuntime(node: SchemaNode, moduleCtx: EmitCtx): Code {
  const imported = node.descriptor.kind === 'generated-model'
    ? moduleCtx.nestedImportedSerde?.(node.codecId) ?? moduleCtx.nestedImportedSerde?.(node.id)
    : undefined;
  if (imported) return code``;
  const id = literal(node.codecId);
  return rowsToText([
    emitStringifyFunction(node, moduleCtx.graph, moduleCtx.serde, { modelBases: moduleCtx.modelBases }),
    code`export function ${identifier(fromWireFunctionName(node.id))}(wire: unknown, options?: ${SERDE_OPTIONS}): unknown {`,
    code`  return ${rt.serde.requireObjectCodec}(${id}).fromWireFormat(wire, options);`,
    code`}`,
    code``,
    code`export function ${identifier(toWireFunctionName(node.id))}(value: unknown, options?: ${SERDE_OPTIONS}): unknown {`,
    code`  return ${rt.serde.requireObjectCodec}(${id}).toWireFormat(value as never, options);`,
    code`}`,
    code``,
    code`export function ${identifier(parseFunctionName(node.id))}(text: string, options?: ${SERDE_OPTIONS}): unknown {`,
    code`  return ${rt.serde.requireObjectCodec}(${id}).parse(text, options);`,
    code`}`,
  ]);
}

function nodeFields(fieldsType: Code | undefined): NodeFields {
  return { code: fieldsType, orUnknown: fieldsType ?? code`unknown`, modelType: fieldsType ?? code`Record<string, unknown>` };
}

function codecIsExported(node: SchemaNode, ctx: EmitCtx): boolean {
  return !((node.anonymous && !ctx.exportAnonymousCodecs) || ctx.privateCodec?.(node));
}

/** The `value` parameter of the exported functions of a node. */
const VALUE_REF = code`value`;

/** The context of an encoding that writes its locals inline: each section that encodes gets its own set of locals. */
function encodedContext({ ctx, guardInline }: NodeRuntime): EmitCtx {
  return { ...ctx, inlineLocals: new Set(), guardInline };
}

function nodeRuntime(node: SchemaNode, moduleCtx: EmitCtx, validationEnabled: boolean): NodeRuntime {
  const ctx: EmitCtx = {
    ...moduleCtx,
    effects: { fallible: 0 },
    hoisted: { prefix: node.id, bodies: [], sources: [] },
    fillThrows: moduleCtx.fillThrows ?? new Map(),
  };
  let fields: NodeFields | undefined;
  // An allOf-style intersection of objects (including referenced models) converts
  // as the merged object, so inherited fields such as dates are decoded too.
  const objectDescriptor = node.descriptor.kind === 'object'
    ? node.descriptor
    : node.descriptor.kind === 'intersection'
      && node.descriptor.variants.every(variant => resolveObjectDescriptor(variant, ctx) !== undefined)
      ? resolveObjectDescriptor(node.descriptor, ctx)
      : undefined;
  return {
    node,
    ctx,
    validationEnabled,
    names: {
      fromWire: identifier(fromWireFunctionName(node.id)),
      toWire: identifier(toWireFunctionName(node.id)),
      parse: identifier(parseFunctionName(node.id)),
    },
    stringifyId: identifier(stringifyFunctionName(node.id)),
    validateId: identifier(validateFunctionName(node.id)),
    assertId: identifier(`assert${node.id}`),
    wireAssertId: identifier(`__golemAssertWire_${node.id}`),
    modelOnlyAssertId: identifier(modelOnlyAssertName(node)),
    wireOnlyAssertId: identifier(wireOnlyAssertName(node)),
    convertId: identifier(`convertFromWire${node.id}`),
    exported: codecIsExported(node, ctx) ? code`export ` : code``,
    fields: () => (fields ??= nodeFields(ctx.fieldsType?.(node))),
    objectDescriptor,
    reachesCycle: reachesRecursion(node.descriptor, ctx),
    guardInline: node.descriptor.kind === 'union' && reachesNode(node.descriptor, node.id, ctx),
  };
}

/** The stringify function of a node, with the lenient and wire copies it needs, and the checked wrapper that calls them. */
function emitStringifySection(runtime: NodeRuntime): Code {
  const { node, ctx, validationEnabled, stringifyId, assertId, wireOnlyAssertId, exported, objectDescriptor } = runtime;
  // The validated call of a codec whose wire and model schemas agree runs this function after its check, so it keeps the
  // all-required fast path and a call with validation off runs a lenient copy. Any other call is lenient.
  const checkedCore = validationEnabled && node.sameSchema;
  const stringifyName = stringifyFunctionName(node.id);
  const coreId = identifier(`${stringifyName}Core`);
  const lenientId = identifier(`${stringifyName}Lenient`);
  const wireId = identifier(`${stringifyName}Wire`);
  const stringifySrc = emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, withoutOptions: true, lenientRoot: !checkedCore, functionName: `${stringifyName}Core` });
  const lenientCore = checkedCore ? emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, withoutOptions: true, lenientRoot: true, functionName: `${stringifyName}Core` }) : stringifySrc;
  const lenientStringify = sameCode(lenientCore, stringifySrc)
    ? undefined
    : emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, withoutOptions: true, lenientRoot: true, functionName: `${stringifyName}Lenient` });
  const { modelType } = runtime.fields();
  const emitsValidatedWire = validationEnabled && !node.sameSchema;
  const encoded = encodedContext(runtime);
  const stringifyValue = inputSlot('value', 'name', true);
  // The validated wire write is the only reader of the encoding, and it fills the inline locals that `encoded` declares.
  const encodedExpr = emitsValidatedWire
    ? objectDescriptor
      ? bindInput(emitEncodedRecord(objectDescriptor, inputOf(stringifyValue), encoded), stringifyValue, code`value`)
      : onCastValue((cast) => emitEncodeValue(node.descriptor, cast, encoded))
    : undefined;
  const exportsWire = codecIsExported(node, ctx) && (typeof ctx.exportWireStringify === 'function' ? ctx.exportWireStringify(node) : ctx.exportWireStringify === true);
  const wireStringifySrc = emitsValidatedWire
    ? code`${emitStringifyFunction(node, ctx.graph, ctx.serde, { ...ctx, wireIdentity: true, withoutOptions: true, functionName: `${stringifyName}Wire` })}${exportsWire
      ? code`export { ${wireId} as ${identifier(wireStringifyExportName(node.codecId))} };\n`
      : code``}`
    : code``;

  return rowsToText([
    blocksToText([stringifySrc, lenientStringify ?? code``, wireStringifySrc]),
    code`${exported}function ${stringifyId}(value: ${modelType}, options?: ${SERDE_OPTIONS}): string {`,
    emitSerdeValidates(validationEnabled),
    ...(emitsValidatedWire ? inlineLocalLines(encoded) : []),
    ...(validationEnabled ? [
      code`  if (validates) {`,
      ...(runtime.reachesCycle ? [code`    ${rt.conversion.assertAcyclicEncodeInput}(value);`] : []),
      code`    ${assertId}(value, options);`,
      ...(encodedExpr ? [
        code`    const wire = ${encodedExpr};`,
        // The full model check already ran; check only the JSON encoding produced.
        ...(node.wireOnlyJsonSchema !== undefined ? [code`    ${wireOnlyAssertId}(wire, options);`] : []),
        code`    return ${wireId}(wire as never);`,
      ] : lenientStringify ? [code`    return ${coreId}(value as never);`] : []),
      code`  }`,
    ] : []),
    lenientStringify
      ? code`  return (options as Record<symbol, unknown> | undefined)?.[${helperName(CHECKED_KEY_HELPER)}] === true ? ${coreId}(value as never) : ${lenientId}(value as never);`
      : code`  return ${coreId}(value as never);`,
    code`}`,
    code``,
  ]);
}

/** The decode section: the fill function of an object model, the conversion from the wire, and the exported fromWireFormat. */
function emitDecodeSection(runtime: NodeRuntime): { readonly fill: Code; readonly convert: Code; readonly fromWire: Code } {
  const {
    node, ctx, validationEnabled, names, assertId, wireAssertId, modelOnlyAssertId, convertId, exported,
    objectDescriptor, reachesCycle,
  } = runtime;
  const fillId = identifier(fillFunctionName(node.id));
  const fill = objectDescriptor ? emitFillFunction(node, ctx, objectDescriptor) : undefined;
  const wireRoot = inputSlot('wire', 'name', true);
  const rootScope: EmitCtx = { ...ctx, decodeLocals: [], castWire: wireRoot };
  // The wire of a node that is not an object is `unknown`; a read of the root `wire` casts it where it reads.
  const decodedExpr = objectDescriptor
    ? undefined
    : bindInput(emitDecodeValue(node.descriptor, inputOf(wireRoot), rootScope), wireRoot, code`wire`);

  const convertLines: Code[] = [
    code`function ${convertId}(wire: unknown, options: ${SERDE_OPTIONS} | undefined): unknown {`,
    emitSerdeValidates(validationEnabled),
  ];
  if (validationEnabled) {
    const wireAssertCall = code`${node.sameSchema ? assertId : wireAssertId}(wire, options);`;
    convertLines.push(
      code`  if (validates) {`,
      // A validator walks a cyclic value under a recursive model until the stack ends. A valid value pays nothing: the
      // cycle walk runs only after the validator failed, and reports the cycle in place of the failure.
      ...(reachesCycle
        ? [code`    try {`, code`      ${wireAssertCall}`, code`    } catch (error) {`, code`      ${rt.conversion.assertWireAcyclic}(wire);`, code`      throw error;`, code`    }`]
        : [code`    ${wireAssertCall}`]),
      code`  }`,
    );
  }
  if (objectDescriptor) {
    // A constructed model starts from one copy of the input; fill reads each property from that copy.
    // A recursive model also registers the input itself, so a cycle back to it is found at the first repeat.
    const recursive = reachesNode(objectDescriptor, node.id, ctx);
    const wireRecord = asRecordCode(code`wire`);
    const constructed = fill?.needsFill
      ? [
        code`      const copy = { ...${wireRecord} };`,
        ...(recursive ? [code`      ${rt.conversion.beginDecode}(wire);`, code`      try {`] : []),
        code`      result = Reflect.construct(options.construct, [${fillId}(copy, copy${fill.copyIdentity ? code`, false` : code``})]);`,
        ...(recursive ? [code`      } finally {`, code`        ${rt.conversion.endDecode}(wire);`, code`      }`] : []),
      ]
      : [code`      result = Reflect.construct(options.construct, [{ ...${wireRecord} }]);`];
    convertLines.push(
      code`  let result: unknown = wire;`,
      code`  if (wire !== null && typeof wire === 'object' && !Array.isArray(wire)) {`,
      code`    if (options?.construct) {`,
      ...constructed,
      code`    } else {`,
      code`      result = ${fillId}({} as Record<string, unknown>, wire as Record<string, unknown>);`,
      code`    }`,
      code`  }`,
    );
  } else {
    // Values the result shares with the input are checked here; a model's fill checks its own fields.
    if (sharesInput(node.descriptor, ctx)) convertLines.push(code`  ${rt.conversion.assertWireAcyclic}(wire);`);
    if (rootScope.decodeLocals?.length) convertLines.push(code`  let ${join(rootScope.decodeLocals.map((name) => code`${identifier(name)}: unknown`), code`, `)};`);
    convertLines.push(code`  const result = ${decodedExpr ?? code`wire`};`);
  }
  if (validationEnabled && node.modelOnlyJsonSchema !== undefined) {
    // The full wire check already ran; check only what decoding produced.
    convertLines.push(
      code`  if (validates) {`,
      code`    ${modelOnlyAssertId}(result, options);`,
      code`  }`,
    );
  }
  convertLines.push(code`  return result;`, code`}`, code``);

  const fields = runtime.fields();
  return {
    fill: fill?.source ?? code``,
    convert: rowsToText(convertLines),
    fromWire: rowsToText([
      code`${exported}function ${names.fromWire}(wire: unknown, options?: ${SERDE_OPTIONS}): ${fields.orUnknown} {`,
      code`  return ${rt.conversion.decodeCheckedInput}(${convertId}, wire, options)${fields.code ? code` as ${fields.code}` : code``};`,
      code`}`,
      code``,
    ]),
  };
}

/** The toWireFormat core, which nested trusted calls and the validating wrapper both run, and the exported wrapper. */
function emitToWireSection(runtime: NodeRuntime): Code {
  const { node, ctx, validationEnabled, names, assertId, wireOnlyAssertId, exported, objectDescriptor, reachesCycle } = runtime;
  const fieldsOrUnknown = runtime.fields().orUnknown;
  const toWireCoreId = identifier(`${toWireFunctionName(node.id)}Core`);
  const recursiveNode = reachesNode(node.descriptor, node.id, ctx) && !passesValueOn(node.descriptor, objectDescriptor !== undefined);
  const encoded = encodedContext(runtime);
  const toWireValue = inputSlot('value', 'name', true);
  const toWireRecord = inputSlot('record', 'name', true);
  const encodedRecordExpr = objectDescriptor
    ? emitEncodedRecord(objectDescriptor, inputOf(toWireRecord), encoded)
    : onCastValue((cast) => emitEncodeValue(node.descriptor, cast, encoded), inputOf(toWireValue));
  const wireType = ctx.wireType?.(node);
  const wireOrUnknown = wireType ?? code`unknown`;

  // The wire encoding without validation: nested trusted calls and the validating wrapper both run it.
  // A model with no field and no extra names writes `{}` and reads nothing from the value.
  // The function reads `record` only when an entry of the encoded record does, and `value` only when it or the guard does.
  const readsRecord = inputCount(encodedRecordExpr, toWireRecord) > 0;
  const toWireCoreBody = [
    ...(readsRecord ? [code`  const record = ${inputOf(toWireValue)} as Record<string, unknown>;`] : []),
    ...inlineLocalLines(encoded),
    code`  const wire = ${bindInput(encodedRecordExpr, toWireRecord, code`record`)};`,
    wireType ? code`  return wire as ${wireType};` : code`  return wire;`,
  ];
  // A recursive node registers the value while the body writes it, so a value that holds itself throws at its first repeat.
  const toWireCoreSource = stringifyFunction(
    (parameter) => code`function ${toWireCoreId}(${parameter}: ${fieldsOrUnknown}): ${wireOrUnknown} {`,
    toWireCoreBody,
    recursiveNode,
    toWireValue,
  );
  return rowsToText([
    toWireCoreSource,
    code`${exported}function ${names.toWire}(value: ${fieldsOrUnknown}, options?: ${SERDE_OPTIONS}): ${wireOrUnknown} {`,
    emitSerdeValidates(validationEnabled),
    ...(validationEnabled ? [
      code`  if (validates) {`,
      ...(reachesCycle ? [code`    ${rt.conversion.assertAcyclicEncodeInput}(value);`] : []),
      code`    ${assertId}(value, options);`,
      code`  }`,
    ] : []),
    ...(validationEnabled && node.wireOnlyJsonSchema !== undefined ? [
      code`  const wire = ${toWireCoreId}(value);`,
      code`  if (validates) {`,
      code`    ${wireOnlyAssertId}(wire, options);`,
      code`  }`,
      code`  return wire;`,
    ] : [code`  return ${toWireCoreId}(value);`]),
    code`}`,
    code``,
  ]);
}

function emitParseSection(runtime: NodeRuntime): Code {
  const { names, convertId, exported } = runtime;
  const fields = runtime.fields();
  return rowsToText([
    code`${exported}function ${names.parse}(text: string, options?: ${SERDE_OPTIONS}): ${fields.orUnknown} {`,
    code`  return ${rt.conversion.decodeDetachedInput}(${convertId}, ${rt.serde.parseJson}(text), options)${fields.code ? code` as ${fields.code}` : code``};`,
    code`}`,
    code``,
  ]);
}

/** The exported validate and assert functions, which fail with `validationUnavailable` when validation is off. */
function emitValidateSection(runtime: NodeRuntime): Code {
  const { node, ctx, validationEnabled, validateId, assertId, exported } = runtime;
  const { modelType } = runtime.fields();
  return rowsToText(validationEnabled
    ? [
      code`${exported}function ${validateId}(value: unknown, options?: ${VALIDATE_OPTIONS}): value is ${modelType} {`,
      code`  return ${validModelValueCall(ctx, node.codecId)};`,
      code`}`,
      code``,
      code`${exported}function ${assertId}(value: unknown, options?: ${VALIDATE_OPTIONS}): ${modelType} {`,
      code`  ${emitModelGuard(node, VALUE_REF, 'model', ctx)}`,
      code`  return value as ${modelType};`,
      code`}`,
      code``,
    ]
    : [
      code`${exported}function ${validateId}(_value: unknown, _options?: ${VALIDATE_OPTIONS}): _value is ${modelType} {`,
      code`  ${rt.serde.validationUnavailable}();`,
      code`}`,
      code``,
      code`${exported}function ${assertId}(_value: unknown): ${modelType} {`,
      code`  ${rt.serde.validationUnavailable}();`,
      code`}`,
      code``,
    ]);
}

/** The private assert functions of the wire plane and of the residual model-only and wire-only planes. */
function emitPlaneAssertSection(runtime: NodeRuntime): Code {
  const { node, ctx, validationEnabled, wireAssertId, modelOnlyAssertId, wireOnlyAssertId } = runtime;
  const planeAssert = (name: Code, plane: ValidationPlane): Code[] => [
    code`function ${name}(value: unknown, options?: ${VALIDATE_OPTIONS}): Record<string, unknown> {`,
    code`  ${emitModelGuard(node, VALUE_REF, plane, ctx)}`,
    code`  return value as Record<string, unknown>;`,
    code`}`,
    code``,
  ];
  return rowsToText(validationEnabled && !node.sameSchema
    ? [
      ...planeAssert(wireAssertId, 'wire'),
      ...(node.modelOnlyJsonSchema !== undefined ? planeAssert(modelOnlyAssertId, 'model-only') : []),
      ...(node.wireOnlyJsonSchema !== undefined ? planeAssert(wireOnlyAssertId, 'wire-only') : []),
    ]
    : []);
}

/** The registration of the node's functions as an object codec, with its schemas. */
function emitCodecRegistrationSection(runtime: NodeRuntime): Code {
  const { node, ctx, validationEnabled, names, stringifyId, validateId, assertId, objectDescriptor } = runtime;
  const resolved = (id: string): Code | undefined => ctx.resolvedSchemasExpr !== undefined && validationEnabled
    ? code`${ctx.resolvedSchemasExpr}[${literal(id)}] as object`
    : undefined;
  const payload = (schema: JsonSchema, id: string): Code => code`${jsonDataExpression(withCodecIdRefs(schemaPayload(schema, id), ctx.generatedModelCodecId))} as object`;
  const modelSchemaExpr = resolved(node.codecId) ?? payload(node.modelJsonSchema ?? node.jsonSchema, node.codecId);
  const wireSchemaExpr = node.sameSchema
    ? undefined
    : resolved(`${node.codecId}#wire`)
      ?? payload(node.jsonSchema, `${node.codecId}#wire`);
  const residualSchemaExpr = (plane: 'model-only' | 'wire-only'): Code | undefined => {
    const residual = plane === 'model-only' ? node.modelOnlyJsonSchema : node.wireOnlyJsonSchema;
    if (residual === undefined || !validationEnabled) return undefined;
    const id = `${node.codecId}#${plane}`;
    return resolved(id) ?? payload(residual, id);
  };
  const modelOnlySchemaExpr = residualSchemaExpr('model-only');
  const wireOnlySchemaExpr = residualSchemaExpr('wire-only');
  return rowsToText([
    code`${rt.serde.createObjectCodec}(${literal(node.codecId)}, {`,
    code`  stringify: ${stringifyId} as (value: never, options?: ${SERDE_OPTIONS}) => string,`,
    code`  parse: ${names.parse} as (text: string, options?: ${SERDE_OPTIONS}) => never,`,
    code`  validate: ${validateId},`,
    code`  assert: ${assertId},`,
    code`  toWireFormat: ${names.toWire},`,
    ...(objectDescriptor ? [code`  fields: ${literal(Object.keys(objectDescriptor.properties))},`] : []),
    code`  fromWireFormat: ${names.fromWire},`,
    code`  schema: ${modelSchemaExpr},`,
    ...(wireSchemaExpr ? [code`  wireSchema: ${wireSchemaExpr},`] : []),
    ...(modelOnlySchemaExpr ? [code`  modelOnlySchema: ${modelOnlySchemaExpr},`] : []),
    ...(wireOnlySchemaExpr ? [code`  wireOnlySchema: ${wireOnlySchemaExpr},`] : []),
    ...(resolved(node.codecId) !== undefined ? [code`  schemaRefsResolved: true,`] : []),
    code`  issueSource: ${rt.serde.IssueSource}.${identifier(ctx.issueSource)},`,
    code`});`,
  ]);
}

function emitNodeRuntime(
  node: SchemaNode,
  moduleCtx: EmitCtx,
  validationEnabled: boolean,
): Code {
  if (node.descriptor.kind === 'generated-model' || node.descriptor.kind === 'reference') return emitExternalNodeRuntime(node, moduleCtx);
  const runtime = nodeRuntime(node, moduleCtx, validationEnabled);
  const stringify = emitStringifySection(runtime);
  const decode = emitDecodeSection(runtime);
  const toWire = emitToWireSection(runtime);
  const parse = emitParseSection(runtime);
  const validate = emitValidateSection(runtime);
  const planeAsserts = emitPlaneAssertSection(runtime);
  const codec = emitCodecRegistrationSection(runtime);
  // The hoisted converters exist only after the decode section.
  return blocksToText([rowsToText(runtime.ctx.hoisted?.sources ?? []), decode.fill, stringify, decode.convert, decode.fromWire, toWire, parse, validate, planeAsserts, codec]);
}

function schemaPayload(schema: JsonSchema, id: string): object {
  if (typeof schema === 'boolean') {
    return schema ? { $id: id } : { $id: id, not: true };
  }
  return { $id: id, ...schema };
}

/** Names the codec id in each generated-model placeholder `$ref` of a schema; a name the module cannot map stays as it is. */
function withCodecIdRefs(value: unknown, codecIdOf: ((name: string) => string | undefined) | undefined): unknown {
  if (codecIdOf === undefined) return value;
  const walk = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(walk);
    if (current === null || typeof current !== 'object') return current;
    return Object.fromEntries(Object.entries(current).map(([key, item]) => {
      if (key !== '$ref' || typeof item !== 'string' || !item.startsWith(GENERATED_MODEL_SCHEMA_REF_PREFIX)) return [key, walk(item)];
      const reference = item.slice(GENERATED_MODEL_SCHEMA_REF_PREFIX.length);
      const hash = reference.indexOf('#');
      const name = hash < 0 ? reference : reference.slice(0, hash);
      return [key, `${GENERATED_MODEL_SCHEMA_REF_PREFIX}${codecIdOf(name) ?? name}${hash < 0 ? '' : reference.slice(hash)}`];
    }));
  };
  return walk(value);
}

function jsonDataExpression(value: unknown): Code {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Generated schema data is not JSON serializable.');
  return code`JSON.parse(${literal(json)})`;
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
export function emitCodecRuntimeCode(
  graph: SchemaGraph,
  options: CodecRuntimeOptions = {},
): Code {
  const defaultEnabled = options.validationEnabled !== false;
  const validates = (node: SchemaNode): boolean => nodeValidates(node, defaultEnabled);
  const nodes = [...graph.topo()];
  const patternConstants = new Map<string, Code>();
  const ctx: EmitCtx = {
    graph,
    // emitNodeRuntime emits stringify<Id>Wire exactly for these nodes.
    wireStringifyIds: new Set(nodes.filter((node) => !isExternalCodecNode(node) && validates(node) && !node.sameSchema).map((node) => node.id)),
    // emitNodeRuntime emits stringify<Id>Core and toWireFormat<Id>Core for every node that is not external.
    localCoreIds: new Set(nodes.filter((node) => !isExternalCodecNode(node)).map((node) => node.id)),
    strictCoreIds: new Set(nodes.filter((node) => !isExternalCodecNode(node) && validates(node) && node.sameSchema).map((node) => node.id)),
    trustedOptions: helperName(TRUSTED_HELPER),
    siblingWireCodecIds: options.siblingWireCodecIds,
    siblingRecursion: options.siblingRecursion,
    exportWireStringify: options.exportWireStringify,
    validatorName: options.validatorName,
    fastCheckName: options.fastCheckName,
    passCheckNames: options.passCheckNames,
    resolvedSchemasExpr: options.resolvedSchemasExpr,
    serde: options.serde,
    nestedConstruct: options.nestedConstruct,
    siblingWireName: options.siblingWireName,
    nestedGenerated: options.nestedGenerated,
    generatedModelCodecId: options.generatedModelCodecId,
    nestedImportedSerde: options.nestedImportedSerde,
    exportedFillFunctionIds: options.exportedFillFunctionIds,
    issueSource: options.issueSource ?? 'TypeScript',
    wireType: options.wireType,
    fieldsType: options.fieldsType,
    exportAnonymousCodecs: options.exportAnonymousCodecs,
    privateCodec: options.privateCodec,
    modelBases: options.modelBases,
    fillThrows: new Map(),
    patternConstants,
  };
  const runtimes: Code[] = [];
  for (const node of nodes) {
    const runtime = emitNodeRuntime(node, ctx, validates(node));
    if (!isEmpty(runtime)) runtimes.push(runtime);
  }
  // A blank line stands between two functions' runtimes, and none ends the last.
  return withModuleConstants(join(runtimes, code`\n\n`), patternConstants);
}

/** The helpers whose definitions `withModuleConstants` writes into the runtime code, so the file places no definition of them. */
export const MODULE_CONSTANT_HELPERS: readonly Helper[] = [TRUSTED_HELPER, CHECKED_KEY_HELPER, CHECKED_HELPER];

/** One frozen object of each kind serves every nested call that passes options to another module's function; one expression of each pattern serves every fill. */
function withModuleConstants(runtime: Code, patterns: ReadonlyMap<string, Code>): Code {
  const used = new Set(helperSet(runtime).map((found) => found.id));
  const constants = [
    ...MODULE_CONSTANT_HELPERS.filter((found) => used.has(found.id)).map((found) => found.define()),
    ...[...patterns].map(([pattern, name]) => code`const ${name} = /*#__PURE__*/ new RegExp(${literal(pattern)}, 'u');`),
  ];
  return constants.length ? code`${join(constants, code`\n`)}\n\n${runtime}` : runtime;
}
