import {
  CompositionConflictError,
  ObjectUnionDiscriminatorError,
  emitModelFromJSON,
  FIELD_CONVERSION_INPUT,
  singleCallConverter,
  emitModelFromInit,
  emitModelToJSON,
  emitCodecRuntime,
  fillFunctionName,
  presentKeysSource,
  pruneGeneratedImports,
  reachesItself,
  wireStringifyExportName,
  type CodecRuntimeOptions,
  type FromJsonModelResolver,
  type ModelDiscriminators,
} from '@exprtlabs/golem/internal/emitter';
import { type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { CodecValidationPlan, PlanValidators, SchemaPlace } from '@exprtlabs/golem/internal/validation-plan';
import { sourceDigest } from '@exprtlabs/golem/manifest';
import { buildCodecValidationPlan, uniqueDiagnostics } from '@exprtlabs/golem/internal/validation-plan';
import type { DiscriminatorValue, ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { isJsonObject } from './json.js';
import { compareText, NameScope, propertyName, RESERVED_MODEL_MEMBERS, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { componentOrigin, componentPlace, ComponentNameScope, LocatedError, type OriginLocator } from './origin.js';
import { COMPOSITION_CONVERSION_CONFLICT, conflictMessage } from './composition.js';
import { generatedBanner } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import { schemaContext } from './types.js';
import {
  type ModelDefinition,
  type RecursiveAlias,
  ModelDefinitions,
  type ModelResolveEnv,
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
  modelBases,
  modelFieldType,
  modelConversionDescriptor,
  CompositionError,
  componentSite,
  type CompositionSite,
} from './model-resolution.js';
import { openApiValidationSchemaClosure } from './model-manifest.js';
import { analyzeOpenApiModels, reachableSchemaNodes, schemaGraphView } from './model-schema-graph.js';

/**
 * Calls the `@exprtlabs/golem/temporal` codec a `temporal:` serde id names; other ids never reach OpenAPI models.
 * Conversion code holds values as `unknown`; wire validation has already checked them, so the call casts.
 */
const TEMPORAL_SERDE = {
  deserialize: (id: string, value: string) => `deserialize${temporalCodecName(id)}((${value}) as never)`,
  serialize: (id: string, value: string) => `serialize${temporalCodecName(id)}((${value}) as never)`,
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
 * Tags a model declares itself: required properties whose schema is a const or
 * an enum of literals. The shared union conversion infers dispatch from these
 * when a union has no discriminator table.
 */
function modelDiscriminators(definition: ModelDefinition | undefined): ModelDiscriminators | undefined {
  if (!definition) return undefined;
  const tags: Record<string, DiscriminatorValue | readonly DiscriminatorValue[]> = {};
  const literal = (value: unknown): value is DiscriminatorValue =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  for (const [name, schema] of definition.properties) {
    if (!definition.required.has(name) || !isJsonObject(schema)) continue;
    if (literal(schema.const)) tags[name] = schema.const;
    else if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(literal)) {
      tags[name] = schema.enum.length === 1 ? schema.enum[0] : schema.enum;
    }
  }
  return Object.keys(tags).length ? tags : undefined;
}

/** How generated conversion code decodes and constructs a referenced model. */
function modelResolver(reference: string, definitions: ModelDefinitions, env: ModelResolveEnv): FromJsonModelResolver {
  const alias = definitions.aliases.get(reference);
  if (alias) {
    // A use of a recursive alias calls its node. A model-layer value is not a wire value, so init builds only the models.
    return {
      className: alias.name,
      decode: (value) => `${generatedFunctionName(aliasNodeId(alias), 'fromWire')}(${value})`,
      fromInit: aliasInitsModel(alias, definitions, env) ? (value) => `${aliasInitName(alias)}(${value})` : (value) => value,
      ...(aliasConvertsValue(alias, definitions, env) ? {} : { identity: true as const }),
    };
  }
  const discriminators = modelDiscriminators(definitions.get(reference));
  const bases = modelBases(definitions.get(reference));
  return {
    className: `${reference}Model`,
    decode: (value) => `decodeGeneratedModelTrusted(${reference}Model, ${value})`,
    fromInit: (value) => definitions.get(reference)?.isUnion
      ? `initialize${reference}(${value})`
      : `new ${reference}Model(${value} as ${reference}Init)`,
    ...(discriminators ? { discriminators } : {}),
    ...(bases.length ? { bases } : {}),
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

/** A conversion error of the model path carries its code and names the component, or the inline schema, it converts. */
function withConflictCode(owner: string | CompositionSite, emit: () => string): string {
  try {
    return emit();
  } catch (thrown) {
    const coded = codedConflict(thrown);
    if (!(coded instanceof CompositionError)) throw thrown;
    const site = typeof owner === 'string' ? componentSite(owner) : owner;
    const where = site.where('');
    throw new LocatedError(`${where}: ${coded.message}`, site.origins(where), { cause: coded });
  }
}

export function modelFromJSONExpression(
  schema: unknown,
  expression: string,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
): string {
  return withConflictCode(owner, () => emitModelFromJSON(
    modelConversionDescriptor(schema, definitions, env, 'from'),
    expression,
    (reference) => modelResolver(reference, definitions, env),
    TEMPORAL_SERDE,
  ));
}

function modelInitExpression(
  schema: unknown,
  expression: string,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
): string {
  const descriptor = modelConversionDescriptor(schema, definitions, env, 'from');
  return withConflictCode(owner, () => emitModelFromInit(descriptor, expression, reference => modelResolver(reference, definitions, env)));
}

export function modelToJSONExpression(
  schema: unknown,
  expression: string,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  owner: string | CompositionSite,
): string {
  return withConflictCode(owner, () => emitModelToJSON(
    modelConversionDescriptor(schema, definitions, env, 'to'),
    expression,
    (reference) => {
      const alias = definitions.aliases.get(reference);
      if (alias) {
        return {
          className: alias.name,
          encode: value => `${generatedFunctionName(aliasNodeId(alias), 'toWire')}(${value})`,
          ...(aliasConvertsValue(alias, definitions, env) ? {} : { identity: true as const }),
        };
      }
      const bases = modelBases(definitions.get(reference));
      return { className: `${reference}Model`, encode: value => `encodeGeneratedModel(${value})`, ...(bases.length ? { bases } : {}) };
    },
    TEMPORAL_SERDE,
  ));
}

/**
 * `emit(FIELD_CONVERSION_INPUT)` shows the shape of a field conversion. A single call passes its function and the
 * field value to `convertModelField`; any other conversion becomes a module-level function of the field value,
 * so no field allocates a closure.
 */
function rootFieldConversion(
  helpers: string[],
  helperName: (index: number) => string,
  direction: 'deserialize' | 'serialize',
  field: string,
  input: string,
  emit: (value: string) => string,
  inputType: string,
): string {
  const converted = emit(FIELD_CONVERSION_INPUT);
  if (converted === FIELD_CONVERSION_INPUT) return input;
  let convert = singleCallConverter(converted);
  if (!convert) {
    convert = helperName(helpers.length);
    helpers.push(`function ${convert}(${FIELD_CONVERSION_INPUT}: ${inputType}) { return ${converted}; }`);
  }
  return `convertModelField(${JSON.stringify(direction)}, ${JSON.stringify(field)}, ${convert}, ${input})`;
}

function modelFieldDeclaration(
  name: string,
  schema: unknown,
  required: boolean,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
): string {
  const description = isJsonObject(schema) && schema.description
    ? `  /** ${String(schema.description).replace(/\*\//g, '*\\/').replace(/\s+/g, ' ')} */\n`
    : '';
  return `${description}  declare ${propertyName(name)}${required ? '' : '?'}: ${modelFieldType(schema, definitions, env)};`;
}

function modelPropertyAccess(name: string): string {
  return `[${JSON.stringify(name)}]`;
}

/** The local that holds one field's value, read once. */
function modelPresentLocal(index: number): string {
  return `__golemValue${index}`;
}

/**
 * The statement that reads the captured fields of `target` in the JSON view (`presentKeysSource`): one own-key pass, so an
 * inherited value never counts and a getter runs once. Empty when no field is captured. Constructor and decode use it.
 */
function modelPresentRead(indent: string, target: string, captures: readonly (readonly [name: string, type: string])[]): string[] {
  if (captures.length === 0) return [];
  const types = new Map(captures.map(([, type], index) => [modelPresentLocal(index), type]));
  return [`${indent}${presentKeysSource(target, captures.map(([name], index) => [name, modelPresentLocal(index)] as const), local => `${local}: ${types.get(local)} | undefined`)}`];
}

/**
 * The statement that reads the declared fields of `model` for encode: one plain property access each, so a getter or an
 * inherited value supplies a field as it does in stringify, and a getter runs once. Empty when no field is captured.
 */
function modelDeclaredRead(indent: string, model: string, captures: readonly (readonly [name: string, type: string])[]): string[] {
  return captures.map(([name, type], index) => `${indent}const ${modelPresentLocal(index)}: ${type} | undefined = ${model}${modelPropertyAccess(name)};`);
}

function modelPropertyAssignment(target: string, name: string, value: string): string {
  return `${target}${modelPropertyAccess(name)} = ${value};`;
}

/** Whether a model's group module exports its wire stringify: another group writes a recursive model under it in place and meets it again. */
function exportsWireStringify(graph: SchemaGraph, node: SchemaNode, profile: OpenApiGenerationProfile): boolean {
  return profile.validation && node.kind !== 'reference' && !node.sameSchema && node.validationEnabled !== false
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
     * each root and each root's fast check under (`PlanValidators.exports` and `fastExports`). `groupPlans` are the plans the model groups' own schemas come from:
     * a companion imports the validators of its group's plan ids. Called once, and required when the profile validates.
     */
    readonly compileValidators?: (input: { readonly plan: CodecValidationPlan; readonly groupPlans: ReadonlyMap<string, CodecValidationPlan>; readonly locateModel: (name: string) => SchemaPlace }) => Pick<PlanValidators, 'exports' | 'fastExports'>;
  } = {},
): { readonly files: ReadonlyMap<string, string>; readonly entryReexports: string; readonly diagnostics: readonly GolemDiagnostic[] } {
  const { schemaGraph, definitions, ordered, grouping } = analysis;
  const { groups, owner, runtimeEdges } = grouping;
  const digest = sourceDigest(document);
  const stableId = (definition: ModelDefinition) =>
    `openapi:${digest.slice(0, 16)}#/components/schemas/${definition.schemaName}`;
  // A model is named by its identifier form; the document names the component by its own key.
  const schemaNameByModelName = new Map(ordered.flatMap((definition) => {
    const node = analysis.nodesByName.get(definition.name);
    return node ? [[node.name, definition.schemaName] as const] : [];
  }));
  const validationClosure = profile.validation
    ? openApiValidationSchemaClosure(schemaGraph, ordered, stableId)
    : [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
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
  for (const group of groups) {
    const groupDefinitions = definitionsByGroup.get(group.id) ?? [];
    const initializerCalls = groupDefinitions.flatMap((definition) =>
      [...definition.properties.values()].map((schema) => modelInitExpression(schema, 'value', definitions, sharedModelEnv, definition.schemaName)),
    ).join('\n');
    for (const match of initializerCalls.matchAll(/\binitialize([A-Za-z_$][\w$]*)\(/g)) {
      const initializerName = match[1];
      if (!initializerName || group.models.has(initializerName)) continue;
      const initializerGroupId = groupForModel.get(initializerName);
      if (!initializerGroupId || initializerGroupId === group.id) continue;
      const exports = exportedInitializersByGroup.get(initializerGroupId) ?? new Set<string>();
      exports.add(initializerName);
      exportedInitializersByGroup.set(initializerGroupId, exports);
    }
  }
  const aliasByNodeId = new Map([...definitions.aliases.values()].flatMap((alias) => alias.nodeId === undefined ? [] : [[alias.nodeId, alias] as const]));
  const files = new Map<string, string>();
  const diagnostics: GolemDiagnostic[] = [];
  const codecExports = (name: string): string[] => {
    const node = analysis.nodesByName.get(name);
    if (!node) return [];
    const aliases: readonly (readonly [string, string])[] = [
      [`stringify${node.id}`, `stringify${name}`],
      [`parse${node.id}`, `parse${name}`],
      [`fromWireFormat${node.id}`, `fromWireFormat${name}`],
      [`toWireFormat${node.id}`, `toWireFormat${name}`],
      [`validate${node.id}`, `validate${name}`],
      [`assert${node.id}`, `assert${name}`],
      [`encode${name}`, `encode${name}`],
    ];
    return aliases.map(([local, exported]) => local === exported ? local : `${local} as ${exported}`);
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
      ));
    }
  }
  if (profile.validation && !helpers.compileValidators) throw new Error('A validating SDK compiles its model validators with the operation validators; the caller names how.');
  const compiledValidators = profile.validation && helpers.compileValidators
    ? helpers.compileValidators({
      plan: buildCodecValidationPlan(schemaGraph),
      groupPlans,
      locateModel: (name) => componentPlace(helpers.locate, schemaNameByModelName.get(name) ?? name, ''),
    })
    : undefined;
  const validatorExports = compiledValidators?.exports;
  const fastCheckExports = compiledValidators?.fastExports;
  for (const group of groups) {
    const localIds = group.nodes;
    const dependencyIds = dependenciesByGroup.get(group.id) ?? new Set<string>();
    const importsByModule = new Map<string, Set<string>>();
    const addImport = (moduleName: string, name: string): void => {
      const values = importsByModule.get(moduleName) ?? new Set<string>();
      values.add(name);
      importsByModule.set(moduleName, values);
    };
    for (const nodeId of dependencyIds) {
      const node = schemaGraph.nodes.get(nodeId);
      const dependencyGroupId = owner.get(nodeId);
      const dependencyGroup = dependencyGroupId ? groupById.get(dependencyGroupId) : undefined;
      if (!node || !dependencyGroup || dependencyGroupId === group.id) continue;
      const codecModule = `./_${dependencyGroup.id}.js`;
      for (const functionName of ['stringify', 'fromWire', 'toWire'] as const) {
        addImport(codecModule, generatedFunctionName(node.id, functionName));
      }
      if (node.kind === 'object') addImport(codecModule, generatedFunctionName(node.id, 'fill'));
      const alias = aliasByNodeId.get(nodeId);
      if (alias && aliasConvertsValue(alias, definitions, sharedModelEnv)) addImport(codecModule, `type ${aliasModelTypeName(alias)}`);
      if (alias && aliasInitsModel(alias, definitions, sharedModelEnv)) addImport(codecModule, aliasInitName(alias));
      if (exportsWireStringify(schemaGraph, node, profile)) addImport(codecModule, wireStringifyExportName(node.codecId));
      const modelName = analysis.definitionNameByNodeId.get(nodeId);
      if (node.emitClass && modelName !== undefined) {
        const modelModule = `./${modelName}.js`;
        addImport(modelModule, `${modelName}Model`);
        for (const suffix of ['Fields', 'JSON', 'Init'] as const) {
          addImport(modelModule, `type ${modelName}${suffix}`);
        }
      }
    }
    const groupDefinitions = definitionsByGroup.get(group.id) ?? [];
    for (const definition of groupDefinitions) {
      if (!definition.baseName) continue;
      const baseGroupId = groupForModel.get(definition.baseName);
      if (!baseGroupId || baseGroupId === group.id) continue;
      addImport(`./${definition.baseName}.js`, `${definition.baseName}Model`);
      addImport(`./${definition.baseName}.js`, `type ${definition.baseName}Fields`);
      addImport(`./_${baseGroupId}.js`, `encode${definition.baseName}`);
    }
    const initializerCalls = groupDefinitions.flatMap((definition) =>
      [...definition.properties.values()].map((schema) => modelInitExpression(schema, 'value', definitions, sharedModelEnv, definition.schemaName)),
    ).join('\n');
    for (const match of initializerCalls.matchAll(/\binitialize([A-Za-z_$][\w$]*)\(/g)) {
      const initializerName = match[1];
      if (!initializerName || group.models.has(initializerName)) continue;
      const initializerGroup = groupForModel.get(initializerName);
      if (initializerGroup && initializerGroup !== group.id) {
        addImport(`./_${initializerGroup}.js`, `initialize${initializerName}`);
      }
    }
    const moduleImports = [...importsByModule]
      .sort(([left], [right]) => compareText(left, right))
      .map(([moduleName, imports]) => `import { ${[...imports].sort().join(', ')} } from ${JSON.stringify(moduleName)};`);
    const dependencyGroups = new Set([...dependencyIds].flatMap((nodeId) => {
      const dependencyGroupId = owner.get(nodeId);
      return dependencyGroupId && dependencyGroupId !== group.id ? [dependencyGroupId] : [];
    }));
    for (const dependencyGroupId of [...dependencyGroups].sort()) {
      // A dependency may be needed only for schema registration. Importing its
      // group for side effects ensures its codec exists before addNestedCodecSchema
      // resolves the closure; named imports are still pruned to actual calls.
      moduleImports.push(`import ${JSON.stringify(`./_${dependencyGroupId}.js`)};`);
    }
    const groupPlan = groupPlans.get(group.id);
    if (groupPlan && validatorExports) {
      // The model module's import pruning keeps the validators its codecs use.
      const names = Object.keys(groupPlan.schemas).map((id) => {
        const name = validatorExports.get(id);
        if (name === undefined) throw new Error(`The SDK validators module has no validator for the codec ${JSON.stringify(id)} of model group ${group.id}.`);
        const fast = fastCheckExports?.get(id);
        return fast === undefined ? [name] : [name, fast];
      }).flat();
      if (names.length > 0) moduleImports.push(`import { ${[...new Set(names)].sort().join(', ')} } from '../validators.generated.js';`);
    }
    const modelModule = generateModels(document, profile, {
      ...helpers,
      copyAdditionalProperties: groupDefinitions.some((definition) => Boolean(definition.additionalProperties)),
      objectFromJSON: group.models.size > 0,
      analysis,
      onlyNames: group.models,
      graphNodeIds: localIds,
      dependencyNodeIds: dependencyIds,
      moduleFile: group.filename,
      moduleImports,
      ...(validatorExports ? { validatorExports } : {}),
      ...(fastCheckExports ? { fastCheckExports } : {}),
      codecFunctionImport: (nodeId, functionName) => {
        const dependencyGroupId = owner.get(nodeId);
        if (!dependencyGroupId || dependencyGroupId === group.id) return undefined;
        return generatedFunctionName(nodeId, functionName);
      },
      exportedFillFunctionIds: exportedFillFunctionsByGroup.get(group.id),
      exportedInitializerNames: exportedInitializersByGroup.get(group.id),
      ...(groupPlan ? { resolvedSchemas: Object.fromEntries(groupPlan.ownSchemas.map((id) => [id, groupPlan.schemas[id]])) } : {}),
    });
    files.set(group.filename, modelModule);
    for (const name of group.models) {
      const filename = `models/${name}.ts`;
      const runtimeExports = codecExports(name);
      files.set(filename, `${generatedBanner()}\nexport { ${name}Model${runtimeExports.length ? `, ${runtimeExports.join(', ')}` : ''} } from './_${group.id}.js';\nexport type { ${name}Fields, ${name}JSON, ${name}Init } from './_${group.id}.js';\n`);
    }
  }
  const reexports = ordered.map((definition) =>
    `export { ${definition.name}Model, ${codecExports(definition.name).map((name) => name.includes(' as ') ? name.slice(name.indexOf(' as ') + 4) : name).join(', ')} } from './models/${definition.name}.js';\nexport type { ${definition.name}Fields, ${definition.name}JSON, ${definition.name}Init } from './models/${definition.name}.js';`,
  );
  return { files, entryReexports: reexports.join('\n'), diagnostics: uniqueDiagnostics(diagnostics) };
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
): string {
  const descriptor = modelConversionDescriptor(definition.rawSchema, definitions, env, 'from');
  const resolve = (reference: string) => modelResolver(reference, definitions, env);
  try {
    return direction === 'fromJSON'
      ? emitModelFromJSON(descriptor, 'value', resolve, TEMPORAL_SERDE)
      : emitModelFromInit(descriptor, 'value', resolve);
  } catch (thrown) {
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
  options: CodecRuntimeOptions,
  definitions: ModelDefinitions,
): string {
  // Group modules import each other's codec functions, anonymous ones included.
  options = { ...options, exportAnonymousCodecs: true };
  try {
    return emitCodecRuntime(graph, options);
  } catch (thrown) {
    // A conversion conflict that the emitter finds carries the resolver's code.
    const error = codedConflict(thrown);
    const message = error instanceof Error ? error.message : String(error);
    const failing = graph.topo().find((node) => {
      try {
        emitCodecRuntime({ ...schemaGraphView(graph, new Set(graph.nodes.keys())), topo: () => [node] }, options);
        return false;
      } catch {
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

export function generateModels(
  document: unknown,
  profile: OpenApiGenerationProfile,
  helpers: {
    readonly copyAdditionalProperties?: boolean;
    readonly objectFromJSON?: boolean;
    readonly analysis?: OpenApiModelAnalysis;
    readonly onlyNames?: ReadonlySet<string>;
    readonly graphNodeIds?: ReadonlySet<string>;
    readonly dependencyNodeIds?: ReadonlySet<string>;
    readonly moduleFile?: string;
    readonly modelImport?: (name: string) => string | undefined;
    readonly codecFunctionImport?: (nodeId: string, functionName: 'stringify' | 'fill' | 'fromWire' | 'toWire') => string | undefined;
    readonly moduleImports?: readonly string[];
    /** The name the module's generated validators are exported under, by codec id and plane; set when `moduleImports` imports them. */
    readonly validatorExports?: ReadonlyMap<string, string>;
    /** The name of each root's fast check, by the same keys, for the roots that have one. */
    readonly fastCheckExports?: ReadonlyMap<string, string>;
    /** The validation plan's resolved schemas of this module's models by codec id and plane. */
    readonly resolvedSchemas?: Readonly<Record<string, object | boolean>>;
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
  const emitObjectFromJSON = helpers.objectFromJSON !== false;
  const emitCopy = helpers.copyAdditionalProperties === true
    || (helpers.copyAdditionalProperties === undefined
      && ordered.some((definition) => definition.additionalProperties));
  if (emitObjectFromJSON) moduleScope.claim('objectFromJSON', 'internal helper objectFromJSON');
  if (emitCopy) moduleScope.claim('copyAdditionalProperties', 'internal helper copyAdditionalProperties');
  moduleScope.claim('Types', 'import binding Types');
  moduleScope.claim('ModelInit', 'import binding ModelInit');
  const reservedMembers = new Set(RESERVED_MODEL_MEMBERS);
  const sharedModelEnv = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates);
  const usesDate = ordered.some(definition => [...definition.properties.values(), definition.additionalProperties].some(schema => /\bDate\b/.test(modelFieldType(schema, definitions, sharedModelEnv))));
  const initializerCalls = ordered.flatMap(definition => [...definition.properties.values()].map(schema => modelInitExpression(schema, 'value', definitions, sharedModelEnv, definition.schemaName))).join('\n');
  const schemaGraph = analysis.schemaGraph;
  const emittedSchemaGraph = helpers.graphNodeIds
    ? schemaGraphView(schemaGraph, helpers.graphNodeIds, helpers.dependencyNodeIds)
    : schemaGraph;
  const codecIdFor = (name: string): string => {
    const node = analysis.nodesByName.get(name);
    return node?.codecId ?? name;
  };
  const output = [
    generatedBanner(),
    ...(profile.validation && profile.mobx ? ["import { enhanceValidatorWithMobX } from '@exprtlabs/golem/mobx-validation';"] : []),
    `import { registerGeneratedModel, type ModelInit, type GeneratedModelConstructor, type generatedModelWireBrand, type generatedModelFieldsBrand${ordered.some(definition => definition.isUnion) ? ", type generatedModelResultBrand" : ""}${emitCopy ? ", findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor" : ""} } from '@exprtlabs/golem/model';`,
    `import { assertPropertyAcyclic, assertWireAcyclic, beginDecode, convertModelField, convertModelItems, convertModelTupleItems, decodeCheckedInput, decodeDetachedInput, endDecode, decodeGeneratedModelTrusted, defineModelProperty, encodeGeneratedModel${usesDate ? ", deserializeDate, serializeDate" : ""} } from '@exprtlabs/golem/conversion';`,
    "import { assertModelValue, createObjectCodec, isValidModelValue, parseJson, registerIModelClass, requireIModelClass, requireObjectCodec, serdeValidates, stringifyJsonArray, stringifyJsonBoolean, stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString, validationUnavailable, withoutInstanceState, IssueRepresentation, IssueSource, type SerdeOptions as __GolemSerdeOptions, type ValidateOptions as __GolemValidateOptions } from '@exprtlabs/golem/serde';",
    ...(profile.mobx ? [
      "import { asGenObservable } from '@exprtlabs/golem/mobx';",
    ] : []),
    `import type * as Types from '${helpers.moduleFile?.includes('/') ? '../types.js' : './types.js'}';`,
    ...(helpers.moduleImports ?? []),
    '',
    ...(emitObjectFromJSON ? [
      'function objectFromJSON<T extends object>(json: unknown, modelName: string): Partial<T> {',
      '  return requireModelObject(json, modelName) as Partial<T>;',
      '}',
      '',
    ] : []),
    ...(emitCopy ? [
      'function copyAdditionalProperties(target: object, source: object, known: readonly string[], convert?: (value: unknown) => unknown): void {',
      '  for (const [name, value] of Object.entries(source)) {',
      '    if (known.includes(name)) continue;',
      '    Object.defineProperty(target, name, { value: convert ? convert(value) : value, enumerable: true, configurable: true, writable: true });',
      '  }',
      '}',
      '',
    ] : []),
  ];
  const sharedSchemaContext = schemaContext(document, { resources: analysis.resources });

  for (const definition of ordered) {
    const anchors = schemaContext(
      document,
      sharedSchemaContext,
      definition.schemaName,
      definition.rawSchema,
    ).anchors;
    const env = modelEnv(document, undefined, anchors, analysis.resources, analysis.selections, analysis.dates);
    const fieldEnv = withSchemaBase(env, definition.rawSchema);
    const typeName = definition.name;
    const className = `${typeName}Model`;
    const variantUnion = (definition.variants ?? []).map(variant => `${variant}Model`).join(' | ');
    moduleScope.claim(className, `generated model ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    for (const suffix of ['Fields', 'JSON', 'Init']) {
      moduleScope.claim(`${typeName}${suffix}`, `generated ${suffix} type for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    }
    moduleScope.claim(`decode${typeName}`, `internal decoder for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    moduleScope.claim(`encode${typeName}`, `internal encoder for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
    const classScope = new NameScope(`${className} members`);
    const baseClass = definition.baseName ? `${definition.baseName}Model` : null;
    const fields = [...definition.properties.entries()];
    for (const [name] of fields) {
      classScope.rejectReserved(name, `field ${JSON.stringify(name)} on ${className}`, reservedMembers, 'generated model API member');
      classScope.claim(name, `field ${JSON.stringify(name)}`);
    }
    const additionalPropertyType = definition.additionalProperties === true
      ? 'unknown'
      : isJsonObject(definition.additionalProperties)
        ? modelFieldType(definition.additionalProperties, definitions, fieldEnv)
        : null;
    const implementsType = definition.isUnion || (additionalPropertyType && additionalPropertyType !== 'unknown') ? '' : ` implements ${typeName}Fields`;
    const declarations = fields.map(([name, schema]) =>
      modelFieldDeclaration(name, schema, definition.required.has(name), definitions, fieldEnv),
    );
    const assignments = [
      ...modelPresentRead('    ', 'values', fields.map(([name]) => [name, `${typeName}Init[${JSON.stringify(name)}]`] as const)),
      ...fields.map(([name, schema], index) =>
        `    if (${modelPresentLocal(index)} !== undefined) ${modelPropertyAssignment('this', name, `(${modelInitExpression(schema, modelPresentLocal(index), definitions, fieldEnv, definition.schemaName)}) as ${modelFieldType(schema, definitions, fieldEnv)}`)}`),
    ];
    const fieldHelpers: string[] = [];
    const fieldHelperName = (direction: 'encode' | 'decode') => (index: number): string => {
      const helper = `convert${typeName}Field${index}${direction === 'encode' ? 'Encode' : 'Decode'}`;
      moduleScope.claim(helper, `internal field converter for ${JSON.stringify(definition.schemaName)}`, definition.schemaName);
      return helper;
    };
    const jsonProperties = fields.map(([name, schema], index) => {
      const input = modelPresentLocal(index);
      const converted = rootFieldConversion(
        fieldHelpers, fieldHelperName('encode'), 'serialize', name, input,
        (value) => modelToJSONExpression(schema, value, definitions, fieldEnv, definition.schemaName),
        // The guard on the property excludes an undefined value before the conversion runs.
        `Exclude<${className}${modelPropertyAccess(name)}, undefined>`,
      );
      return `  if (${input} !== undefined) ${modelPropertyAssignment('result', name, converted)}`;
    });
    const jsonRead = modelDeclaredRead('  ', 'model', fields.map(([name]) => [name, `${className}${modelPropertyAccess(name)}`] as const));
    const allProperties = modelSchemaProperties(fieldEnv, definition.rawSchema);
    const allFieldNames = [...allProperties.keys()];
    const fieldNames = allFieldNames.map(name => JSON.stringify(name)).join(', ');
    const additionalConverter = (direction: 'from' | 'init' | 'to'): string => {
      if (!isJsonObject(definition.additionalProperties)) return '';
      const emit = direction === 'from' ? modelFromJSONExpression : direction === 'init' ? modelInitExpression : modelToJSONExpression;
      const expression = emit(definition.additionalProperties, 'value', definitions, fieldEnv, definition.schemaName);
      return expression === 'value' ? '' : `, (value) => ${expression}`;
    };
    const decodeCaptures: (readonly [name: string, type: string])[] = [];
    const decodeConversions: string[] = [];
    for (const [name, schema] of allProperties) {
      const expression = modelPresentLocal(decodeCaptures.length);
      const rootConverted = rootFieldConversion(
        fieldHelpers, fieldHelperName('decode'), 'deserialize', name, expression,
        (input) => modelFromJSONExpression(schema, input, definitions, fieldEnv, definition.schemaName),
        'unknown',
      );
      // `result` already contains every own enumerable input property.  Keep
      // the initializer copy as-is for fields with no wire conversion and
      // only replace values that must become model instances or pass through
      // a codec.  The constructor remains the sole model-instance writer.
      if (rootConverted === expression) continue;
      decodeCaptures.push([name, 'unknown']);
      decodeConversions.push(`  if (${expression} !== undefined) ${modelPropertyAssignment('result', name, rootConverted)}`);
    }
    // Read the own copy in `result`, so a getter of the input runs once, in the spread.
    const decodeLines = [...modelPresentRead('  ', 'result', decodeCaptures), ...decodeConversions];
    const additionalFrom = additionalConverter('from');
    const identityDeserialize = decodeLines.length === 0 && additionalFrom === '';
    output.push(
      `export type ${typeName}Fields = ${definition.baseName ? `${definition.baseName}Fields & ` : ''}{`,
      ...fields.map(([name, schema]) => `  ${propertyName(name)}${definition.required.has(name) ? '' : '?'}: ${modelFieldType(schema, definitions, fieldEnv)};`),
      ...(additionalPropertyType ? [`  [key: string]: ${fields.length || definition.baseName ? 'unknown' : additionalPropertyType};`] : []),
      '};',
      `export type ${typeName}JSON = Types.${typeName};`,
      `export type ${typeName}Init = ModelInit<${typeName}Fields>;`,
      '',
      ...fieldHelpers.flatMap(helper => [helper, '']),
      ...(!definition.isUnion ? [
        `function deserialize${typeName}Fields(json: unknown): ${typeName}Init {`,
        `  const value = objectFromJSON<Record<string, unknown>>(json, ${JSON.stringify(className)});`,
        ...(identityDeserialize
          ? [`  return value as ${typeName}Init;`]
          : [
            '  const result: Record<string, unknown> = { ...value };',
            ...decodeLines,
            ...(additionalFrom ? [`  copyAdditionalProperties(result, value, [${fieldNames}]${additionalFrom});`] : []),
            `  return result as ${typeName}Init;`,
          ]),
        '}',
        '',
      ] : definition.isUnion ? [
        ...(initializerCalls.includes(`initialize${typeName}(`) || helpers.exportedInitializerNames?.has(typeName) ? [
          `${helpers.moduleFile ? 'export ' : ''}function initialize${typeName}(json: unknown): ${variantUnion} {`,
          `  const value = objectFromJSON<Record<string, unknown>>(json, ${JSON.stringify(className)});`,
          `  const initialized: unknown = ${unionConversion(definition, 'fromInit', definitions, env)};`,
          `  return initialized as ${variantUnion};`,
          '}',
          '',
        ] : []),
      ] : []),
      `export ${definition.isUnion ? 'abstract ' : ''}class ${className}${baseClass ? ` extends ${baseClass}` : ''}${implementsType} {`,
      ...(additionalPropertyType && additionalPropertyType !== 'unknown'
        ? ['  /** Dynamic map values are preserved during conversion. */']
        : additionalPropertyType ? ['  [key: string]: unknown;'] : []),
      ...declarations,
      `  declare readonly [generatedModelWireBrand]: Types.${typeName};`,
      `  declare readonly [generatedModelFieldsBrand]: ${typeName}Fields;`,
      ...(definition.isUnion ? [`  declare static readonly [generatedModelResultBrand]: ${variantUnion};`] : []),
      `  constructor(values: ${typeName}Init = {}) {`,
      ...(baseClass ? ['    super(values);'] : []),
      ...assignments,
      ...(additionalPropertyType
        ? [`    if (findGeneratedModelDefinition(this) === findGeneratedModelDefinitionForConstructor(${className})) copyAdditionalProperties(this, values, [${fieldNames}]${additionalConverter('init')});`]
        : []),
      ...(profile.mobx && !definition.isUnion ? [
        `    if (new.target === ${className}) asGenObservable(this);`,
      ] : []),
      '  }',
      '',
      '}',
      '',
      ...(definition.isUnion ? [
        `function decode${typeName}(json: unknown): ${variantUnion} {`,
        `  const value = objectFromJSON<Types.${typeName}>(json, ${JSON.stringify(className)});`,
        `  const decoded: unknown = ${unionConversion(definition, 'fromJSON', definitions, env)};`,
        `  return decoded as ${variantUnion};`,
        '}',
      ] : [
        `function decode${typeName}(json: unknown, constructor: GeneratedModelConstructor = ${className}): ${className} {`,
        `  return Reflect.construct(constructor, [deserialize${typeName}Fields(json)]) as ${className};`,
        '}',
      ]),
      '',
      `${helpers.moduleFile ? 'export ' : ''}function encode${typeName}(model: ${className}): Types.${typeName} {`,
      baseClass ? `  const result: Record<string, unknown> = { ...encode${definition.baseName}(model) };` : '  const result: Record<string, unknown> = {};',
      ...jsonRead,
      ...jsonProperties,
      ...(additionalPropertyType
        ? [`  if (findGeneratedModelDefinition(model) === findGeneratedModelDefinitionForConstructor(${className})) copyAdditionalProperties(result, model, [${fieldNames}]${additionalConverter('to')});`]
        : []),
      `  return result as Types.${typeName};`,
      '}',
      '',
      '',
      ...([
        `registerGeneratedModel(${className}, {`,
        `  fields: [${allFieldNames.map((name) => JSON.stringify(name)).join(', ')}] as const,`,
        `  conversion: { decode: decode${typeName}, encode: encode${typeName} },`,
        `  codecId: ${JSON.stringify(codecIdFor(definition.name))},`,
        `  profile: { validation: ${profile.validation} },`,
        ...(profile.validation && profile.mobx ? ['  enhanceValidator: enhanceValidatorWithMobX,'] : []),
        ...(additionalPropertyType ? ['  additionalProperties: true,'] : []),
        '});',
        '',
        `registerIModelClass(${JSON.stringify(codecIdFor(definition.name))}, ${className});`,
        '',
      ]),
    );
  }
  for (const alias of definitions.aliases.values()) {
    if (helpers.graphNodeIds && !(alias.nodeId !== undefined && helpers.graphNodeIds.has(alias.nodeId))) continue;
    if (!aliasConvertsValue(alias, definitions, sharedModelEnv)) continue;
    const aliasType = aliasModelTypeName(alias);
    moduleScope.claim(aliasType, `model type of the recursive component ${JSON.stringify(alias.schemaName)}`, alias.schemaName);
    output.push(`export type ${aliasType} = ${modelFieldType(alias.rawSchema, definitions, componentEnv(sharedModelEnv, alias.schemaName, alias.rawSchema))};`, '');
    if (aliasInitsModel(alias, definitions, sharedModelEnv)) {
      moduleScope.claim(aliasInitName(alias), `initializer of the recursive component ${JSON.stringify(alias.schemaName)}`, alias.schemaName);
      const body = withConflictCode(alias.schemaName, () => emitModelFromInit(aliasDescriptor(alias, definitions, sharedModelEnv), 'value', (reference) => modelResolver(reference, definitions, sharedModelEnv)));
      output.push(`export function ${aliasInitName(alias)}(value: unknown): ${aliasType} {`, `  return (${body}) as ${aliasType};`, '}', '');
    }
  }
  if (helpers.resolvedSchemas) {
    output.push(`const modelSchemas = JSON.parse(${JSON.stringify(JSON.stringify(helpers.resolvedSchemas))}) as Readonly<Record<string, object>>;`, '');
  }
  const aliasesByNodeId = new Map([...definitions.aliases.values()].flatMap((alias) => alias.nodeId === undefined ? [] : [[alias.nodeId, alias] as const]));
  const codecRuntimeOptions: CodecRuntimeOptions = {
    validationEnabled: profile.validation,
    serde: TEMPORAL_SERDE,
    ...(helpers.validatorExports ? {
      validatorName: (id: string) => {
        const name = helpers.validatorExports?.get(id);
        if (name === undefined) throw new Error(`The generated validators module has no validator for ${JSON.stringify(id)}.`);
        return name;
      },
    } : {}),
    ...(helpers.fastCheckExports ? { fastCheckName: (id: string) => helpers.fastCheckExports?.get(id) } : {}),
    ...(helpers.resolvedSchemas ? { resolvedSchemasExpr: 'modelSchemas' } : {}),
    issueSource: 'OpenAPI',
    exportWireStringify: (node) => exportsWireStringify(analysis.schemaGraph, node, profile),
    siblingWireCodecIds: new Set([...(helpers.dependencyNodeIds ?? [])].flatMap((id) => {
      const node = analysis.nodesById.get(id);
      return node && exportsWireStringify(analysis.schemaGraph, node, profile) ? [node.codecId] : [];
    })),
    wireType: (node) => {
      const modelName = analysis.definitionNameByNodeId.get(node.id);
      return modelName !== undefined && definitions.has(modelName) ? `Types.${modelName}` : aliasesByNodeId.get(node.id) === undefined ? undefined : `Types.${aliasesByNodeId.get(node.id)?.name}`;
    },
    fieldsType: (node) => {
      const modelName = analysis.definitionNameByNodeId.get(node.id);
      const alias = aliasesByNodeId.get(node.id);
      return modelName !== undefined && definitions.has(modelName) ? `${modelName}Fields` : alias === undefined ? undefined : aliasUseType(alias, definitions, sharedModelEnv);
    },
    ...(helpers.exportedFillFunctionIds ? { exportedFillFunctionIds: helpers.exportedFillFunctionIds } : {}),
    nestedConstruct: (codecId) => {
      const node = analysis.nodesByCodecId.get(codecId)
        ?? analysis.nodesByName.get(codecId)
        ?? analysis.nodesById.get(codecId);
      const modelName = node ? analysis.definitionNameByNodeId.get(node.id) ?? node.name : codecId;
      return helpers.modelImport?.(modelName) ?? `${modelName}Model`;
    },
    nestedGenerated: (name) => {
      const node = analysis.nodesByName.get(name)
        ?? analysis.nodesById.get(name)
        ?? analysis.nodesByCodecId.get(name);
      const modelName = node ? analysis.definitionNameByNodeId.get(node.id) ?? node.name : name;
      return node?.emitClass ? (helpers.modelImport?.(modelName) ?? `${modelName}Model`) : 'undefined';
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
  output.push(emitSchemaCodecRuntime(emittedSchemaGraph, codecRuntimeOptions, definitions));
  const source = output.join('\n').trim();
  // Only import converter helpers actually used by this model graph. A converter passed to `convertModelField` is referenced, not called.
  const sourceBody = source.replace(/^import \{[^\n]+\} from '@exprtlabs\/golem\/conversion';\n/m, '');
  const conversionImports = [
    'assertAcyclicEncodeInput', 'assertPropertyAcyclic', 'assertWireAcyclic', 'beginDecode', 'beginEncode', 'decodeCheckedInput', 'decodeDetachedInput', 'endDecode', 'endEncode', 'convertModelField', 'convertModelItems', 'convertModelTupleItems', 'decodeGeneratedModelTrusted', 'defineModelProperty', 'encodeGeneratedModel', 'deserializeDate', 'serializeDate', 'unknownDiscriminatorValue', 'withDiscriminatorValue', 'jsonWithDiscriminator', 'requireModelObject',
  ].filter(name => new RegExp(`\\b${name}\\b`).test(sourceBody));
  // `dates: temporal` fields call their codecs from `@exprtlabs/golem/temporal`; import exactly those used.
  const temporalImports = [...new Set(source.match(/\b(?:de)?serializeTemporal[A-Za-z]+(?=\()/g) ?? [])].sort();
  const temporalImport = temporalImports.length ? `import { ${temporalImports.join(', ')} } from '@exprtlabs/golem/temporal';\n` : '';
  const trimmed = source.replace(/^import \{[^\n]+\} from '@exprtlabs\/golem\/conversion';\n/m,
    (conversionImports.length ? `import { ${conversionImports.join(', ')} } from '@exprtlabs/golem/conversion';\n` : '') + temporalImport);
  return pruneGeneratedImports(`${trimmed}\n`);
}
