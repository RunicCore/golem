import type { ModelTypeDescriptor } from '../model.js';
export {
  emitCodecRuntimeCode,
  emitStringifyFunction,
  fillFunctionName,
  fromWireFunctionName,
  MODULE_CONSTANT_HELPERS,
  parseFunctionName,
  reachesItself,
  reachesRecursiveNode,
  stringifyFunctionName,
  wireStringifyExportName,
  toWireFunctionName,
  validateFunctionName,
  type CodecRuntimeOptions,
  type NestedImportedSerde,
  type StringifySerdeResolver,
} from './stringify-emitter.js';
export { type TupleConversionDescriptor } from './sequence-conversion.js';
export { presentKeysCode } from './union-conversion.js';
/** The Code values and the functions that build, join and render them: generators write their files from these. */
export {
  aliased, bindInput, blockComment, code, codeKey, docComment, documentLiteral, exportedName, exportedNames, exportFrom, fileImports, helper, helperName, helperSet, identifier, importedNames, indentation, inputCount, importGroups, importLines, ImportSource, inputOf, inputSlot, isEmpty, join, lineBreak, literal, localCode, nameOf, NameTable, nameSlot, nest, placeHelpers, propertyKey, render, renderModule, sameCode, sideEffectImport,
  type Code, type Helper, type ImportGroup, type ImportOptions, type InputSlot, type JsonValue, type NameSlot, type RenderedModule,
} from './code.js';
export { rt, rtType, type RuntimeModule } from './rt.js';
/** The allOf object merge, for generators that read schemas (golem-openapi). */
export {
  composeObjects,
  CompositionConflictError,
  conversionKey,
  descriptorSlotRule,
  isRejected,
  type ModelBases,
  type ObjectExtra,
  type ObjectPart,
  type ObjectResult,
  type Rejected,
  type SlotRule,
} from './composition.js';
import { blockComment, bindInput, code, codeKey, identifier, importGroups, importLines, inputOf, inputSlot, isEmpty, join, literal, localCode, sameCode, type Code, type Helper, type ImportOptions } from './code.js';
import { rt, type RuntimeModule } from './rt.js';
import { MODEL_MANIFEST_FILENAME, MODEL_MANIFEST_MARKER } from './model-manifest.js';
export { assertUniqueExportNames, type PublicModule } from './names.js';
import { CompositionConflictError, requireComposedObject, type ModelBases } from './composition.js';
import { FIELD_CONVERSION_INPUT, calleeOf, emitArrayConversion, emitTupleConversion, type SequenceItems } from './sequence-conversion.js';
import {
  ObjectUnionDiscriminatorError,
  objectValueExpression,
  emitDispatch,
  emitUnionConversion,
  withUnionInput,
  keyIsNotListed,
  PRESENT_KEY,
  presentKeysCode,
  unionDispatch,
  type ObjectTypeDescriptor,
} from './union-conversion.js';
import { isRecordExpression } from './stringify-emitter.js';

/** Generators read tag values through the same rule as the shared union conversion. */
export { AmbiguousUnionConversionError, descriptorNeedsConversion, ObjectUnionDiscriminatorError } from './union-conversion.js';

export type ModelConversionDescriptor = ModelTypeDescriptor;

/** The local that a projection decoder reads the field at `index` into. */
const projectionLocal = (index: number): Code => localCode('projected', index);
/** The array that a projection decoder collects the keys it does not declare in. */
const EXTRA_KEYS = localCode('extra');

/**
 * Each answer of a resolver is Code that holds the callee as a part, so the file imports it. A resolver reads the value it
 * converts as Code, and writes it into its call.
 */
export interface FromJsonModelResolver {
  readonly className: Code;
  /** The models that this model extends, so a derived model narrows its bases where they judge one property. */
  readonly bases?: readonly string[];
  /** Internal generated-model wire decoder expression. */
  readonly decode: (value: Code) => Code;
  /** Construct a domain model from a nested model initializer. */
  readonly fromInit?: (value: Code) => Code;
  /** A projection whose value converts to itself: a use writes no call. */
  readonly identity?: true;
}

/**
 * Resolve a compiler-emitted serde pair to a call expression.  The model
 * compiler owns the import and lazy wrapper; this emitter only decides where
 * the wrapper is applied in a nested conversion tree.
 */
export interface SerdeResolver {
  readonly deserialize: (id: string, value: Code) => Code;
  readonly serialize: (id: string, value: Code) => Code;
}

type DescriptorMetadata = {
  readonly serde?: { readonly id: string };
  readonly date?: true;
};

function metadata(descriptor: ModelConversionDescriptor): DescriptorMetadata {
  return descriptor as ModelConversionDescriptor & DescriptorMetadata;
}

type GeneratedModelDescriptor = Extract<
  ModelConversionDescriptor,
  { readonly kind: 'generated-model' }
>;
type ObjectDescriptor = ObjectTypeDescriptor;

function generatedModel(
  descriptor: ModelConversionDescriptor,
): GeneratedModelDescriptor | undefined {
  if (descriptor.kind === 'generated-model') return descriptor;
  if (descriptor.kind !== 'union') return undefined;

  const generated = descriptor.variants.filter(
    (variant): variant is GeneratedModelDescriptor => variant.kind === 'generated-model',
  );
  if (generated.length !== 1) return undefined;

  const alternatives = descriptor.variants.filter(
    (variant) => variant.kind !== 'generated-model',
  );
  // `unknown`, `any`, arrays, intersections, and an object branch can all
  // accept the same runtime value as a generated model. A union with a
  // declared tag table never comes here: its default is the table's.
  const objectAlternatives = alternatives.filter(
    (variant): variant is ObjectDescriptor => variant.kind === 'object',
  );
  if (alternatives.some((variant) =>
    variant.kind === 'any'
      || variant.kind === 'unknown'
      || variant.kind === 'array'
      || variant.kind === 'intersection'
  )) return undefined;
  if (objectAlternatives.length > 0) return undefined;
  return generated[0];
}

/** The record view of an expression: a record input as it is, any other expression cast once. */
function recordExpression(expression: Code): Code {
  return isRecordExpression(expression) ? expression : code`(${expression} as Record<string, unknown>)`;
}

function recordIndex(expression: Code, property: Code): Code {
  return code`${recordExpression(expression)}[${property}]`;
}

/** The construction of a model from its initializer: the resolver's own, or `new <class>(<value>)`. */
function fromInitCall(model: FromJsonModelResolver, expression: Code): Code {
  return model.fromInit
    ? model.fromInit(expression)
    : code`new ${model.className}(${expression})`;
}

/** A model instance as it is, or the model built from the value by `convertToModel`. */
function modelFromConversion(
  model: FromJsonModelResolver,
  expression: Code,
  convertToModel: (model: FromJsonModelResolver, expression: Code) => Code,
): Code {
  return code`${expression} instanceof ${model.className} ? ${expression} : ${convertToModel(model, expression)}`;
}

/** The union with a generated model beside plain variants: an object becomes the model. */
function unionGeneratedFrom(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: Code,
  resolveModel: (id: string) => FromJsonModelResolver,
  convertToModel: (model: FromJsonModelResolver, expression: Code) => Code,
): Code | undefined {
  const generated = generatedModel(descriptor);
  if (!generated) return undefined;
  return code`${objectValueExpression(expression)} ? ${modelFromConversion(resolveModel(generated.id), expression, convertToModel)} : ${expression}`;
}

/** The input of a field conversion that is emitted once to find its shape, and the parameter of a field conversion function. No nested conversion binds this name. */
const FIELD_INPUT = identifier(FIELD_CONVERSION_INPUT);

/**
 * A converted value at a nested field. `emit(FIELD_INPUT)` shows the conversion's shape: a single call
 * passes its function and the value to `convertModelField`; any other conversion becomes a value-taking arrow,
 * so no conversion captures the enclosing loop.
 */
function atField(emit: (value: Code) => Code, input: Code, field: Code, direction: 'fromJSON' | 'fromInit'): Code {
  if (direction === 'fromInit') return emit(input);
  const converted = emit(FIELD_INPUT);
  if (sameCode(converted, FIELD_INPUT)) return input;
  const convert = calleeOf(converted) ?? code`(${FIELD_INPUT}: unknown) => (${converted})`;
  return code`${rt.conversion.convertModelField}(${literal('deserialize')}, ${field}, ${convert}, ${input})`;
}

/** The item conversion of a tuple or an array in the model family: `fromInit` has no error paths, the other directions have. */
function sequenceItems(
  direction: 'fromJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde: SerdeResolver | undefined,
  memo: EmitMemo,
): SequenceItems {
  return {
    output: 'value',
    ...(direction === 'fromInit' ? {} : { paths: 'deserialize' as const }),
    item: (item, value) => {
      const converted = emitNested(item, value, direction, resolveModel, resolveSerde, memo);
      return { code: converted, throws: !sameCode(converted, value) };
    },
  };
}

function emitNestedUnion(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  expression: Code,
  direction: 'fromJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde: SerdeResolver | undefined,
  memo: EmitMemo,
): Code {
  const value = expression;
  const convert = (variant: ModelConversionDescriptor): Code =>
    emitNested(variant, expression, direction, resolveModel, resolveSerde, memo);
  return emitUnionConversion(descriptor, expression, 'nested', {
    convert,
    items: sequenceItems(direction, resolveModel, resolveSerde, memo),
    tagged: ({ indices, rest, restIsInstance, fallback, fallbackVariant }) => {
      const variants = indices.map((index) => descriptor.variants[index]);
      const dispatch = unionDispatch(descriptor, indices);
      if (!dispatch) return undefined;
      const classOf = (variant: ModelConversionDescriptor): Code | undefined => variant.kind === 'generated-model' ? resolveModel(variant.id).className
        : variant.kind === 'reference' && !variant.projection ? resolveModel(variant.name).className
          : undefined;
      const branches = variants.map((variant, position) => ({
        values: dispatch.values[position],
        className: classOf(variant),
        convert: convert(variant),
      }));
      const fallbackClass = fallbackVariant && classOf(fallbackVariant);
      // Objects that convert to themselves, with nothing outside the tag to convert, need no dispatch.
      const converts = fallback !== undefined || variants.some((variant) => variant.kind === 'reference' || variant.kind === 'generated-model')
        || branches.some((branch) => !sameCode(branch.convert, value));
      if (!converts) return rest === undefined ? undefined : sameCode(rest, value) ? value : code`(${objectValueExpression(expression, restIsInstance)} ? ${value} : ${rest})`;
      return emitDispatch({
        expression,
        property: dispatch.property,
        direction: 'decode',
        branches,
        standalone: true,
        ...(rest === undefined ? {} : { rest, restIsInstance }),
        ...(fallback === undefined ? {} : { fallback }),
        ...(fallbackClass ? { fallbackClass } : {}),
      });
    },
    declaredDefault: (variant) => {
      if (variant.kind !== 'generated-model') return undefined;
      return modelFromConversion(resolveModel(variant.id), expression, direction === 'fromInit' ? fromInitCall : (model, input) => model.decode(input));
    },
    afterGenerated: (present) => {
      const result = unionGeneratedFrom(descriptor, expression, resolveModel, direction === 'fromInit' ? fromInitCall : (model, input) => model.decode(input));
      const objects = present.filter((variant): variant is ObjectDescriptor => variant.kind === 'object');
      const convertedObjects = objects.map((object) => ({ object, converted: convert(object) }));
      if (convertedObjects.some(({ converted }) => !sameCode(converted, value))) {
        if (objects.length > 1 || descriptor.variants.some((variant) => ['reference', 'generated-model', 'any', 'unknown', 'intersection'].includes(variant.kind))) {
          throw new ObjectUnionDiscriminatorError(descriptor.variants);
        }
        let chain = result ?? value;
        for (const { converted } of convertedObjects.reverse()) {
          chain = code`${objectValueExpression(expression)} ? (${converted}) : (${chain})`;
        }
        return chain;
      }
      return result;
    },
  });
}

/**
 * The Code that one top-level emit wrote for a descriptor, by the code of its input. A field conversion is written for two inputs
 * (the field read and the local of a copy), and each writes its own fields the same way, so without this the work doubles on each level.
 */
type EmitMemo = Map<ModelConversionDescriptor, Map<string, Code>>;

function emitNested(
  descriptor: ModelConversionDescriptor,
  expression: Code,
  direction: 'fromJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde: SerdeResolver | undefined,
  memo: EmitMemo,
): Code {
  const key = codeKey(expression);
  const known = memo.get(descriptor) ?? new Map<string, Code>();
  memo.set(descriptor, known);
  let emitted = known.get(key);
  if (emitted === undefined) {
    emitted = emitNestedUncached(descriptor, expression, direction, resolveModel, resolveSerde, memo);
    known.set(key, emitted);
  }
  return emitted;
}

function emitNestedUncached(
  descriptor: ModelConversionDescriptor,
  expression: Code,
  direction: 'fromJSON' | 'fromInit',
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde: SerdeResolver | undefined,
  memo: EmitMemo,
): Code {
  const value = expression;
  const tags = metadata(descriptor);
  if (tags.serde && resolveSerde) {
    return direction === 'fromJSON' ? resolveSerde.deserialize(tags.serde.id, value) : value;
  }
  if (descriptor.kind === 'date' || tags.date) {
    return direction === 'fromJSON' ? code`${rt.conversion.deserializeDate}(${value})` : value;
  }
  if (descriptor.kind === 'intersection') {
    const bases: ModelBases = { basesOf: (id) => resolveModel(id).bases ?? [] };
    const merged = descriptor.variants.every(variant => !metadata(variant).serde) ? requireComposedObject(descriptor.variants, bases) : undefined;
    if (merged) return emitNested(merged, expression, direction, resolveModel, resolveSerde, memo);
    // A scalar intersection converts by its one converting part.
    const conversions: Code[] = [];
    for (const variant of descriptor.variants) {
      const converted = emitNested(variant, expression, direction, resolveModel, resolveSerde, memo);
      if (!sameCode(converted, value) && !conversions.some(known => sameCode(known, converted))) conversions.push(converted);
    }
    if (conversions.length > 1) throw new CompositionConflictError('two parts convert it differently');
    return conversions[0] ?? value;
  }
  if (descriptor.kind === 'union') {
    return withUnionInput(expression, (union) => emitNestedUnion(descriptor, union, direction, resolveModel, resolveSerde, memo));
  }
  if (descriptor.kind === 'generated-model' || descriptor.kind === 'reference') {
    const modelName = descriptor.kind === 'reference' ? descriptor.name : descriptor.id;
    const model = resolveModel(modelName);
    if (descriptor.kind === 'reference' && descriptor.projection) {
      if (model.identity) return value;
      return direction === 'fromInit' ? (model.fromInit ?? model.decode)(expression) : model.decode(expression);
    }
    const convert = direction === 'fromInit' ? fromInitCall(model, expression) : model.decode(expression);
    return code`${value} == null || ${value} instanceof ${model.className} ? ${value} : ${convert}`;
  }
  if (descriptor.kind === 'array') {
    return emitArrayConversion(descriptor.item, expression, sequenceItems(direction, resolveModel, resolveSerde, memo));
  }
  if (descriptor.kind === 'tuple') {
    return emitTupleConversion(descriptor, expression, sequenceItems(direction, resolveModel, resolveSerde, memo));
  }
  if (descriptor.kind === 'object') {
    // A projection copies its fields inside a function whose `source` parameter is the record.
    const source = identifier('source');
    const sourceRecord = inputSlot('source', 'name', true);
    const fieldSource = descriptor.projection ? inputOf(sourceRecord) : expression;
    const assignments = Object.entries(descriptor.properties).map(([name, item], index) => {
      const property = literal(name);
      // A record is read as it is. Another expression is cast once here, so its read is not a chain.
      const slot = inputSlot(name, isRecordExpression(fieldSource) ? 'chain' : 'other');
      const sourceValue = recordIndex(fieldSource, property);
      const convert = (input: Code): Code => atField(nested => emitNested(item, nested, direction, resolveModel, resolveSerde, memo), input, property, direction);
      const piece = convert(inputOf(slot));
      return { name, property, sourceValue, unchanged: sameCode(piece, inputOf(slot)), value: bindInput(piece, slot, sourceValue), presentValue: convert(projectionLocal(index)) };
    });
    const additionalItem = descriptor.additionalProperties;
    const plainValue = identifier('value');
    const additional = typeof additionalItem === 'object'
      ? atField(nested => emitNested(additionalItem, nested, direction, resolveModel, resolveSerde, memo), plainValue, identifier('key'), direction)
      : plainValue;
    const additionalChanged = !sameCode(additional, plainValue);
    const knownChanged = assignments.some(({ unchanged }) => !unchanged);
    const knownNames = Object.keys(descriptor.properties);
    const unlisted = knownNames.length === 0 ? code`` : code` && ${keyIsNotListed(identifier('key'), knownNames)}`;
    const defineProperty = rt.conversion.defineModelProperty;
    // A decoder reads the declared fields of any object by the JSON view, so it builds the copy from one Object.keys pass.
    // A projection does so in both directions, and also drops the keys it does not declare.
    if (descriptor.projection || knownChanged || additionalChanged) {
      // An additionalProperties tag declares the other keys of a projection as data: they are copied as they are or by
      // the tag's type. Another object keeps its other keys the same way.
      const hasExtras = !descriptor.projection || typeof descriptor.additionalProperties === 'object' || descriptor.additionalPropertiesDeclared;
      // A record with no declared field walks its entries in the runtime, which takes the conversion of one value.
      if (knownNames.length === 0 && hasExtras) {
        const converted = typeof additionalItem === 'object'
          ? emitNested(additionalItem, FIELD_INPUT, direction, resolveModel, resolveSerde, memo)
          : FIELD_INPUT;
        const convert = sameCode(converted, FIELD_INPUT) ? undefined : calleeOf(converted) ?? code`(${FIELD_INPUT}: unknown) => (${converted})`;
        const walk = direction !== 'fromInit' && convert
          ? code`${rt.conversion.convertModelRecord}(${literal('deserialize')}, ${convert}, ${recordExpression(expression)})`
          : code`${rt.conversion.copyModelRecord}(${recordExpression(expression)}${convert ? code`, ${convert}` : code``})`;
        return code`${objectValueExpression(expression)} ? ${walk} : ${value}`;
      }
      // A decoder reads its input by the JSON view: one Object.keys pass reads each field once into a local.
      const captured = assignments.length > 0;
      // The same pass collects the other keys, and the copy writes them after the fields, in key order.
      const collectExtras = hasExtras && captured;
      const capture = captured
        ? [code`${collectExtras ? code`let ${EXTRA_KEYS}: string[] | undefined; ` : code``}${presentKeysCode(source, assignments.map(({ name }, index) => [name, projectionLocal(index)] as const), {
          declare: (local) => code`${local}: unknown`,
          ...(collectExtras ? { otherwise: code`(${EXTRA_KEYS} ??= []).push(${PRESENT_KEY});` } : {}),
        })}`]
        : [];
      const extras = !hasExtras
        ? join([])
        : collectExtras
          ? code`if (${EXTRA_KEYS} !== undefined) for (const key of ${EXTRA_KEYS}) { const value = source[key]; if (value !== undefined) ${defineProperty}(out, key, ${additional}); }`
          : code`for (const [key, value] of Object.entries(source)) if (value !== undefined${unlisted}) ${defineProperty}(out, key, ${additional});`;
      const fields = assignments.map(({ property, presentValue }, index) =>
        code`if (${projectionLocal(index)} !== undefined) ${defineProperty}(out, ${property}, ${presentValue});`);
      const body = bindInput(join([...capture, ...fields, extras].filter(piece => !isEmpty(piece)), code` `), sourceRecord, source);
      return code`${objectValueExpression(expression)} ? ((source: Record<string, unknown>) => { const out: Record<string, unknown> = {}; ${body} return out; })(${recordExpression(expression)}) : ${value}`;
    }
    return value;
  }
  return value;
}

export function emitModelFromJSON(
  descriptor: ModelConversionDescriptor,
  expression: Code,
  resolveModel: (id: string) => FromJsonModelResolver,
  resolveSerde?: SerdeResolver,
): Code {
  return emitNested(descriptor, expression, 'fromJSON', resolveModel, resolveSerde, new Map());
}

/** Emit nested construction of domain models from partial model initializers. */
export function emitModelFromInit(
  descriptor: ModelConversionDescriptor,
  expression: Code,
  resolveModel: (id: string) => FromJsonModelResolver,
): Code {
  return emitNested(descriptor, expression, 'fromInit', resolveModel, undefined, new Map());
}

/** The marker comment of a file that names its model manifest, as Code. */
export function manifestMarkerComment(relative = `./${MODEL_MANIFEST_FILENAME}`): Code {
  return blockComment(`${MODEL_MANIFEST_MARKER} ${relative}`);
}

/** A line of a generated file, or a helper that stands where its definition goes if the code calls the helper. */
export type Piece = Code | Helper;

export const isCode = (piece: Piece): piece is Code => 'parts' in piece;

/**
 * `emit(FIELD_INPUT)` shows the shape of a field conversion. A single call passes its function and the
 * field value to `convertModelField`; any other conversion becomes a module-level function of the field value,
 * so no field allocates a closure.
 */
export function wrapRootConversion(
  helpers: Code[],
  helperName: (index: number) => string,
  direction: 'serialize' | 'deserialize',
  field: Code,
  input: Code,
  emit: (value: Code) => Code,
  inputType: Code,
): Code {
  const converted = emit(FIELD_INPUT);
  if (sameCode(converted, FIELD_INPUT)) return input;
  let convert = calleeOf(converted);
  if (!convert) {
    const name = identifier(helperName(helpers.length));
    helpers.push(code`function ${name}(${FIELD_INPUT}: ${inputType}) { return ${converted}; }`);
    convert = name;
  }
  return code`${rt.conversion.convertModelField}(${literal(direction)}, ${field}, ${convert}, ${input})`;
}

const SERDE_IMPORT_ORDER: readonly string[] = [
  'assertModelValue', 'createObjectCodec', 'isValidModelValue', 'parseJson', 'registerIModelClass', 'requireIModelClass', 'requireObjectCodec',
  'serdeValidates', 'stringifyJsonArray', 'stringifyJsonBoolean', 'stringifyJsonNumber', 'stringifyJsonScalar', 'stringifyJsonString',
  'validationUnavailableStub', 'withoutInstanceState', 'IssueRepresentation', 'IssueSource', 'SerdeOptions', 'ValidateOptions',
];

/** The order of the names in the model, conversion and serde imports of a generated model file: golem-model and golem-openapi write the same. */
export const MODEL_IMPORT_ORDER: NonNullable<ImportOptions['order']> = {
  model: [
    'findGeneratedModelDefinition', 'findGeneratedModelDefinitionForConstructor', 'GeneratedModel', 'GeneratedModelConstructor',
    'generatedModelFieldsBrand', 'generatedModelResultBrand', 'GeneratedModelWire', 'generatedModelWireBrand', 'ModelInit', 'registerGeneratedModel',
  ],
  conversion: [
    'assertAcyclicEncodeInput', 'assertPropertyAcyclic', 'assertWireAcyclic', 'beginDecode', 'beginEncode', 'convertModelField', 'convertModelItems',
    'convertModelRecord', 'convertModelTupleItems', 'copyModelRecord', 'decodeCheckedInput', 'decodeDetachedInput', 'decodeGeneratedModelTrusted', 'defineModelProperty', 'deserializeDate',
    'encodeGeneratedModel', 'endDecode', 'endEncode', 'isVariantObject', 'jsonWithDiscriminator', 'rejectModelObject', 'requireModelObject', 'serializeDate', 'unknownDiscriminatorValue',
    'withDiscriminatorValue',
  ],
  serde: SERDE_IMPORT_ORDER,
};

/**
 * The runtime import lines of what `root` calls: each call lists the runtime modules to write, and a specifier that serves
 * several of them is written once, by the first call that lists one of them. A module that the code does not use writes none.
 */
export function runtimeLinesOf(root: Code, options: ImportOptions): (...modules: readonly RuntimeModule[]) => readonly Code[] {
  const groups = importGroups(root, options);
  const written = new Set<string>();
  return (...modules) => modules.flatMap((module) => groups.flatMap((group) => {
    if (written.has(group.specifier) || !group.modules.includes(module)) return [];
    written.add(group.specifier);
    return importLines(group, options);
  }));
}
