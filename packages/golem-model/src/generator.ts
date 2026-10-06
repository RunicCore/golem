import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import * as ts from '@exprtlabs/golem/ts';
import type {
  GolemArtifact,
  GolemProfile,
  GolemResult,
  GeneratorSession,
  InputObserver,
} from '@exprtlabs/golem/generator-api';
import { buildCodecValidationPlan, compilePlanValidators, type CodecSchemaClosureEntry } from '@exprtlabs/golem/validation-plan';
import { DEFAULT_MODEL_SUFFIXES, GolemDiagnosticSeverity, resolveProfile, suffixPattern, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { codecKeysPath, defaultModelOutput } from '@exprtlabs/golem/generated-paths';
import { emitCodecDeclarationTable } from '@exprtlabs/golem/schema-graph';
import {
  analyzeSourceGraph,
  createJobAnalysis,
  deduplicateTagSchemas,
  describeJob,
  emitSharedSource,
  emitSource,
  validatorImports,
  codecEntriesForGraph,
  internSourceDefinitions,
  type SourceModelGraph,
} from './emit.js';
import type { SchemaGraph } from '@exprtlabs/golem/schema-graph';
import type { ModelSpecification } from '@exprtlabs/golem/type-analysis';
import { collectSpecifications } from '@exprtlabs/golem/type-analysis';
import { discoverModelManifests } from '@exprtlabs/golem/manifest';
import { loadModelManifests } from '@exprtlabs/golem/type-analysis';
import type { ManifestIndex } from '@exprtlabs/golem/type-analysis';
import {
  assertAbsolute,
  canonicalFilename,
  createOverlayProgram,
  createProgram,
  discoverModelSources,
  formatDiagnostics,
  generatedFilename,
  isModelSource,
  portableRelativeFilename,
  projectWatchInputs,
  retainedProgramSession,
} from '@exprtlabs/golem/type-analysis';

export interface GolemModelProfile extends GolemProfile {}

export interface GolemModelContext {
  /** Absolute project root used for TypeScript configuration and discovery. */
  readonly root: string;
  /** The golem.yaml's directory, whose `.golem/` receives the codec keys. Defaults to `root`. */
  readonly directory?: string;
  /** Optional shared output directory for job-level model metadata. */
  readonly output?: string;
  /** Absolute model source paths. Omit to discover model sources below root/src. */
  readonly sources?: readonly string[];
  /** File-name endings that make a file below root/src a model source; defaults to `.model.ts` and `.models.ts`. */
  readonly suffixes?: readonly string[];
  /** Runtime features selected for generated model companions. */
  readonly profile: GolemModelProfile;
  /** Absolute model-manifest paths to add to marker and source discovery. */
  readonly manifestInputs?: readonly string[];
  /** Observe attempted paths before reads and existence checks. */
  readonly onInput?: InputObserver;
  /** Keeps the TypeScript compiler warm across runs of one CLI pipeline or watch session. */
  readonly session?: GeneratorSession;
}

export interface GolemModelArtifact extends GolemArtifact {}

export interface GolemModelResult extends GolemResult {}

export const apiVersion = 1 as const;

interface NormalizedContext {
  readonly root: string;
  readonly directory: string;
  readonly output: string;
  readonly sources: readonly string[] | undefined;
  readonly suffixes: readonly string[];
  readonly profile: GolemModelProfile;
  readonly manifestInputs: readonly string[];
  readonly onInput?: InputObserver;
  readonly session?: GeneratorSession;
}

function validateContext(context: GolemModelContext): NormalizedContext {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('generate(context) requires a context object.');
  }
  const root = assertAbsolute(context.root, 'context.root');
  context.onInput?.(root);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`context.root must be an existing directory: ${root}`);
  }
  if (!context.profile || typeof context.profile !== 'object' || Array.isArray(context.profile)) {
    throw new TypeError('context.profile is required and must contain mobx and validation booleans.');
  }
  const profile = resolveProfile(context.profile);
  const output = assertAbsolute(
    context.output ?? defaultModelOutput(root),
    'context.output',
  );
  const directory = context.directory === undefined ? root : assertAbsolute(context.directory, 'context.directory');
  const sources = context.sources === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(context.sources)) {
        throw new TypeError('context.sources must be an array of absolute paths.');
      }
      return context.sources.map((filename) => assertAbsolute(filename, 'context.sources entry'));
    })();
  const manifestInputs = context.manifestInputs === undefined
    ? []
    : (() => {
      if (!Array.isArray(context.manifestInputs)) {
        throw new TypeError('context.manifestInputs must be an array of absolute paths.');
      }
      return context.manifestInputs.map((filename) => assertAbsolute(filename, 'context.manifestInputs entry'));
    })();
  return {
    root,
    directory,
    output,
    sources,
    suffixes: context.suffixes ?? DEFAULT_MODEL_SUFFIXES,
    profile,
    manifestInputs,
    onInput: context.onInput,
    session: context.session,
  };
}

const SESSION_OWNER = '@exprtlabs/golem-model';

function emptyResult(
  root: string,
  onInput?: InputObserver,
  session?: GeneratorSession,
): GolemModelResult {
  const info = createProgram([], root, onInput, retainedProgramSession(session, SESSION_OWNER, root));
  using program = info.program;
  const watchInputs = projectWatchInputs(info, program, root, [], discoverModelManifests(root));
  return { artifacts: [], manifestPaths: [], watchInputs };
}

function referencedManifestFiles(
  graphs: readonly { readonly externalIds: readonly string[] }[],
  manifestIndex: ManifestIndex,
): string[] {
  const files = new Set<string>(manifestIndex.localFiles);
  for (const graph of graphs) {
    for (const id of graph.externalIds) {
      const file = manifestIndex.byId.get(id)?.manifestFile;
      if (file) files.add(file);
    }
  }
  return [...files];
}

interface SourceSchemaGraph {
  readonly graph: SourceModelGraph;
  readonly schemaGraph: SchemaGraph;
  readonly siblingWireCodecIds: ReadonlySet<string>;
  /** Siblings declared by sources in the same import cycle as this one. */
  readonly cyclicSiblings: ReadonlySet<string>;
}

/** Strongly connected groups of sources, each after the groups it references. */
function sourceComponents(graphs: readonly SourceModelGraph[]): SourceModelGraph[][] {
  const bySource = new Map(graphs.map((graph) => [canonicalSourceKey(graph.source), graph] as const));
  const edges = new Map(graphs.map((graph) => [graph, [...new Set(graph.siblings
    .map((sibling) => bySource.get(canonicalSourceKey(sibling.sourceFile.fileName)))
    .filter((owner): owner is SourceModelGraph => owner !== undefined))]] as const));
  const index = new Map<SourceModelGraph, number>();
  const low = new Map<SourceModelGraph, number>();
  const stack: SourceModelGraph[] = [];
  const onStack = new Set<SourceModelGraph>();
  const components: SourceModelGraph[][] = [];
  // Tarjan's algorithm emits a component after every component it reaches.
  const connect = (graph: SourceModelGraph): void => {
    index.set(graph, index.size);
    low.set(graph, index.get(graph) ?? 0);
    stack.push(graph);
    onStack.add(graph);
    for (const next of edges.get(graph) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(graph, Math.min(low.get(graph) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) low.set(graph, Math.min(low.get(graph) ?? 0, index.get(next) ?? 0));
    }
    if (low.get(graph) !== index.get(graph)) return;
    const component: SourceModelGraph[] = [];
    for (;;) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === graph) break;
    }
    components.push(component);
  };
  for (const graph of graphs) if (!index.has(graph)) connect(graph);
  return components;
}

function canonicalSourceKey(filename: string): string {
  return canonicalFilename(filename);
}

/**
 * Intern each companion's schema graph. Codec ids are fixed per group of
 * sources that reference each other, so a model has one id in its own
 * companion and in every companion that references it.
 */
function internJobSchemaGraphs(
  graphs: readonly SourceModelGraph[],
  validation: boolean,
  closure: readonly CodecSchemaClosureEntry[] = [],
): SourceSchemaGraph[] {
  const codecIds = new Map<ModelSpecification, string>();
  const wireSchemas = new Set<string>();
  // Models emitted elsewhere (SDK manifests, earlier companions) that publish residual schemas.
  const residualIds = { modelOnly: new Set<string>(), wireOnly: new Set<string>() };
  for (const entry of closure) {
    const names = [entry.codecId, ...(entry.aliases ?? [])];
    if (entry.modelOnlySchema !== undefined) names.forEach((name) => residualIds.modelOnly.add(name));
    if (entry.wireOnlySchema !== undefined) names.forEach((name) => residualIds.wireOnly.add(name));
  }
  const byGraph = new Map<SourceModelGraph, SourceSchemaGraph>();
  const idsFor = (graph: SourceModelGraph, own: ReadonlyMap<string, string>): Map<string, string> => new Map([
    ...own,
    ...graph.siblings.flatMap((sibling) => {
      const id = codecIds.get(sibling);
      return id === undefined ? [] : [[sibling.name, id] as const];
    }),
  ]);
  const record = (graph: SourceModelGraph, schemaGraph: SchemaGraph): void => {
    for (const specification of graph.emitted) {
      if (graph.siblings.includes(specification)) continue;
      const descriptor = graph.definitions[specification.name];
      const node = descriptor ? schemaGraph.nodeFor(descriptor, specification.name) : undefined;
      if (!node) continue;
      codecIds.set(specification, node.codecId);
      if (!node.sameSchema) wireSchemas.add(node.codecId);
      for (const name of [node.codecId, specification.name]) {
        if (node.modelOnlyJsonSchema !== undefined) residualIds.modelOnly.add(name);
        if (node.wireOnlyJsonSchema !== undefined) residualIds.wireOnly.add(name);
      }
    }
  };
  for (const component of sourceComponents(graphs)) {
    const members = new Set(component);
    if (component.length === 1) {
      const [graph] = component;
      const schemaGraph = internSourceDefinitions(graph.definitions, graph.emitted, validation, {
        codecIds: idsFor(graph, new Map()),
        siblings: graph.siblings,
        externalResidualIds: residualIds,
      });
      record(graph, schemaGraph);
      byGraph.set(graph, { graph, schemaGraph, siblingWireCodecIds: wireSchemas, cyclicSiblings: new Set() });
      continue;
    }
    // Sources that reference each other share one id assignment for their models.
    const definitions: Record<string, (typeof graphs)[number]['definitions'][string]> = {};
    const emitted: ModelSpecification[] = [];
    const outside: ModelSpecification[] = [];
    for (const graph of component) {
      for (const specification of graph.emitted) {
        const owner = graph.siblings.includes(specification)
          ? component.find((member) => member.emitted.includes(specification) && !member.siblings.includes(specification))
          : graph;
        if (owner && members.has(owner) && owner !== graph) continue;
        if (emitted.some((item) => item.name === specification.name)) {
          if (emitted.includes(specification)) continue;
          throw new Error(`Generated model symbol collision for "${specification.name}" in ${graph.source}.`);
        }
        emitted.push(specification);
        if (!owner) outside.push(specification);
        definitions[specification.name] = graph.definitions[specification.name];
      }
      for (const [name, descriptor] of Object.entries(graph.definitions)) definitions[name] ??= descriptor;
    }
    const shared = internSourceDefinitions(definitions, emitted, validation, {
      codecIds: new Map(outside.flatMap((sibling) => {
        const id = codecIds.get(sibling);
        return id === undefined ? [] : [[sibling.name, id] as const];
      })),
      siblings: outside,
      externalResidualIds: residualIds,
    });
    for (const graph of component) record(graph, shared);
    for (const graph of component) {
      const own = new Map(graph.emitted
        .filter((specification) => !graph.siblings.includes(specification))
        .flatMap((specification) => {
          const id = codecIds.get(specification);
          return id === undefined ? [] : [[specification.name, id] as const];
        }));
      const schemaGraph = internSourceDefinitions(graph.definitions, graph.emitted, validation, {
        codecIds: idsFor(graph, own),
        siblings: graph.siblings,
        externalResidualIds: residualIds,
      });
      const cyclicSiblings = new Set(graph.siblings
        .filter((sibling) => component.some((member) => member !== graph
          && member.emitted.includes(sibling) && !member.siblings.includes(sibling)))
        .map((sibling) => sibling.name));
      byGraph.set(graph, { graph, schemaGraph, siblingWireCodecIds: wireSchemas, cyclicSiblings });
    }
  }
  return graphs.flatMap((graph) => {
    const entry = byGraph.get(graph);
    return entry ? [entry] : [];
  });
}

/** The diagnostics about the model `sources`, the files named in `outputs`, or the program as a whole. */
function ownDiagnostics(diagnostics: readonly ts.Diagnostic[], outputs: readonly string[], sources: readonly string[]): readonly ts.Diagnostic[] {
  const own = new Set([...sources, ...outputs].map(canonicalFilename));
  return diagnostics.filter((diagnostic) => diagnostic.fileName === undefined || own.has(canonicalFilename(diagnostic.fileName)));
}

/** A companion of a model-suffixed source that no longer exists; any other `*.generated.ts` is not golem's. */
function isOrphanCompanion(companion: string, suffixes: readonly string[]): boolean {
  const source = companion.replace(/\.generated(\.[cm]?ts)$/, '$1');
  return source !== companion && suffixPattern(suffixes).test(basename(source)) && !existsSync(source);
}

/** Names a field type's own schema, which is compiled apart from the model that holds the field. */
const FIELD_TYPE_PLACE = 'a model field type';

/**
 * A field type's schema repeats a warning that the model holding the field already reports, so only the model's warning stays.
 * A warning only the field type carries (its model does not validate) and every error stay.
 */
function withoutRepeatedFieldTypeWarnings(diagnostics: readonly GolemDiagnostic[]): readonly GolemDiagnostic[] {
  const detail = (diagnostic: GolemDiagnostic): string => `${diagnostic.code}\0${diagnostic.message.slice(diagnostic.message.indexOf(': ') + 2)}`;
  const isFieldType = (diagnostic: GolemDiagnostic): boolean => diagnostic.message.startsWith(`${FIELD_TYPE_PLACE}: `);
  const reportedByModels = new Set(diagnostics.filter(diagnostic => !isFieldType(diagnostic)).map(detail));
  return diagnostics.filter(diagnostic => !(
    isFieldType(diagnostic) && diagnostic.severity === GolemDiagnosticSeverity.Warning && reportedByModels.has(detail(diagnostic))
  ));
}

export function generate(context: GolemModelContext): GolemModelResult {
  const normalized = validateContext(context);
  const sources = normalized.sources === undefined
    ? discoverModelSources(normalized.root, normalized.onInput, normalized.suffixes)
    : [...normalized.sources].sort();
  if (sources.length === 0) {
    if (normalized.sources !== undefined) {
      throw new Error(
        `No model sources found under ${join(normalized.root, 'src')}. `
        + `Add a file ending in ${normalized.suffixes.join(' or ')}, or provide context.sources.`,
      );
    }
    return emptyResult(
      normalized.root,
      normalized.onInput,
      normalized.session,
    );
  }
  for (const source of sources) {
    normalized.onInput?.(source);
    if (!isModelSource(source)) {
      throw new Error(`Model source must be a .ts, .mts or .cts file that golem did not generate: ${source}`);
    }
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`Model source does not exist: ${source}`);
    }
  }

  // Phase one intentionally tolerates diagnostics from stale companions.  It
  // only supplies a checker for model-specification discovery.  The generated
  // companions are then overlaid in phase two, whose unsuppressed diagnostics
  // are the write gate and preserve genuine handwritten-source failures.
  const programInfo = createProgram(
    sources,
    normalized.root,
    normalized.onInput,
    retainedProgramSession(normalized.session, SESSION_OWNER, normalized.root),
  );
  using program = programInfo.program;
  const manifestIndex = loadModelManifests(
    normalized.root,
    program,
    programInfo.options,
    normalized.manifestInputs,
    normalized.profile,
    normalized.onInput,
  );
  const { checker, specifications } = collectSpecifications(program, sources);
  if (specifications.length === 0) {
    const diagnostics = ownDiagnostics(ts.getPreEmitDiagnostics(programInfo.program), sources.map(generatedFilename), sources);
    if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics, normalized.root));
    throw new Error('No exported IModel<...> type aliases were found.');
  }

  // Analyze the complete job before emitting companions. Each model is
  // described once; a companion emits code only for its own models and
  // references IModel models of other sources by codec id.
  const job = createJobAnalysis(
    checker,
    specifications,
    manifestIndex,
    normalized.profile,
    sources,
    normalized.root,
    programInfo.options,
  );
  describeJob(job, specifications);
  const graphs = sources
    .map((source) => analyzeSourceGraph(
      source,
      generatedFilename(source),
      checker,
      specifications,
      manifestIndex,
      normalized.profile,
      normalized.root,
      programInfo.options,
      job,
    ))
    .filter((graph): graph is NonNullable<typeof graph> => graph !== undefined);
  const sharedOutput = join(normalized.output, 'models.generated.ts');
  const graphSchemaPairs = internJobSchemaGraphs(graphs, normalized.profile.validation, manifestIndex.validationSchemaClosure);
  const schemaGraphs = graphSchemaPairs.map(({ schemaGraph }) => schemaGraph);
  // A model can ask for validation when the profile does not.
  const anyValidation = normalized.profile.validation
    || schemaGraphs.some((graph) => [...graph.nodes.values()].some((node) => node.kind !== 'reference' && node.validationEnabled === true));
  const needsShared = anyValidation
    || graphs.some((graph) => graph.registry.serde.size > 0);
  const sharedBase = needsShared ? {
    modulePath: sharedOutput,
    keyFor: (source: string, modelName: string): string => `${portableRelativeFilename(source, normalized.root)}\0${modelName}`,
  } : undefined;
  const schemaEntries = deduplicateTagSchemas(
    graphs.flatMap((graph) => graph.schemas)
      .sort((left, right) => left.key.localeCompare(right.key)
        || JSON.stringify(left.schema).localeCompare(JSON.stringify(right.schema))),
  );
  const validationPlan = anyValidation
    ? buildCodecValidationPlan(
      schemaGraphs,
      manifestIndex.validationSchemaClosure,
      Object.fromEntries(schemaEntries.map((compilation) => [compilation.id, compilation.schema])),
      normalized.profile.validation,
    )
    : undefined;
  const validatorsOutput = join(normalized.output, 'models.validators.generated.ts');
  const validators = validationPlan && validationPlan.references.length > 0
    ? compilePlanValidators(validationPlan, {
      owner: '@exprtlabs/golem-model',
      unknownFormats: normalized.profile.unknownFormats ?? 'warn',
      validations: validatorImports(graphs, normalized.profile, validatorsOutput),
      documentName: 'the model schemas',
      locate: (resource) => resource.startsWith('golem:model-tag:') ? { where: FIELD_TYPE_PLACE } : undefined,
    })
    : undefined;
  const validatorDiagnostics = withoutRepeatedFieldTypeWarnings(validators?.diagnostics ?? []);
  if (validatorDiagnostics.some((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error)) {
    // Nothing is written: the companions import the validators this job could not compile.
    return {
      artifacts: [],
      manifestPaths: [],
      watchInputs: projectWatchInputs(programInfo, programInfo.program, normalized.root, sources, referencedManifestFiles(graphs, manifestIndex)),
      diagnostics: validatorDiagnostics,
    };
  }
  const planSchemas = validationPlan && validators
    ? Object.fromEntries(validationPlan.ownSchemas.map((id) => [id, validationPlan.schemas[id]]))
    : undefined;
  const shared = sharedBase && validators
    ? { ...sharedBase, validators: { module: validatorsOutput, exports: validators.exports }, schemasName: 'modelSchemas' }
    : sharedBase;
  const artifacts: GolemModelArtifact[] = [];
  const sharedContent = needsShared
    ? emitSharedSource({
      output: sharedOutput,
      profile: normalized.profile,
      graphs,
      ...(planSchemas ? { schemas: planSchemas } : {}),
    })
    : undefined;
  if (sharedContent !== undefined) artifacts.push({ path: sharedOutput, content: sharedContent });
  if (validators) {
    artifacts.push({ path: validatorsOutput, content: validators.source });
  }
  // Codecs some companion writes through their owner's wire stringify.
  const referencedWireCodecIds = new Set(graphSchemaPairs.flatMap(({ schemaGraph, siblingWireCodecIds }) =>
    [...schemaGraph.nodes.values()]
      .filter((node) => node.siblingCodec && siblingWireCodecIds.has(node.codecId))
      .map((node) => node.codecId)));
  // Object-only models some companion converts through their owner's helpers.
  const referencedObjectCodecIds = new Set(graphSchemaPairs.flatMap(({ graph, schemaGraph }) =>
    graph.siblings.filter((sibling) => !sibling.emitClass).flatMap((sibling) =>
      [...schemaGraph.nodes.values()].filter((node) => node.siblingCodec && node.name === sibling.name).map((node) => node.codecId))));
  for (const { graph, schemaGraph, siblingWireCodecIds, cyclicSiblings } of graphSchemaPairs) {
    const { source, output } = graph;
    const content = emitSource(
      source,
      output,
      checker,
      specifications,
      manifestIndex,
      normalized.profile,
      shared,
      normalized.root,
      graph,
      schemaGraph,
      { siblingWireCodecIds, cyclicSiblings, referencedWireCodecIds, referencedObjectCodecIds },
    );
    if (content !== undefined) artifacts.push({ path: output, content });
  }
  // The keys name each source by its path from the tsconfig's directory, which is the root a rewrite resolves files from.
  const tsconfigDirectory = programInfo.configPath === undefined ? normalized.root : dirname(programInfo.configPath);
  const codecEntries = graphSchemaPairs.flatMap(({ graph, schemaGraph }) => codecEntriesForGraph(graph, schemaGraph, checker, specifications))
    .map((entry) => ({ ...entry, source: portableRelativeFilename(resolve(normalized.root, entry.source), tsconfigDirectory) }));
  if (codecEntries.length > 0) {
    artifacts.push({
      path: codecKeysPath(normalized.directory),
      content: emitCodecDeclarationTable(codecEntries),
    });
  }

  const ownedCompanions = new Set(sources.map((source) => canonicalFilename(generatedFilename(source))));
  const outputPrefix = `${canonicalFilename(normalized.output)}${sep}`;
  // A companion is this job's to write or remove when its source is one of the job's, it lies in the job's output
  // directory, or its model source no longer exists. Another job's companion is real input to this program.
  const ownsCompanion = (companion: string): boolean => ownedCompanions.has(companion)
    || companion.startsWith(outputPrefix)
    || isOrphanCompanion(companion, normalized.suffixes);
  using prospective = createOverlayProgram(
    programInfo,
    sources,
    artifacts,
    normalized.onInput,
    ownsCompanion,
  );
  // The write gate: an error in a model source or in what this job writes. Any other handwritten file is the compiler's to report.
  const diagnostics = ownDiagnostics(ts.getPreEmitDiagnostics(prospective), artifacts.map((artifact) => artifact.path).concat(sources.map(generatedFilename)), sources);
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics, normalized.root, artifacts));

  return {
    artifacts,
    // Model generation consumes SDK manifests; it does not own or emit them.
    manifestPaths: [],
    watchInputs: projectWatchInputs(
      programInfo,
      prospective,
      normalized.root,
      sources,
      referencedManifestFiles(graphs, manifestIndex),
    ),
    ...(validatorDiagnostics.length > 0 ? { diagnostics: validatorDiagnostics } : {}),
  };
}

export {
  discoverModelSources,
  generatedFilename,
  isModelSource,
};

export { discoverModelManifests } from '@exprtlabs/golem/manifest';
