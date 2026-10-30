import {
  AmbiguousUnionConversionError,
  CompositionConflictError,
  ObjectUnionDiscriminatorError,
  emitModelFromJSON,
  code,
  isCode,
  runtimeLinesOf,
  MODEL_IMPORT_ORDER,
  type Piece,
  emitCodecRuntimeCode,
  fileImports,
  identifier,
  MODULE_CONSTANT_HELPERS,
  placeHelpers,
  ImportSource,
  join,
  lineBreak,
  render,
  type Code,
  type ImportOptions,
  fillFunctionName,
  sideEffectImport,
  reachesItself,
  wireStringifyExportName,
  TEMPORAL_SERDE,
  writeOperationCodecs,
  type SdkKeyedCode,
  type SdkOperationCodecs,
  type CodecRuntimeOptions,
  type FromJsonModelResolver,
} from '@exprtlabs/golem/internal/emitter';
import { type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { CodecValidationPlan, PlanValidators, SchemaPlace } from '@exprtlabs/golem/internal/validation-plan';
import { identifier as typeIdentifier, sourceDigest } from '@exprtlabs/golem/internal/generator-support';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import { compareText } from '@exprtlabs/golem/generator-api';
import { asRecord } from './json.js';
import type { NormalizedOperation } from './normalize.js';
import { componentOrigin, componentPlace, LocatedError, type OriginLocator } from './origin.js';
import { COMPOSITION_CONVERSION_CONFLICT, conflictMessage } from './composition.js';
import { generatedBannerComment } from './package-info.js';
import type { RuntimeSpecifiers } from './runtime-copy.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  type ModelDefinition,
  ModelDefinitions,
  type ModelResolveEnv,
  type OpenApiModelAnalysis,
  declaredModelBases,
  modelBases,
  modelStableId,
  modelConversionDescriptor,
  CompositionError,
  locatedCompositionError,
  type CompositionSite,
} from './model-resolution.js';
import { openApiValidationSchemaClosure } from './model-manifest.js';
import { analyzeOpenApiModels, parameterKey, reachableSchemaNodes, requestBodyKey, responseBodyKey, responseHeaderKey, schemaGraphView } from './model-schema-graph.js';

/** The bases of the model that `reference` names, when it has any. */
function referenceBases(reference: string, definitions: ModelDefinitions): { readonly bases?: ReturnType<typeof modelBases> } {
  const bases = modelBases(definitions.get(reference));
  return bases.length ? { bases } : {};
}

/** The resolver of a conversion that is checked and never written: a use of a model writes no call. */
function checkResolver(reference: string, definitions: ModelDefinitions): FromJsonModelResolver {
  return { className: identifier(reference), decode: (value) => value, ...referenceBases(reference, definitions) };
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

/** Builds the conversion of a schema and writes nothing: it throws when the schema does not convert. */
export function checkModelFromJSON(
  schema: unknown,
  expression: string,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
): void {
  withConflictCode(owner, () => emitModelFromJSON(
    modelConversionDescriptor(schema, definitions, env, 'from'),
    identifier(expression),
    (reference) => checkResolver(reference, definitions),
    TEMPORAL_SERDE,
  ));
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
    /** Where each model group imports its runtime from; the package's own entries when absent (see `standaloneRuntimeSpecifiers`). */
    readonly specifiers?: RuntimeSpecifiers;
    /**
     * Compiles the SDK's validators module from the validation plan of every model and returns the name it exports
     * each root and each root's fast check under (`PlanValidators.exports`, `fastExports` and `passExports`).
     * `groupPlans` are the plans the model groups' own schemas come from:
     * a companion imports the validators of its group's plan ids. `reachedRoots` are the roots of `plan` that the written groups use: the module exports those and the roots of the operations.
     * Called once, and required when the profile validates.
     */
    readonly compileValidators?: (input: { readonly plan: CodecValidationPlan; readonly groupPlans: ReadonlyMap<string, CodecValidationPlan>; readonly reachedRoots: ReadonlySet<string>; readonly locateModel: (name: string) => SchemaPlace }) => Pick<PlanValidators, 'exports' | 'fastExports' | 'passExports'>;
  } = {},
): { readonly files: ReadonlyMap<string, string> } {
  const { schemaGraph, ordered, grouping } = analysis;
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
  const dependenciesByGroup = new Map<string, Set<string>>();
  const exportedFillFunctionsByGroup = new Map<string, Set<string>>();
  const importedGroupsByGroup = new Map<string, Set<string>>();
  for (const group of groups) {
    const dependencies = new Set([...reachableSchemaNodes(schemaGraph, group.nodes, runtimeEdges)]
      .filter((id) => !group.nodes.has(id)));
    dependenciesByGroup.set(group.id, dependencies);
    const importedGroups = new Set<string>();
    importedGroupsByGroup.set(group.id, importedGroups);
    for (const nodeId of dependencies) {
      const node = schemaGraph.nodes.get(nodeId);
      const dependencyGroupId = owner.get(nodeId);
      if (dependencyGroupId && dependencyGroupId !== group.id) importedGroups.add(dependencyGroupId);
      if (!node || node.kind !== 'object' || !dependencyGroupId || dependencyGroupId === group.id) continue;
      const exports = exportedFillFunctionsByGroup.get(dependencyGroupId) ?? new Set<string>();
      exports.add(nodeId);
      exportedFillFunctionsByGroup.set(dependencyGroupId, exports);
    }
  }
  // Every group is generated, so each schema check and diagnostic runs whether or not an operation reaches the model.
  // A group is written when an operation body reaches it or a written group imports it; no other group has a reader.
  const written = new Set<string>();
  const pending = [...analysis.convertedNodeIds.values()].flatMap((nodeId) => owner.get(nodeId) ?? []);
  for (let groupId = pending.pop(); groupId !== undefined; groupId = pending.pop()) {
    if (written.has(groupId)) continue;
    written.add(groupId);
    pending.push(...importedGroupsByGroup.get(groupId) ?? []);
  }
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
  const files = new Map<string, string>();
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
  const wholePlan = profile.validation && helpers.compileValidators ? buildCodecValidationPlan(schemaGraph, [], {}, profile.validation) : undefined;
  // A written group runs the checks of its own nodes and of the nodes it reaches in other groups, on every plane of each.
  const reachedRoots = new Set<string>();
  for (const group of groups.filter(({ id }) => written.has(id))) {
    for (const key of Object.keys(groupPlans.get(group.id)?.schemas ?? {})) reachedRoots.add(key);
    const codecIds = new Set([...group.nodes, ...dependenciesByGroup.get(group.id) ?? []].flatMap((id) => schemaGraph.nodes.get(id)?.codecId ?? []));
    for (const root of Object.keys(wholePlan?.schemas ?? {})) {
      if (codecIds.has(root) || codecIds.has(root.split('#')[0] ?? '')) reachedRoots.add(root);
    }
  }
  const compiledValidators = profile.validation && helpers.compileValidators && wholePlan
    ? helpers.compileValidators({
      plan: wholePlan,
      groupPlans,
      reachedRoots,
      locateModel: (name) => componentPlace(helpers.locate, schemaNameByModelName.get(name) ?? name, ''),
    })
    : undefined;
  const validatorExports = compiledValidators?.exports;
  // A group that nothing reads is generated for its checks and diagnostics and not written: the module exports none of its validators, and
  // any name serves its discarded code.
  const discardedExports = validatorExports && wholePlan
    ? new Map([...Object.keys(wholePlan.schemas).map((id, index) => [id, `discarded${index}`] as const), ...validatorExports])
    : undefined;
  const fastCheckExports = compiledValidators?.fastExports;
  const passCheckExports = compiledValidators?.passExports;
  for (const group of groups) {
    const localIds = group.nodes;
    const dependencyIds = dependenciesByGroup.get(group.id) ?? new Set<string>();
    const groupPlan = groupPlans.get(group.id);
    const wireStringify = (codecId: string): Code => {
      const node = analysis.nodesByCodecId.get(codecId);
      const groupId = node ? owner.get(node.id) : undefined;
      return groupId !== undefined && groupId !== group.id ? moduleSource(`./_${groupId}.js`).name(wireStringifyExportName(codecId)) : identifier(wireStringifyExportName(codecId));
    };
    const dependencyGroups = new Set([...dependencyIds].flatMap((nodeId) => {
      const dependencyGroupId = owner.get(nodeId);
      return dependencyGroupId && dependencyGroupId !== group.id ? [dependencyGroupId] : [];
    }));
    // Importing a dependency group for side effects registers its codecs before this group's own run; the named imports are the names the code uses.
    // A standalone SDK (it names its runtime in `specifiers`) registers nothing, so it needs no such import.
    const { specifiers, ...rest } = helpers;
    const sideEffectImports = specifiers ? [] : [...dependencyGroups].sort().map((dependencyGroupId) => `./_${dependencyGroupId}.js`);
    const modelModule = generateModels(document, profile, {
      ...rest,
      ...(specifiers ? { specifiers: specifiers(group.filename) } : {}),
      analysis,
      graphNodeIds: localIds,
      dependencyNodeIds: dependencyIds,
      moduleFile: group.filename,
      wireStringify,
      moduleSources: () => [...moduleSources.values()].sort((left, right) => compareText(left.specifier, right.specifier)),
      sideEffectImports,
      ...(groupPlan && validatorExports ? { validatorsSource } : {}),
      ...(validatorExports ? { validatorExports: written.has(group.id) ? validatorExports : discardedExports } : {}),
      ...(fastCheckExports ? { fastCheckExports } : {}),
      ...(passCheckExports ? { passCheckExports } : {}),
      codecFunctionImport: (nodeId, functionName) => {
        const dependencyGroupId = owner.get(nodeId);
        if (!dependencyGroupId || dependencyGroupId === group.id) return undefined;
        return moduleSource(`./_${dependencyGroupId}.js`).name(generatedFunctionName(nodeId, functionName));
      },
      exportedFillFunctionIds: exportedFillFunctionsByGroup.get(group.id),
    });
    if (written.has(group.id)) files.set(group.filename, modelModule);
  }
  return { files };
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

/** The order of the names in each import of the runtime parts of a codec module. */
const IMPORT_OPTIONS: ImportOptions = {
  typeNames: 'ordered',
  modules: ['conversion', 'temporal', 'serde'],
  order: MODEL_IMPORT_ORDER,
};

function generateModels(
  document: unknown,
  profile: OpenApiGenerationProfile,
  helpers: {
    readonly analysis?: OpenApiModelAnalysis;
    readonly graphNodeIds?: ReadonlySet<string>;
    readonly dependencyNodeIds?: ReadonlySet<string>;
    readonly moduleFile?: string;
    /** The wire stringify that the companion of a sibling codec exports: a part imported from the group that holds it, or a local name. */
    readonly wireStringify?: (codecId: string) => Code;
    /** A function of a schema node that another module holds, as the part imported from it. */
    readonly codecFunctionImport?: (nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire') => Code | undefined;
    /** The sources of the modules this module may import names from, in the order of their statements. */
    readonly moduleSources?: () => readonly ImportSource[];
    /** Where the module imports its runtime values and types from; the package's own entries when absent. */
    readonly specifiers?: ImportOptions['specifiers'];
    /** The modules this module imports for their side effects, after the named imports. */
    readonly sideEffectImports?: readonly string[];
    /** The generated validators module, when `validatorExports` names validators to import. */
    readonly validatorsSource?: ImportSource;
    /** The name the module's generated validators are exported under, by codec id and plane; set when `validatorsSource` imports them. */
    readonly validatorExports?: ReadonlyMap<string, string>;
    /** The name of each root's fast check, by the same keys, for the roots that have one. */
    readonly fastCheckExports?: ReadonlyMap<string, string>;
    /** The names of each root's structure check and predicates-only pass, by the same keys, for the roots that have them. */
    readonly passCheckExports?: ReadonlyMap<string, { readonly structure: string; readonly predicates: string }>;
    readonly exportedFillFunctionIds?: ReadonlySet<string>;
  } = {},
): string {
  requireProfile(profile);
  const analysis = helpers.analysis ?? analyzeOpenApiModels(document, profile.validation);
  const definitions = analysis.definitions;
  const typesModule = new ImportSource(helpers.moduleFile?.includes('/') ? '../types.js' : './types.js', true, { namespace: 'Types' });
  const schemaGraph = analysis.schemaGraph;
  const emittedSchemaGraph = helpers.graphNodeIds
    ? schemaGraphView(schemaGraph, helpers.graphNodeIds, helpers.dependencyNodeIds)
    : schemaGraph;
  const validatorsSource = helpers.validatorsSource;
  const codecRuntimeOptions: Omit<CodecRuntimeOptions, 'modelBases'> = {
    validationLevel: profile.validation,
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
    projectsInstanceState: true,
    // Only golem's own registry reads a registered codec; a standalone SDK (it names its runtime in `specifiers`) registers none.
    registerCodecs: helpers.specifiers === undefined,
    // A component's codecs take and return its converted `Types` type; a node that is no component, and so has no type there, stays `unknown`.
    fieldsType: (node) => {
      const definition = analysis.definitionNameByNodeId.has(node.id) ? definitions.get(analysis.definitionNameByNodeId.get(node.id) ?? '') : undefined;
      const declared = definition !== undefined && Object.hasOwn(asRecord(asRecord(asRecord(document).components).schemas), definition.schemaName);
      return definition !== undefined && declared && typeIdentifier(definition.schemaName) === definition.name ? code`${typesModule.namespace()}.${identifier(definition.name)}` : undefined;
    },
    exportWireStringify: (node) => exportsWireStringify(analysis.schemaGraph, node, profile),
    siblingWireCodecIds: new Set([...(helpers.dependencyNodeIds ?? [])].flatMap((id) => {
      const node = analysis.nodesById.get(id);
      return node && exportsWireStringify(analysis.schemaGraph, node, profile) ? [node.codecId] : [];
    })),
    ...(helpers.wireStringify ? { siblingWireName: helpers.wireStringify } : {}),
    ...(helpers.exportedFillFunctionIds ? { exportedFillFunctionIds: helpers.exportedFillFunctionIds } : {}),
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
  const body: Piece[] = [emitSchemaCodecRuntime(emittedSchemaGraph, codecRuntimeOptions, definitions)];
  // What the code calls decides the runtime imports and which helpers the module defines.
  const calls = join(body.filter(isCode), code`\n`);
  const runtimeLines = runtimeLinesOf(calls, helpers.specifiers ? { ...IMPORT_OPTIONS, specifiers: helpers.specifiers } : IMPORT_OPTIONS);
  const bodyLines = placeHelpers(calls, body, MODULE_CONSTANT_HELPERS);
  const bodyCode = join(bodyLines, code`\n`);
  const moduleSources = helpers.moduleSources?.() ?? [];
  const validatorSources = validatorsSource ? [validatorsSource] : [];
  const lines: readonly Code[] = [
    generatedBannerComment(),
    ...runtimeLines('conversion', 'temporal', 'serde'),
    ...fileImports(bodyCode, [typesModule], { elsewhere: [...moduleSources, ...validatorSources] }),
    ...fileImports(bodyCode, moduleSources, { quote: '"', elsewhere: [typesModule, ...validatorSources] }),
    ...(helpers.sideEffectImports ?? []).map((specifier) => sideEffectImport(specifier, '"')),
    ...fileImports(bodyCode, validatorSources, { elsewhere: [typesModule, ...moduleSources] }),
    code``,
    ...bodyLines,
  ];
  return render(code`${join(lines, code`\n`)}\n`);
}

/** The validators of an operation in the SDK's validators module: the export names of its input check and of each response check, under the key `status:contentType`. */
export interface OperationValidatorNames {
  readonly input: string;
  /** The export name of the check of the header parameters, when the operation has any. */
  readonly headers?: string;
  readonly responses: readonly { readonly key: string; readonly name: string }[];
  /** The export name of the check of each declared response header that has a schema, under the key `status:name`. */
  readonly responseHeaders: readonly { readonly key: string; readonly name: string }[];
}

/**
 * The codec module of each operation that validates or converts, by file name (`codecs/<operation>.ts`): the validators of its input and responses,
 * the conversion of each request body and parameter, and of each response body, stream item and response header, that converts something (`OpenApiModelAnalysis.convertedNodeIds`).
 * A client operation encodes its request and decodes its response. An inbound operation (a webhook or a callback) is the other way round:
 * it decodes its request and encodes its response, so its request tables hold `fromWire` and its response tables `toWire`.
 * An operation module imports its own file, so a bundler that drops an operation drops its codecs and the groups only they reach.
 */
export function generateOperationCodecs(
  operations: readonly NormalizedOperation[],
  profile: OpenApiGenerationProfile,
  analysis: OpenApiModelAnalysis,
  validators: ReadonlyMap<string, OperationValidatorNames> | undefined,
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const operation of operations) {
    const validatorsSource = new ImportSource('../validators.generated.js', false, { sorted: true });
    const groupSources = new Map(analysis.grouping.groups.map((group) => [group.id, new ImportSource(`../models/_${group.id}.js`, false, { sorted: true })] as const));
    const inbound = operation.sourceKind !== 'path';
    // The request of a client operation leaves in its wire form and its response arrives in its plain form; the traffic of an inbound operation runs the other way.
    const requestConversion = inbound ? 'fromWire' : 'toWire';
    const responseConversion = inbound ? 'toWire' : 'fromWire';
    const codecOf = (valueKey: string, functionName: 'fromWire' | 'toWire'): Code | undefined => {
      const nodeId = analysis.convertedNodeIds.get(valueKey);
      const groupId = nodeId === undefined ? undefined : analysis.grouping.owner.get(nodeId);
      return nodeId !== undefined && groupId !== undefined ? groupSources.get(groupId)?.name(generatedFunctionName(nodeId, functionName)) : undefined;
    };
    const keyed = (items: ReadonlyArray<readonly [string, Code | undefined]>): SdkKeyedCode[] => items.flatMap(([key, codec]) => codec ? [{ key, code: codec }] : []);
    const checks = validators?.get(operation.name);
    const responses = operation.responses.flatMap((response) => response.content.map((media) => [response.status, media.contentType] as const));
    const encode = keyed(operation.requestContent.map((media) => [media.contentType, codecOf(requestBodyKey(operation.name, media.contentType), requestConversion)]));
    const decode = keyed(responses.map(([status, contentType]) => [`${status}:${contentType}`, codecOf(responseBodyKey(operation.name, status, contentType), responseConversion)]));
    // An inbound response body that converts is judged by its conversion; when its descriptors miss a keyword of its schema, the wire check judges it too.
    const wireChecked = inbound ? responses.map(([status, contentType]) => [`${status}:${contentType}`, responseBodyKey(operation.name, status, contentType)] as const)
      .filter(([, valueKey]) => analysis.uncarriedValues.has(valueKey)).map(([key]) => key) : [];
    const parameters = keyed(operation.parameters.map((parameter) => [`${parameter.in}:${parameter.name}`, codecOf(parameterKey(operation.name, parameter.in, parameter.name), requestConversion)]));
    const headers = keyed(operation.responses.flatMap((response) => Object.keys(response.headers).map((name) => [`${response.status}:${name}`, codecOf(responseHeaderKey(operation.name, response.status, name), responseConversion)] as const)));
    if (!profile.validation && !encode.length && !decode.length && !parameters.length && !headers.length) continue;
    const codecs: SdkOperationCodecs = {
      ...(checks ? { input: validatorsSource.name(checks.input), ...(checks.headers === undefined ? {} : { requestHeaders: validatorsSource.name(checks.headers) }), responses: checks.responses.map((item) => ({ key: item.key, code: validatorsSource.name(item.name) })), responseHeaders: checks.responseHeaders.map((item) => ({ key: item.key, code: validatorsSource.name(item.name) })) } : {}),
      ...(encode.length ? { encode } : {}),
      ...(decode.length ? { decode } : {}),
      ...(wireChecked.length ? { wireChecked } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(headers.length ? { headers } : {}),
    };
    files.set(`codecs/${operation.name}.ts`, writeOperationCodecs(codecs, { banner: generatedBannerComment(), sources: [validatorsSource, ...groupSources.values()] }));
  }
  return files;
}
