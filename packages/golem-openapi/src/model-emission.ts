import {
  AmbiguousUnionConversionError,
  CompositionConflictError,
  ObjectUnionDiscriminatorError,
  emitModelFromJSON,
  code,
  isCode,
  runtimeLinesOf,
  MODEL_IMPORT_ORDER,
  wrapRootConversion,
  type Piece,
  emitCodecRuntimeCode,
  exportFrom,
  fileImports,
  helper,
  bindInput,
  helperName,
  indentation,
  inputCount,
  inputOf,
  inputSlot,
  type InputSlot,
  identifier,
  importedNames,
  MODULE_CONSTANT_HELPERS,
  placeHelpers,
  ImportSource,
  join,
  lineBreak,
  literal,
  localCode,
  nameOf,
  NameTable,
  nameSlot,
  render,
  rt,
  rtType,
  sameCode,
  type Code,
  type Helper,
  type ImportOptions,
  type NameSlot,
  emitModelFromInit,
  fillFunctionName,
  presentKeysCode,
  propertyKey,
  sideEffectImport,
  reachesItself,
  wireStringifyExportName,
  type CodecRuntimeOptions,
  type FromJsonModelResolver,
} from '@exprtlabs/golem/internal/emitter';
import { type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { CodecValidationPlan, PlanValidators, SchemaPlace } from '@exprtlabs/golem/internal/validation-plan';
import { NameScope, RESERVED_MODEL_MEMBERS, sourceDigest } from '@exprtlabs/golem/internal/generator-support';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { isJsonObject } from './json.js';
import { compareText } from '@exprtlabs/golem/generator-api';
import { componentOrigin, componentPlace, ComponentNameScope, LocatedError, type OriginLocator } from './origin.js';
import { COMPOSITION_CONVERSION_CONFLICT, conflictMessage } from './composition.js';
import { generatedBannerComment } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import { descriptionComment, schemaContext } from './types.js';
import {
  type ModelDefinition,
  type RecursiveAlias,
  ModelDefinitions,
  type ModelResolveEnv,
  type ModelNames,
  LOCAL_NAMES,
  type OpenApiModelAnalysis,
  modelEnv,
  withSchemaBase,
  TEMPORAL_SERDE_PREFIX,
  modelSchemaProperties,
  componentEnv,
  aliasDescriptor,
  aliasConvertsValue,
  aliasModelTypeName,
  aliasUseType,
  declaredModelBases,
  modelBases,
  modelFieldType,
  modelStableId,
  modelConversionDescriptor,
  CompositionError,
  locatedCompositionError,
  type CompositionSite,
} from './model-resolution.js';
import { openApiValidationSchemaClosure } from './model-manifest.js';
import { analyzeOpenApiModels, reachableSchemaNodes, schemaGraphView } from './model-schema-graph.js';

/**
 * Calls the Temporal codec of `@exprtlabs/golem/internal/temporal-runtime` that a `temporal:` serde id names; other ids never reach OpenAPI models.
 * Conversion code holds values as `unknown`; wire validation has already checked them, so the call casts.
 * The codec is a runtime part, so the file imports exactly the codecs it calls. The module exports one pair for each
 * Temporal type; a name it lacks is a TypeScript error in the generated file.
 */
const TEMPORAL_CODECS = rt.temporal as unknown as Readonly<Record<string, Code>>;

function temporalCodec(direction: 'deserialize' | 'serialize', id: string): Code {
  return TEMPORAL_CODECS[`${direction}${temporalCodecName(id)}`];
}

const TEMPORAL_SERDE = {
  deserialize: (id: string, value: Code) => code`${temporalCodec('deserialize', id)}((${value}) as never)`,
  serialize: (id: string, value: Code) => code`${temporalCodec('serialize', id)}((${value}) as never)`,
};

function temporalCodecName(id: string): string {
  if (!id.startsWith(TEMPORAL_SERDE_PREFIX)) throw new Error(`Unexpected serde id in an OpenAPI model: ${id}`);
  return id.slice(TEMPORAL_SERDE_PREFIX.length);
}

/** Whether a value of the alias holds a model at some level, so that its init builds that model from a plain object. */
function aliasInitsModel(alias: RecursiveAlias, definitions: ModelDefinitions, env: ModelResolveEnv): boolean {
  alias.initsModel ??= holdsModel({ kind: 'reference', name: alias.name, projection: true }, definitions, env, new Set());
  return alias.initsModel;
}

function holdsModel(descriptor: ModelTypeDescriptor, definitions: ModelDefinitions, env: ModelResolveEnv, visited: Set<string>): boolean {
  const holds = (held: ModelTypeDescriptor): boolean => holdsModel(held, definitions, env, visited);
  switch (descriptor.kind) {
    case 'generated-model': return true;
    case 'reference': {
      const alias = descriptor.projection === true ? definitions.aliases.get(descriptor.name) : undefined;
      if (!alias || visited.has(alias.name)) return false;
      visited.add(alias.name);
      return holds(aliasDescriptor(alias, definitions, env));
    }
    case 'array': return holds(descriptor.item);
    case 'tuple': return descriptor.items.some(holds) || (descriptor.rest !== undefined && holds(descriptor.rest.item));
    case 'object': return Object.values(descriptor.properties).some(holds) || (typeof descriptor.additionalProperties === 'object' && holds(descriptor.additionalProperties));
    case 'union': case 'intersection': return descriptor.variants.some(holds);
    default: return false;
  }
}

function aliasInitName(alias: RecursiveAlias): string {
  return `initialize${alias.name}`;
}

/**
 * The functions of a module that conversion code calls by name. Each is a name part, so a conversion that is one call
 * on its value gives its function to `convertModelField`, and the module decides the spelling when it renders.
 */
class FunctionNames {
  public readonly table = new NameTable();
  readonly #slots = new Map<string, NameSlot>();

  public of(name: string): Code {
    let slot = this.#slots.get(name);
    if (!slot) {
      slot = nameSlot(name);
      this.#slots.set(name, slot);
      this.table.declare(slot, name);
    }
    return nameOf(slot);
  }
}

/** What a conversion needs from the module that writes it: its function names and the call target of a union model's initializer. */
interface ConversionContext {
  readonly names: FunctionNames;
  readonly initializer: (reference: string) => Code;
  /** The names of the model classes and types the conversion writes: local, or imported from the module that holds them. */
  readonly models: ModelNames;
  /** A function of a schema node: a name of this module, or a part imported from the module that holds the node. */
  readonly nodeFunction: (nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire') => Code;
  /** The initializer of a recursive alias that holds a model. */
  readonly aliasInit: (alias: RecursiveAlias) => Code;
}

/** What a group module takes from other modules: each name is a part imported from the module that holds it, or a local name. */
interface ForeignNames extends Omit<ModelNames, 'types'> {
  /** The initializer of a recursive alias that another module holds; undefined when this module holds it. */
  readonly aliasInit: (alias: RecursiveAlias) => Code | undefined;
  /** The wire stringify that the companion of a sibling codec exports. */
  readonly wireStringify: (codecId: string) => Code;
}

/** A context for conversion code that a module of its own writes: every name is local. */
function localConversion(initializer: (reference: string) => Code): ConversionContext {
  const names = new FunctionNames();
  return {
    names,
    initializer,
    models: LOCAL_NAMES,
    nodeFunction: (nodeId, functionName) => names.of(generatedFunctionName(nodeId, functionName)),
    aliasInit: (alias) => names.of(aliasInitName(alias)),
  };
}

/** A context for conversion code that is checked and never written: the initializer is a plain name. */
function checkContext(): ConversionContext {
  return localConversion((reference) => identifier(`initialize${reference}`));
}

/** How generated conversion code decodes and constructs a referenced model. */
/** `identity` for a recursive alias whose conversion changes no value. */
function aliasIdentity(alias: RecursiveAlias, definitions: ModelDefinitions, env: ModelResolveEnv): { readonly identity?: true } {
  return aliasConvertsValue(alias, definitions, env) ? {} : { identity: true };
}

/** The `bases` of the model that `reference` names, when it has any. */
function referenceBases(reference: string, definitions: ModelDefinitions): { readonly bases?: ReturnType<typeof modelBases> } {
  const bases = modelBases(definitions.get(reference));
  return bases.length ? { bases } : {};
}

function modelResolver(reference: string, definitions: ModelDefinitions, env: ModelResolveEnv, context: ConversionContext): FromJsonModelResolver {
  const alias = definitions.aliases.get(reference);
  if (alias) {
    // A use of a recursive alias calls its node. A model-layer value is not a wire value, so init builds only the models.
    return {
      className: identifier(alias.name),
      decode: (value) => code`${context.nodeFunction(aliasNodeId(alias), 'fromWire')}(${value})`,
      fromInit: aliasInitsModel(alias, definitions, env) ? (value) => code`${context.aliasInit(alias)}(${value})` : (value) => value,
      ...aliasIdentity(alias, definitions, env),
    };
  }
  return {
    className: context.models.model(reference),
    decode: (value) => code`${rt.conversion.decodeGeneratedModelTrusted}(${context.models.model(reference)}, ${value})`,
    fromInit: (value) => definitions.get(reference)?.isUnion
      ? code`${context.initializer(reference)}(${value})`
      : code`new ${context.models.model(reference)}(${value} as ${context.models.init(reference)})`,
    ...referenceBases(reference, definitions),
  };
}

function aliasNodeId(alias: RecursiveAlias): string {
  if (alias.nodeId === undefined) throw new Error(`Internal error: the recursive component ${JSON.stringify(alias.schemaName)} has no schema node.`);
  return alias.nodeId;
}

const UNION_DISCRIMINATOR_MISSING = 'OPENAPI_UNION_DISCRIMINATOR_MISSING';

const UNION_DISCRIMINATOR_FIX = 'Give each variant a required const or enum tag, or declare a discriminator (propertyName and mapping) on the oneOf/anyOf whose variants are components that carry the tag.';

/** A conversion conflict, or a union with no literal tag, that an emitter finds carries its OpenAPI code. */
function codedConflict(thrown: unknown): unknown {
  if (thrown instanceof CompositionConflictError) return new CompositionError(COMPOSITION_CONVERSION_CONFLICT, conflictMessage(thrown.reason));
  if (thrown instanceof ObjectUnionDiscriminatorError) return new CompositionError(UNION_DISCRIMINATOR_MISSING, `${thrown.message} ${UNION_DISCRIMINATOR_FIX}`);
  return thrown;
}

/** The errors that golem's emitters and resolvers throw for a schema the user wrote; any other throw is a golem fault and passes through. */
function isConversionConflict(thrown: unknown): boolean {
  return thrown instanceof CompositionError
    || thrown instanceof CompositionConflictError
    || thrown instanceof ObjectUnionDiscriminatorError
    || thrown instanceof AmbiguousUnionConversionError;
}

/** A conversion error of the model path carries its code and names the component, or the inline schema, it converts. */
function withConflictCode<Result>(owner: string | CompositionSite, emit: () => Result): Result {
  try {
    return emit();
  } catch (thrown) {
    const coded = codedConflict(thrown);
    if (!(coded instanceof CompositionError)) throw thrown;
    throw locatedCompositionError(owner, coded);
  }
}

/** The copy of the properties a model does not declare. A file defines it when its code calls it. */
const COPY_ADDITIONAL_PROPERTIES = helper('copyAdditionalProperties', () => join([
  code`function copyAdditionalProperties(target: object, source: object, known: readonly string[], convert?: (value: unknown) => unknown): void {`,
  code`  for (const [name, value] of Object.entries(source)) {`,
  code`    if (known.includes(name)) continue;`,
  code`    Object.defineProperty(target, name, { value: convert ? convert(value) : value, enumerable: true, configurable: true, writable: true });`,
  code`  }`,
  code`}`,
  code``,
], code`\n`));

/** The input the model conversions read in the constructor; the constructor names it `values` or `_values`, by whether the code reads it. */
const VALUES = inputSlot('values', 'name');
const VALUE = identifier('value');

function modelFromJSONCode(
  schema: unknown,
  expression: Code,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
  context: ConversionContext,
): Code {
  return withConflictCode(owner, () => emitModelFromJSON(
    modelConversionDescriptor(schema, definitions, env, 'from'),
    expression,
    (reference) => modelResolver(reference, definitions, env, context),
    TEMPORAL_SERDE,
  ));
}

function modelInitCode(
  schema: unknown,
  expression: Code,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
  context: ConversionContext,
): Code {
  const descriptor = modelConversionDescriptor(schema, definitions, env, 'from');
  return withConflictCode(owner, () => emitModelFromInit(descriptor, expression, reference => modelResolver(reference, definitions, env, context)));
}

/** Builds the conversion of a schema and writes nothing: it throws when the schema does not convert. */
export function checkModelFromJSON(
  schema: unknown,
  expression: string,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
): void {
  modelFromJSONCode(schema, identifier(expression), definitions, env, owner, checkContext());
}

function modelFieldDeclaration(
  name: string,
  schema: unknown,
  required: boolean,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
): Code {
  const description = isJsonObject(schema) && schema.description
    ? code`  ${descriptionComment(schema.description)}${lineBreak}`
    : code``;
  return code`${description}  declare ${propertyKey(name)}${required ? code`` : code`?`}: ${modelFieldType(schema, definitions, env)};`;
}

function modelPropertyAccess(name: string): Code {
  return code`[${literal(name)}]`;
}

/** The local that holds one field's value, read once. */
function modelPresentLocal(index: number): Code {
  return localCode('value', index);
}

/**
 * The statement that reads the captured fields of `target` in the JSON view (`presentKeysCode`): one own-key pass, so an
 * inherited value never counts and a getter runs once. Empty when no field is captured. Constructor and decode use it.
 */
function modelPresentRead(indent: number, target: Code, captures: readonly (readonly [name: string, type: Code])[]): Code[] {
  if (captures.length === 0) return [];
  const locals = captures.map(([name, type], index) => ({ name, type, local: modelPresentLocal(index) }));
  const typeOf = (local: Code): Code => locals.find((entry) => entry.local === local)?.type ?? code`unknown`;
  return [code`${indentation(indent)}${presentKeysCode(target, locals.map(({ name, local }) => [name, local] as const), { declare: (local) => code`${local}: ${typeOf(local)} | undefined` })}`];
}

function modelPropertyAssignment(target: string, name: string, value: Code): Code {
  return code`${identifier(target)}${modelPropertyAccess(name)} = ${value};`;
}

/** Whether a model's group module exports its wire stringify: another group writes a recursive model under it in place and meets it again. */
function exportsWireStringify(graph: SchemaGraph, node: SchemaNode, profile: OpenApiGenerationProfile): boolean {
  return profile.validation && node.kind !== 'reference' && !node.sameSchema && node.validation !== false
    && reachesItself(graph, node);
}

function generatedFunctionName(nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire'): string {
  if (functionName === 'stringify') return `stringify${nodeId}`;
  if (functionName === 'fill') return fillFunctionName(nodeId);
  return functionName === 'fromWire' ? `fromWireFormat${nodeId}` : `toWireFormat${nodeId}`;
}

export function generateOpenApiModelArtifacts(
  document: unknown,
  profile: OpenApiGenerationProfile,
  analysis: OpenApiModelAnalysis,
  helpers: {
    readonly locate?: OriginLocator | undefined;
    /**
     * Compiles the SDK's validators module from the validation plan of every model and returns the name it exports
     * each root and each root's fast check under (`PlanValidators.exports`, `fastExports` and `passExports`). `groupPlans` are the plans the model groups' own schemas come from:
     * a companion imports the validators of its group's plan ids. Called once, and required when the profile validates.
     */
    readonly compileValidators?: (input: { readonly plan: CodecValidationPlan; readonly groupPlans: ReadonlyMap<string, CodecValidationPlan>; readonly locateModel: (name: string) => SchemaPlace }) => Pick<PlanValidators, 'exports' | 'fastExports' | 'passExports'>;
  } = {},
): { readonly files: ReadonlyMap<string, string>; readonly entryReexports: Code } {
  const { schemaGraph, definitions, ordered, grouping } = analysis;
  const { groups, owner, runtimeEdges } = grouping;
  const digest = sourceDigest(document);
  const stableId = (definition: ModelDefinition) => modelStableId(digest, definition);
  // A model is named by its identifier form; the document names the component by its own key.
  const schemaNameByModelName = new Map(ordered.flatMap((definition) => {
    const node = analysis.nodesByName.get(definition.name);
    return node ? [[node.name, definition.schemaName] as const] : [];
  }));
  const validationClosure = profile.validation
    ? openApiValidationSchemaClosure(schemaGraph, ordered, stableId)
    : [];
  const groupForModel = new Map<string, string>();
  const definitionsByGroup = new Map<string, ModelDefinition[]>();
  for (const group of groups) for (const name of group.models) groupForModel.set(name, group.id);
  const sharedModelEnv = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates);
  for (const definition of ordered) {
    const node = analysis.nodesByName.get(definition.name);
    const groupId = node ? owner.get(node.id) : undefined;
    if (!groupId) continue;
    const items = definitionsByGroup.get(groupId) ?? [];
    items.push(definition);
    definitionsByGroup.set(groupId, items);
  }
  const dependenciesByGroup = new Map<string, Set<string>>();
  const exportedFillFunctionsByGroup = new Map<string, Set<string>>();
  const exportedInitializersByGroup = new Map<string, Set<string>>();
  for (const group of groups) {
    const dependencies = new Set([...reachableSchemaNodes(schemaGraph, group.nodes, runtimeEdges)]
      .filter((id) => !group.nodes.has(id)));
    dependenciesByGroup.set(group.id, dependencies);
    for (const nodeId of dependencies) {
      const node = schemaGraph.nodes.get(nodeId);
      const dependencyGroupId = owner.get(nodeId);
      if (!node || node.kind !== 'object' || !dependencyGroupId || dependencyGroupId === group.id) continue;
      const exports = exportedFillFunctionsByGroup.get(dependencyGroupId) ?? new Set<string>();
      exports.add(nodeId);
      exportedFillFunctionsByGroup.set(dependencyGroupId, exports);
    }
  }
  // A union model's initializer that another group calls is a name of the module of the group that owns it, so the parts of the
  // property conversions say which initializers each group imports and which each group must export.
  const moduleSources = new Map<string, ImportSource>();
  const moduleSource = (specifier: string): ImportSource => {
    let source = moduleSources.get(specifier);
    if (!source) {
      source = new ImportSource(specifier, false, { sorted: true });
      moduleSources.set(specifier, source);
    }
    return source;
  };
  const validatorsSource = new ImportSource('../validators.generated.js', false, { sorted: true });
  const groupModules = new Map(groups.map((group) => [group.id, moduleSource(`./_${group.id}.js`)] as const));
  const initializerOwner = (own: string) => (reference: string): ImportSource | undefined => {
    const ownerId = groupForModel.get(reference);
    return ownerId !== undefined && ownerId !== own ? groupModules.get(ownerId) : undefined;
  };
  for (const group of groups) {
    const groupDefinitions = definitionsByGroup.get(group.id) ?? [];
    const external = initializerOwner(group.id);
    const context = localConversion((reference) => external(reference)?.name(`initialize${reference}`) ?? identifier(`initialize${reference}`));
    const initializerCalls = join(groupDefinitions.flatMap((definition) =>
      [...definition.properties.values()].map((schema) => modelInitCode(schema, VALUE, definitions, sharedModelEnv, definition.schemaName, context)),
    ), code`\n`);
    const called = [...groupModules].flatMap(([groupId, source]) => {
      if (groupId === group.id) return [];
      const used = new Set(importedNames(initializerCalls, source));
      return (definitionsByGroup.get(groupId) ?? []).filter((definition) => definition.isUnion && used.has(`initialize${definition.name}`)).map((definition) => [groupId, definition.name] as const);
    });
    for (const [groupId, reference] of called) {
      const exports = exportedInitializersByGroup.get(groupId) ?? new Set<string>();
      exports.add(reference);
      exportedInitializersByGroup.set(groupId, exports);
    }
  }
  const files = new Map<string, string>();
  const codecExports = (name: string): readonly (readonly [local: string, exported: string])[] => {
    const node = analysis.nodesByName.get(name);
    if (!node) return [];
    return [
      [`stringify${node.id}`, `stringify${name}`],
      [`parse${node.id}`, `parse${name}`],
      [`fromWireFormat${node.id}`, `fromWireFormat${name}`],
      [`toWireFormat${node.id}`, `toWireFormat${name}`],
      [`validate${node.id}`, `validate${name}`],
      [`assert${node.id}`, `assert${name}`],
      [`toWireFormat${node.id}`, `encode${name}`],
    ];
  };
  // Every group's validation plan comes first: the companions of a group import their validators by the names the
  // SDK's one validators module gives, and that module compiles every model in one plan.
  const groupPlans = new Map<string, CodecValidationPlan>();
  if (profile.validation) {
    for (const group of groups) {
      const dependencyCodecIds = new Set([...(dependenciesByGroup.get(group.id) ?? [])].flatMap((id) => {
        const node = schemaGraph.nodes.get(id);
        return node ? [node.codecId] : [];
      }));
      const externalCodecs = validationClosure.filter((entry) => dependencyCodecIds.has(entry.codecId));
      groupPlans.set(group.id, buildCodecValidationPlan(
        schemaGraphView(schemaGraph, group.nodes, dependenciesByGroup.get(group.id) ?? new Set<string>()),
        externalCodecs,
        {},
        profile.validation,
      ));
    }
  }
  if (profile.validation && !helpers.compileValidators) throw new Error('A validating SDK compiles its model validators with the operation validators; the caller names how.');
  const compiledValidators = profile.validation && helpers.compileValidators
    ? helpers.compileValidators({
      plan: buildCodecValidationPlan(schemaGraph, [], {}, profile.validation),
      groupPlans,
      locateModel: (name) => componentPlace(helpers.locate, schemaNameByModelName.get(name) ?? name, ''),
    })
    : undefined;
  const validatorExports = compiledValidators?.exports;
  const fastCheckExports = compiledValidators?.fastExports;
  const passCheckExports = compiledValidators?.passExports;
  for (const group of groups) {
    const localIds = group.nodes;
    const dependencyIds = dependenciesByGroup.get(group.id) ?? new Set<string>();
    const groupDefinitions = definitionsByGroup.get(group.id) ?? [];
    const groupPlan = groupPlans.get(group.id);
    const foreignGroup = (reference: string): string | undefined => {
      const groupId = groupForModel.get(reference);
      return groupId !== undefined && groupId !== group.id ? groupId : undefined;
    };
    const aliasModule = (alias: RecursiveAlias): ImportSource | undefined => {
      const groupId = alias.nodeId === undefined ? undefined : owner.get(alias.nodeId);
      return groupId !== undefined && groupId !== group.id ? groupModules.get(groupId) : undefined;
    };
    const foreignNames: ForeignNames = {
      model: (reference) => foreignGroup(reference) ? moduleSource(`./${reference}.js`).name(`${reference}Model`) : LOCAL_NAMES.model(reference),
      fields: (reference) => foreignGroup(reference) ? moduleSource(`./${reference}.js`).name(`${reference}Fields`, { typeOnly: true }) : LOCAL_NAMES.fields(reference),
      init: (reference) => foreignGroup(reference) ? moduleSource(`./${reference}.js`).name(`${reference}Init`, { typeOnly: true }) : LOCAL_NAMES.init(reference),
      aliasType: (alias) => aliasModule(alias)?.name(aliasModelTypeName(alias), { typeOnly: true }) ?? LOCAL_NAMES.aliasType(alias),
      aliasInit: (alias) => aliasModule(alias)?.name(aliasInitName(alias)),
      wireStringify: (codecId) => {
        const node = analysis.nodesByCodecId.get(codecId);
        const groupId = node ? owner.get(node.id) : undefined;
        return groupId !== undefined && groupId !== group.id ? moduleSource(`./_${groupId}.js`).name(wireStringifyExportName(codecId)) : identifier(wireStringifyExportName(codecId));
      },
    };
    const dependencyGroups = new Set([...dependencyIds].flatMap((nodeId) => {
      const dependencyGroupId = owner.get(nodeId);
      return dependencyGroupId && dependencyGroupId !== group.id ? [dependencyGroupId] : [];
    }));
    // A dependency may be needed only for schema registration. Importing its group for side effects ensures its codec
    // exists before addNestedCodecSchema resolves the closure; the named imports are the names the code uses.
    const sideEffectImports = [...dependencyGroups].sort().map((dependencyGroupId) => `./_${dependencyGroupId}.js`);
    const modelModule = generateModels(document, profile, {
      ...helpers,
      copyAdditionalProperties: groupDefinitions.some((definition) => Boolean(definition.additionalProperties)),
      analysis,
      onlyNames: group.models,
      graphNodeIds: localIds,
      dependencyNodeIds: dependencyIds,
      moduleFile: group.filename,
      foreignNames,
      moduleSources: () => [...moduleSources.values()].sort((left, right) => compareText(left.specifier, right.specifier)),
      sideEffectImports,
      ...(groupPlan && validatorExports ? { validatorsSource } : {}),
      initializerModule: initializerOwner(group.id),
      ...(validatorExports ? { validatorExports } : {}),
      ...(fastCheckExports ? { fastCheckExports } : {}),
      ...(passCheckExports ? { passCheckExports } : {}),
      codecFunctionImport: (nodeId, functionName) => {
        const dependencyGroupId = owner.get(nodeId);
        if (!dependencyGroupId || dependencyGroupId === group.id) return undefined;
        return moduleSource(`./_${dependencyGroupId}.js`).name(generatedFunctionName(nodeId, functionName));
      },
      exportedFillFunctionIds: exportedFillFunctionsByGroup.get(group.id),
      exportedInitializerNames: exportedInitializersByGroup.get(group.id),
    });
    files.set(group.filename, modelModule);
    for (const name of group.models) {
      const filename = `models/${name}.ts`;
      files.set(filename, render(code`${join([
        generatedBannerComment(),
        exportFrom([`${name}Model`, ...codecExports(name)], `./_${group.id}.js`),
        exportFrom([`${name}Fields`, `${name}JSON`, `${name}Init`], `./_${group.id}.js`, true),
      ], lineBreak)}\n`));
    }
  }
  const reexports = ordered.flatMap((definition) => [
    exportFrom([`${definition.name}Model`, ...codecExports(definition.name).map(([, exported]) => exported)], `./models/${definition.name}.js`),
    exportFrom([`${definition.name}Fields`, `${definition.name}JSON`, `${definition.name}Init`], `./models/${definition.name}.js`, true),
  ]);
  return { files, entryReexports: join(reexports, lineBreak) };
}

/**
 * A union model's decoder and initializer use the shared union conversion,
 * which dispatches on the discriminator table (or inferred required literal
 * tags) and rejects an unknown tag.
 */
function unionConversion(
  definition: ModelDefinition,
  direction: 'fromJSON' | 'fromInit',
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  context: ConversionContext,
): Code {
  const descriptor = modelConversionDescriptor(definition.rawSchema, definitions, env, 'from');
  const resolve = (reference: string) => modelResolver(reference, definitions, env, context);
  try {
    return direction === 'fromJSON'
      ? emitModelFromJSON(descriptor, VALUE, resolve, TEMPORAL_SERDE)
      : emitModelFromInit(descriptor, VALUE, resolve);
  } catch (thrown) {
    if (!isConversionConflict(thrown)) throw thrown;
    const error = codedConflict(thrown);
    const message = error instanceof Error ? error.message : String(error);
    const named = `schema ${JSON.stringify(definition.schemaName)}`;
    throw new LocatedError(
      `${named}: ${message}${thrown instanceof ObjectUnionDiscriminatorError ? '' : ' Declare an OpenAPI discriminator (propertyName and mapping) on the oneOf/anyOf, or give each variant a required const tag.'}`,
      [componentOrigin('schemas', definition.schemaName, named)],
      { cause: error },
    );
  }
}

/**
 * Emit codecs for a module. When the shared emitter rejects a conversion,
 * re-emit node by node to name the OpenAPI schema that caused it.
 */
function emitSchemaCodecRuntime(
  graph: SchemaGraph,
  codecOptions: Omit<CodecRuntimeOptions, 'modelBases'>,
  definitions: ModelDefinitions,
): Code {
  // Group modules import each other's codec functions, anonymous ones included.
  // A variant that a union selects extends the union: the declared bases say so, as the composition check reads them.
  const options: CodecRuntimeOptions = { ...codecOptions, exportAnonymousCodecs: true, modelBases: declaredModelBases(definitions) };
  try {
    return emitCodecRuntimeCode(graph, options);
  } catch (thrown) {
    if (!isConversionConflict(thrown)) throw thrown;
    // A conversion conflict that the emitter finds carries the resolver's code.
    const error = codedConflict(thrown);
    const message = error instanceof Error ? error.message : String(error);
    const failing = graph.topo().find((node) => {
      try {
        emitCodecRuntimeCode({ ...schemaGraphView(graph, new Set(graph.nodes.keys())), topo: () => [node] }, options);
        return false;
      } catch (probed) {
        if (!isConversionConflict(probed)) throw probed;
        return true;
      }
    });
    if (!failing) throw error;
    const definition = definitions.get(failing.name);
    const schemaName = definition?.schemaName ?? failing.name;
    const advice = /union/i.test(message) && !(thrown instanceof ObjectUnionDiscriminatorError)
      ? ' Declare an OpenAPI discriminator (propertyName and mapping) on the oneOf/anyOf, or give each object variant a required const tag.'
      : '';
    const named = `schema ${JSON.stringify(schemaName)}`;
    throw new LocatedError(`${named}: ${message}${advice}`, [componentOrigin('schemas', schemaName, named)], { cause: error });
  }
}

/** The order of the names in each import of the runtime parts of a model module. */
const IMPORT_OPTIONS: ImportOptions = {
  typeNames: 'ordered',
  modules: ['mobx-validation', 'model', 'conversion', 'temporal', 'serde', 'mobx'],
  order: MODEL_IMPORT_ORDER,
};

export function generateModels(
  document: unknown,
  profile: OpenApiGenerationProfile,
  helpers: {
    readonly copyAdditionalProperties?: boolean;
    readonly analysis?: OpenApiModelAnalysis;
    readonly onlyNames?: ReadonlySet<string>;
    readonly graphNodeIds?: ReadonlySet<string>;
    readonly dependencyNodeIds?: ReadonlySet<string>;
    readonly moduleFile?: string;
    /** What this module takes from other modules; without it every name is local. */
    readonly foreignNames?: ForeignNames;
    /** A function of a schema node that another module holds, as the part imported from it. */
    readonly codecFunctionImport?: (nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire') => Code | undefined;
    /** The sources of the modules this module may import names from, in the order of their statements. */
    readonly moduleSources?: () => readonly ImportSource[];
    /** The modules this module imports for their side effects, after the named imports. */
    readonly sideEffectImports?: readonly string[];
    /** The generated validators module, when `validatorExports` names validators to import. */
    readonly validatorsSource?: ImportSource;
    /** The module that exports the initializer of a union model, when another module owns the model; a call of it is a name of that module. */
    readonly initializerModule?: (reference: string) => ImportSource | undefined;
    /** The name the module's generated validators are exported under, by codec id and plane; set when `validatorsSource` imports them. */
    readonly validatorExports?: ReadonlyMap<string, string>;
    /** The name of each root's fast check, by the same keys, for the roots that have one. */
    readonly fastCheckExports?: ReadonlyMap<string, string>;
    /** The names of each root's structure check and predicates-only pass, by the same keys, for the roots that have them. */
    readonly passCheckExports?: ReadonlyMap<string, { readonly structure: string; readonly predicates: string }>;
    readonly exportedFillFunctionIds?: ReadonlySet<string>;
    readonly exportedInitializerNames?: ReadonlySet<string>;
  } = {},
): string {
  requireProfile(profile);
  const analysis = helpers.analysis ?? analyzeOpenApiModels(document, profile.validation);
  const definitions = analysis.definitions;
  const ordered = helpers.onlyNames
    ? analysis.ordered.filter((definition) => helpers.onlyNames?.has(definition.name))
    : analysis.ordered;
  const moduleScope = new ComponentNameScope('models.ts');
  const emitCopy = helpers.copyAdditionalProperties === true
    || (helpers.copyAdditionalProperties === undefined
      && ordered.some((definition) => definition.additionalProperties));
  if (emitCopy) moduleScope.claim('copyAdditionalProperties', 'internal helper copyAdditionalProperties');
  moduleScope.claim('Types', 'import binding Types');
  moduleScope.claim('ModelInit', 'import binding ModelInit');
  const reservedMembers = new Set(RESERVED_MODEL_MEMBERS);
  const typesModule = new ImportSource(helpers.moduleFile?.includes('/') ? '../types.js' : './types.js', true, { namespace: 'Types' });
  const typesNamespace = typesModule.namespace();
  const foreign = helpers.foreignNames;
  const models: ModelNames = { ...LOCAL_NAMES, ...foreign, types: typesNamespace };
  const sharedModelEnv = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates, models);
  const schemaGraph = analysis.schemaGraph;
  const emittedSchemaGraph = helpers.graphNodeIds
    ? schemaGraphView(schemaGraph, helpers.graphNodeIds, helpers.dependencyNodeIds)
    : schemaGraph;
  const codecIdFor = (name: string): string => {
    const node = analysis.nodesByName.get(name);
    return node?.codecId ?? name;
  };
  const names = new FunctionNames();
  // The initializer of a union model of this module is a helper: the module defines it when its code calls it, or when another module imports it.
  const unionInitializers = new Map<string, Helper>();
  const context: ConversionContext = {
    names,
    initializer: (reference) => {
      const owner = helpers.initializerModule?.(reference);
      if (owner) return owner.name(`initialize${reference}`);
      const local = unionInitializers.get(reference);
      return local ? helperName(local) : identifier(`initialize${reference}`);
    },
    models,
    nodeFunction: (nodeId, functionName) => helpers.codecFunctionImport?.(nodeId, functionName) ?? names.of(generatedFunctionName(nodeId, functionName)),
    aliasInit: (alias) => foreign?.aliasInit(alias) ?? names.of(aliasInitName(alias)),
  };
  const sharedSchemaContext = schemaContext(document, { resources: analysis.resources });
  const envOf = (definition: ModelDefinition): ModelResolveEnv => modelEnv(
    document,
    undefined,
    schemaContext(document, sharedSchemaContext, definition.schemaName, definition.rawSchema).anchors,
    analysis.resources,
    analysis.selections,
    analysis.dates,
    models,
  );
  const variantUnionOf = (definition: ModelDefinition): Code => join((definition.variants ?? []).map((variant) => models.model(variant)), code` | `);
  for (const definition of ordered) {
    if (!definition.isUnion) continue;
    const typeName = definition.name;
    const className = `${typeName}Model`;
    const variantUnion = variantUnionOf(definition);
    let defined: Code | undefined;
    unionInitializers.set(typeName, helper(`initialize${typeName}`, () => defined ??= join([
      code`${helpers.moduleFile ? code`export ` : code``}function ${identifier(`initialize${typeName}`)}(json: unknown): ${variantUnion} {`,
      code`  const value = ${rt.conversion.requireModelObject}(json, ${literal(className)});`,
      code`  const initialized: unknown = ${unionConversion(definition, 'fromInit', definitions, envOf(definition), context)};`,
      code`  return initialized as ${variantUnion};`,
      code`}`,
      code``,
    ], code`\n`)));
  }
  const BLANK = code``;
  const body: Piece[] = [
    COPY_ADDITIONAL_PROPERTIES,
  ];

  for (const definition of ordered) {
    const env = envOf(definition);
    const fieldEnv = withSchemaBase(env, definition.rawSchema);
    const typeName = definition.name;
    const className = `${typeName}Model`;
    const variantUnion = variantUnionOf(definition);
    moduleScope.claim(className, `generated model ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    for (const suffix of ['Fields', 'JSON', 'Init']) {
      moduleScope.claim(`${typeName}${suffix}`, `generated ${suffix} type for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    }
    moduleScope.claim(`decode${typeName}`, `internal decoder for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    const classScope = new NameScope(`${className} members`);
    const baseClass: Code | null = definition.baseName ? models.model(definition.baseName) : null;
    const fields = [...definition.properties.entries()];
    for (const [name] of fields) {
      classScope.rejectReserved(name, `field ${JSON.stringify(name)} on ${className}`, reservedMembers, 'generated model API member');
      classScope.claim(name, `field ${JSON.stringify(name)}`);
    }
    const additionalPropertyType: Code | null = definition.additionalProperties === true
      ? code`unknown`
      : isJsonObject(definition.additionalProperties)
        ? modelFieldType(definition.additionalProperties, definitions, fieldEnv)
        : null;
    const additionalIsUnknown = additionalPropertyType !== null && sameCode(additionalPropertyType, code`unknown`);
    const implementsType = definition.isUnion || (additionalPropertyType && !additionalIsUnknown) ? code`` : code` implements ${identifier(`${typeName}Fields`)}`;
    const declarations = fields.map(([name, schema]) =>
      modelFieldDeclaration(name, schema, definition.required.has(name), definitions, fieldEnv),
    );
    const assignments = [
      ...modelPresentRead(4, inputOf(VALUES), fields.map(([name]) => [name, code`${identifier(`${typeName}Init`)}${modelPropertyAccess(name)}`] as const)),
      ...fields.map(([name, schema], index) =>
        code`    if (${modelPresentLocal(index)} !== undefined) ${modelPropertyAssignment('this', name, code`(${modelInitCode(schema, modelPresentLocal(index), definitions, fieldEnv, definition.schemaName, context)}) as ${modelFieldType(schema, definitions, fieldEnv)}`)}`),
    ];
    const fieldHelpers: Code[] = [];
    const fieldHelperName = (index: number): string => {
      const helperId = `convert${typeName}Field${index}Decode`;
      moduleScope.claim(helperId, `internal field converter for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
      return helperId;
    };
    const allProperties = modelSchemaProperties(fieldEnv, definition.rawSchema);
    const allFieldNames = [...allProperties.keys()];
    const fieldNames = join(allFieldNames.map((name) => literal(name)), code`, `);
    const additionalConverter = (direction: 'from' | 'init'): Code | undefined => {
      if (!isJsonObject(definition.additionalProperties)) return undefined;
      const emit = direction === 'from' ? modelFromJSONCode : modelInitCode;
      const expression = emit(definition.additionalProperties, VALUE, definitions, fieldEnv, definition.schemaName, context);
      return sameCode(expression, VALUE) ? undefined : code`, (${VALUE}) => ${expression}`;
    };
    const decodeCaptures: (readonly [name: string, type: Code])[] = [];
    const decodeConversions: Code[] = [];
    for (const [name, schema] of allProperties) {
      const expression = modelPresentLocal(decodeCaptures.length);
      const rootConverted = wrapRootConversion(
        fieldHelpers, fieldHelperName, 'deserialize', literal(name), expression,
        (input) => modelFromJSONCode(schema, input, definitions, fieldEnv, definition.schemaName, context),
        code`unknown`,
      );
      // `result` already contains every own enumerable input property.  Keep
      // the initializer copy as-is for fields with no wire conversion and
      // only replace values that must become model instances or pass through
      // a codec.  The constructor remains the sole model-instance writer.
      if (sameCode(rootConverted, expression)) continue;
      decodeCaptures.push([name, code`unknown`]);
      decodeConversions.push(code`  if (${expression} !== undefined) ${modelPropertyAssignment('result', name, rootConverted)}`);
    }
    // Read the own copy in `result`, so a getter of the input runs once, in the spread.
    const decodeLines = [...modelPresentRead(2, identifier('result'), decodeCaptures), ...decodeConversions];
    const additionalFrom = additionalConverter('from');
    const identityDeserialize = decodeLines.length === 0 && additionalFrom === undefined;
    const initializer = unionInitializers.get(typeName);
    const optionalCopy = (direction: 'from' | 'init'): Code => additionalConverter(direction) ?? BLANK;
    // The constructor reads `values` through a base class, a declared field or the copy of additional
    // properties. A class whose code does not read the input declares the parameter under an underscore name.
    const named = (lines: readonly Code[], slot: InputSlot, used: string): { readonly lines: readonly Code[]; readonly parameter: Code } => {
      const parameter = identifier(lines.some((line) => inputCount(line, slot) > 0) ? used : `_${used}`);
      return { lines: lines.map((line) => bindInput(line, slot, parameter)), parameter };
    };
    const constructorBody = named([
      ...(baseClass ? [code`    super(${inputOf(VALUES)});`] : []),
      ...assignments,
      ...(additionalPropertyType
        ? [code`    if (${rt.model.findGeneratedModelDefinition}(this) === ${rt.model.findGeneratedModelDefinitionForConstructor}(${identifier(className)})) ${helperName(COPY_ADDITIONAL_PROPERTIES)}(this, ${inputOf(VALUES)}, [${fieldNames}]${optionalCopy('init')});`]
        : []),
      ...(profile.mobx && !definition.isUnion ? [
        code`    if (new.target === ${identifier(className)}) ${rt.mobx.asGenObservable}(this);`,
      ] : []),
    ], VALUES, 'values');
    const constructorLines = [
      code`  constructor(${constructorBody.parameter}: ${identifier(`${typeName}Init`)} = {}) {`,
      ...constructorBody.lines,
    ];
    body.push(
      code`export type ${identifier(`${typeName}Fields`)} = ${definition.baseName ? code`${models.fields(definition.baseName)} & ` : code``}{`,
      ...fields.map(([name, schema]) => code`  ${propertyKey(name)}${definition.required.has(name) ? code`` : code`?`}: ${modelFieldType(schema, definitions, fieldEnv)};`),
      ...(additionalPropertyType ? [code`  [key: string]: ${fields.length || definition.baseName ? code`unknown` : additionalPropertyType};`] : []),
      code`};`,
      code`export type ${identifier(`${typeName}JSON`)} = ${typesNamespace}.${identifier(typeName)};`,
      code`export type ${identifier(`${typeName}Init`)} = ${rtType.model.ModelInit}<${identifier(`${typeName}Fields`)}>;`,
      BLANK,
      ...fieldHelpers.flatMap(each => [each, BLANK]),
      ...(!definition.isUnion ? [
        code`function ${identifier(`deserialize${typeName}Fields`)}(json: unknown): ${identifier(`${typeName}Init`)} {`,
        code`  const value = ${rt.conversion.requireModelObject}(json, ${literal(className)});`,
        ...(identityDeserialize
          ? [code`  return value as ${identifier(`${typeName}Init`)};`]
          : [
            code`  const result: Record<string, unknown> = { ...value };`,
            ...decodeLines,
            ...(additionalFrom ? [code`  ${helperName(COPY_ADDITIONAL_PROPERTIES)}(result, value, [${fieldNames}]${additionalFrom});`] : []),
            code`  return result as ${identifier(`${typeName}Init`)};`,
          ]),
        code`}`,
        BLANK,
      ] : initializer ? [initializer] : []),
      code`export ${definition.isUnion ? code`abstract ` : code``}class ${identifier(className)}${baseClass ? code` extends ${baseClass}` : code``}${implementsType} {`,
      ...(additionalPropertyType && additionalIsUnknown ? [code`  [key: string]: unknown;`] : []),
      ...declarations,
      code`  declare readonly [${rtType.model.generatedModelWireBrand}]: ${typesNamespace}.${identifier(typeName)};`,
      code`  declare readonly [${rtType.model.generatedModelFieldsBrand}]: ${identifier(`${typeName}Fields`)};`,
      ...(definition.isUnion ? [code`  declare static readonly [${rtType.model.generatedModelResultBrand}]: ${variantUnion};`] : []),
      ...(definition.sharedVariants ? [
        code`  static [Symbol.hasInstance](value: unknown): value is ${variantUnion} {`,
        code`    return Function.prototype[Symbol.hasInstance].call(this, value) || (this === ${identifier(className)} && (${join(definition.sharedVariants.map((variant) => code`value instanceof ${models.model(variant)}`), code` || `)}));`,
        code`  }`,
      ] : []),
      ...constructorLines,
      code`  }`,
      BLANK,
      code`}`,
      BLANK,
      ...(definition.isUnion ? [
        code`function ${identifier(`decode${typeName}`)}(json: unknown): ${variantUnion} {`,
        code`  const value = ${rt.conversion.requireModelObject}(json, ${literal(className)}) as Partial<${typesNamespace}.${identifier(typeName)}>;`,
        code`  const decoded: unknown = ${unionConversion(definition, 'fromJSON', definitions, env, context)};`,
        code`  return decoded as ${variantUnion};`,
        code`}`,
      ] : [
        code`function ${identifier(`decode${typeName}`)}(json: unknown, constructor: ${rtType.model.GeneratedModelConstructor} = ${identifier(className)}): ${identifier(className)} {`,
        code`  return Reflect.construct(constructor, [${identifier(`deserialize${typeName}Fields`)}(json)]) as ${identifier(className)};`,
        code`}`,
      ]),
      BLANK,
      code`${rt.model.registerGeneratedModel}(${identifier(className)}, {`,
      code`  fields: [${fieldNames}] as const,`,
      code`  conversion: { decode: ${identifier(`decode${typeName}`)} },`,
      code`  codecId: ${literal(codecIdFor(definition.name))},`,
      code`  profile: { validation: ${literal(profile.validation)} },`,
      ...(profile.validation && profile.mobx ? [code`  enhanceValidator: ${rt['mobx-validation'].enhanceValidatorWithMobX},`] : []),
      ...(additionalPropertyType ? [code`  additionalProperties: true,`] : []),
      code`});`,
      BLANK,
      code`${rt.serde.registerIModelClass}(${literal(codecIdFor(definition.name))}, ${identifier(className)});`,
      BLANK,
    );
  }
  for (const alias of definitions.aliases.values()) {
    if (helpers.graphNodeIds && !(alias.nodeId !== undefined && helpers.graphNodeIds.has(alias.nodeId))) continue;
    if (!aliasConvertsValue(alias, definitions, sharedModelEnv)) continue;
    const aliasType = aliasModelTypeName(alias);
    moduleScope.claim(aliasType, `model type of the recursive component ${JSON.stringify(alias.schemaName)}`, alias.schemaName);
    body.push(code`export type ${identifier(aliasType)} = ${modelFieldType(alias.rawSchema, definitions, componentEnv(sharedModelEnv, alias.schemaName, alias.rawSchema))};`, BLANK);
    if (aliasInitsModel(alias, definitions, sharedModelEnv)) {
      moduleScope.claim(aliasInitName(alias), `initializer of the recursive component ${JSON.stringify(alias.schemaName)}`, alias.schemaName);
      const aliasBody = withConflictCode(alias.schemaName, () => emitModelFromInit(aliasDescriptor(alias, definitions, sharedModelEnv), VALUE, (reference) => modelResolver(reference, definitions, sharedModelEnv, context)));
      body.push(
        code`export function ${identifier(aliasInitName(alias))}(value: unknown): ${identifier(aliasType)} {`,
        code`  return (${aliasBody}) as ${identifier(aliasType)};`,
        code`}`,
        BLANK,
      );
    }
  }
  const validatorsSource = helpers.validatorsSource;
  const aliasesByNodeId = new Map([...definitions.aliases.values()].flatMap((alias) => alias.nodeId === undefined ? [] : [[alias.nodeId, alias] as const]));
  const codecRuntimeOptions: Omit<CodecRuntimeOptions, 'modelBases'> = {
    validationEnabled: profile.validation,
    serde: TEMPORAL_SERDE,
    ...(helpers.validatorExports ? {
      validatorName: (id: string) => {
        const name = helpers.validatorExports?.get(id);
        if (name === undefined || validatorsSource === undefined) throw new Error(`The generated validators module has no validator for ${JSON.stringify(id)}.`);
        return validatorsSource.name(name);
      },
    } : {}),
    ...(helpers.fastCheckExports ? { fastCheckName: (id: string) => {
      const name = helpers.fastCheckExports?.get(id);
      return name === undefined ? undefined : validatorsSource?.name(name);
    } } : {}),
    ...(helpers.passCheckExports ? { passCheckNames: (id: string) => {
      const names = helpers.passCheckExports?.get(id);
      return names === undefined || validatorsSource === undefined ? undefined : { structure: validatorsSource.name(names.structure), predicates: validatorsSource.name(names.predicates) };
    } } : {}),
    issueSource: 'OpenAPI',
    exportWireStringify: (node) => exportsWireStringify(analysis.schemaGraph, node, profile),
    siblingWireCodecIds: new Set([...(helpers.dependencyNodeIds ?? [])].flatMap((id) => {
      const node = analysis.nodesById.get(id);
      return node && exportsWireStringify(analysis.schemaGraph, node, profile) ? [node.codecId] : [];
    })),
    wireType: (node) => {
      const modelName = analysis.definitionNameByNodeId.get(node.id);
      const alias = aliasesByNodeId.get(node.id);
      return modelName !== undefined && definitions.has(modelName) ? code`${typesNamespace}.${identifier(modelName)}` : alias === undefined ? undefined : code`${typesNamespace}.${identifier(alias.name)}`;
    },
    fieldsType: (node) => {
      const modelName = analysis.definitionNameByNodeId.get(node.id);
      const alias = aliasesByNodeId.get(node.id);
      return modelName !== undefined && definitions.has(modelName) ? models.fields(modelName) : alias === undefined ? undefined : aliasUseType(alias, definitions, sharedModelEnv);
    },
    ...(foreign ? { siblingWireName: foreign.wireStringify } : {}),
    ...(helpers.exportedFillFunctionIds ? { exportedFillFunctionIds: helpers.exportedFillFunctionIds } : {}),
    nestedConstruct: (codecId) => {
      const node = analysis.nodesByCodecId.get(codecId)
        ?? analysis.nodesByName.get(codecId)
        ?? analysis.nodesById.get(codecId);
      const modelName = node ? analysis.definitionNameByNodeId.get(node.id) ?? node.name : codecId;
      return models.model(modelName);
    },
    nestedGenerated: (name) => {
      const node = analysis.nodesByName.get(name)
        ?? analysis.nodesById.get(name)
        ?? analysis.nodesByCodecId.get(name);
      const modelName = node ? analysis.definitionNameByNodeId.get(node.id) ?? node.name : name;
      return node?.emitClass ? models.model(modelName) : undefined;
    },
    nestedImportedSerde: (codecId) => {
      if (!helpers.codecFunctionImport) return undefined;
      const node = analysis.nodesByCodecId.get(codecId) ?? analysis.nodesById.get(codecId);
      if (!node || helpers.graphNodeIds?.has(node.id)) return undefined;
      const stringify = helpers.codecFunctionImport(node.id, 'stringify');
      const fill = helpers.codecFunctionImport(node.id, 'fill');
      const fromWire = helpers.codecFunctionImport(node.id, 'fromWire');
      const toWire = helpers.codecFunctionImport(node.id, 'toWire');
      return stringify && fromWire && toWire
        ? { stringify, fromWire, toWire, ...(fill ? { fill } : {}) }
        : undefined;
    },
  };
  body.push(emitSchemaCodecRuntime(emittedSchemaGraph, codecRuntimeOptions, definitions));
  // What the code calls decides the runtime imports and which helpers the module defines.
  const exportedInitializers = [...unionInitializers].filter(([name]) => helpers.exportedInitializerNames?.has(name)).map(([, each]) => helperName(each));
  const calls = join([...body.filter(isCode), ...exportedInitializers], code`\n`);
  const runtimeLines = runtimeLinesOf(calls, IMPORT_OPTIONS);
  const bodyLines = placeHelpers(calls, body, MODULE_CONSTANT_HELPERS);
  const bodyCode = join(bodyLines, code`\n`);
  const moduleSources = helpers.moduleSources?.() ?? [];
  const validatorSources = validatorsSource ? [validatorsSource] : [];
  const lines: readonly Code[] = [
    generatedBannerComment(),
    ...runtimeLines('mobx-validation', 'model', 'conversion', 'temporal', 'serde', 'mobx'),
    ...fileImports(bodyCode, [typesModule], { elsewhere: [...moduleSources, ...validatorSources] }),
    ...fileImports(bodyCode, moduleSources, { quote: '"', elsewhere: [typesModule, ...validatorSources] }),
    ...(helpers.sideEffectImports ?? []).map((specifier) => sideEffectImport(specifier, '"')),
    ...fileImports(bodyCode, validatorSources, { elsewhere: [typesModule, ...moduleSources] }),
    BLANK,
    ...bodyLines,
  ];
  return render(code`${join(lines, code`\n`)}\n`, names.table);
}
