import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from '@exprtlabs/golem/internal/ts';
import {
  assertAbsolute,
  assertGeneratorRoot,
  assertNoSyntaxErrors,
  canonicalFilename,
  createContractAnalysis,
  createModelStubProgram,
  createProgram,
  discoverModelSources,
  isUnderOutputs,
  loadModelManifests,
  modelBoundary,
  projectFilenames,
  retainedProgramSession,
  projectWatchInputs,
  type ContractAnalysis,
  type ModelBoundary,
  type ProgramInfo,
} from '@exprtlabs/golem/internal/type-analysis';
import { schemaForDescriptor } from '@exprtlabs/golem/internal/schema';
import type {
  GolemArtifact,
  GolemDiagnostic,
  GolemResult,
  ControllerContext,
  InputObserver,
  ResolvedGolemProfile,
} from '@exprtlabs/golem/generator-api';
import { resolveProfile } from '@exprtlabs/golem/generator-api';
import { displayPath } from '@exprtlabs/golem/internal/generator-support';
import {
  GolemDiagnosticSeverity,
  diagnostic,
  TsToOpenApiDiagnosticCode,
  TsToOpenApiError,
  type TsToOpenApiDiagnostic,
} from './diagnostics.js';
import { buildDocument, serializeForOutput } from './document.js';
import { DEFAULT_CONTROLLER_SUFFIXES } from './plan.js';
import { validateRouteEvaluationOptions } from './evaluation/dependencies.js';
import { apiSchemaName } from './nest/metadata.js';
import { analyzeControllers, discoverControllerSources } from './nest/routes.js';
import type { DtoSchema } from './nest/json-schema-merge.js';
import { applySwaggerPropertyMetadata } from './nest/swagger-overlay.js';
import type { TypeReference } from './nest/types.js';
import type { SchemaResolutionContext } from './operations.js';

export const apiVersion = 1 as const;

export type TsToOpenApiContext = ControllerContext;

export interface TsToOpenApiResult extends GolemResult {
  readonly apiVersion: 1;
}

function validateContext(context: TsToOpenApiContext): {
  readonly root: string;
  readonly output: string;
  readonly sources?: readonly string[];
  readonly suffixes: readonly string[];
  readonly tsconfig?: string;
  readonly openapiVersion: '3.2.0' | '3.1.2';
  readonly maxResultBytes: number;
  readonly profile: ResolvedGolemProfile;
  readonly exact?: boolean;
  readonly boundary?: ModelBoundary;
  readonly laterOutputs: readonly string[];
  readonly onInput?: InputObserver;
} {
  const root = assertGeneratorRoot(context);
  const output = assertAbsolute(context.output, 'context.output');
  if (!/\.(?:json|ya?ml)$/i.test(output)) {
    throw new TypeError('context.output must be a JSON or YAML file.');
  }
  if (existsSync(output) && !statSync(output).isFile()) {
    throw new TypeError('context.output must be a file.');
  }
  const openapiVersion = context.openapiVersion ?? '3.2.0';
  if (openapiVersion !== '3.2.0' && openapiVersion !== '3.1.2') {
    throw new TypeError('context.openapiVersion must be 3.2.0 or 3.1.2.');
  }
  const profile = resolveProfile(context.profile);
  const { maxResultBytes } = validateRouteEvaluationOptions(context);
  const sources = context.sources === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(context.sources) || context.sources.length === 0) {
        throw new TypeError('context.sources must be a non-empty array of absolute paths.');
      }
      const resolved = context.sources.map((source) => assertAbsolute(source, 'context.sources entry'));
      if (new Set(resolved).size !== resolved.length) throw new TypeError('context.sources must not contain duplicates.');
      return [...resolved].sort();
    })();
  const models = context.models;
  const boundary = models && modelBoundary(
    assertAbsolute(models.root, 'context.models.root'),
    models.suffixes,
    { directory: assertAbsolute(models.directory, 'context.models.directory'), output: assertAbsolute(models.output, 'context.models.output') },
  );
  const laterOutputs = (context.programView?.laterOutputs ?? []).map((later) => assertAbsolute(later, 'context.programView.laterOutputs entry'));
  return { root, output, ...(sources ? { sources } : {}), suffixes: context.suffixes ?? DEFAULT_CONTROLLER_SUFFIXES, ...(context.tsconfig === undefined ? {} : { tsconfig: assertAbsolute(context.tsconfig, 'context.tsconfig') }), openapiVersion, maxResultBytes, profile, exact: context.exact, ...(boundary ? { boundary } : {}), laterOutputs, onInput: context.onInput };
}

function asGolemDiagnostic(value: TsToOpenApiDiagnostic): GolemDiagnostic {
  return {
    code: value.code,
    severity: value.severity === GolemDiagnosticSeverity.Error ? GolemDiagnosticSeverity.Error : GolemDiagnosticSeverity.Warning,
    message: value.message,
    ...(value.file === undefined ? {} : { file: value.file }),
    ...(value.line === undefined ? {} : { line: value.line }),
    ...(value.column === undefined ? {} : { column: value.column }),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function componentReferenceName(value: string): string | undefined {
  const prefix = '#/components/schemas/';
  if (!value.startsWith(prefix)) return undefined;
  // The component is the first pointer token; later tokens (`/properties/name`) point inside it.
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf('/');
  return (slash < 0 ? rest : rest.slice(0, slash)).replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Maps whose keys are names the document author picks, so a key such as `example` or `$ref` there is a name, not a keyword. */
const NAME_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions', 'encoding',
  'schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'callbacks', 'pathItems', 'links', 'securitySchemes', 'webhooks', 'mediaTypes',
]);
/** Keywords whose value is data, not a schema: a `$ref` key inside it is not a reference. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['example', 'examples', 'default', 'const', 'enum']);

/** Calls `onReference` with each `$ref` value and each `discriminator.mapping` target under `root`. */
function visitReferences(root: unknown, onReference: (reference: string) => void): void {
  const seen = new Set<object>();
  const visit = (value: unknown, key?: string): void => {
    if (key === '$ref' && typeof value === 'string') {
      onReference(value);
      return;
    }
    if (key !== undefined && DATA_KEYWORDS.has(key)) return;
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const mapping = key === 'discriminator' ? objectRecord((value as Record<string, unknown>).mapping) : undefined;
    for (const target of Object.values(mapping ?? {})) if (typeof target === 'string') onReference(target);
    const namesOnly = key !== undefined && NAME_MAP_KEYWORDS.has(key);
    for (const [childKey, item] of Object.entries(value)) {
      if (mapping !== undefined && childKey === 'mapping') continue;
      visit(item, namesOnly ? undefined : childKey);
    }
  };
  visit(root);
}

function assertResolvedLocalReferences(
  document: Readonly<Record<string, unknown>>,
): void {
  const components = objectRecord(document.components);
  const schemas = objectRecord(components?.schemas) ?? {};
  visitReferences(document, reference => {
    const name = componentReferenceName(reference);
    if (name && schemas[name] === undefined) {
      throw new TsToOpenApiError({
        severity: GolemDiagnosticSeverity.Error,
        code: TsToOpenApiDiagnosticCode.UnresolvedSchemaReference,
        message: `OpenAPI metadata references missing local schema component ${reference}.`,
      });
    }
  });
}

function collectComponentReferences(value: unknown, names: Set<string>): void {
  visitReferences(value, reference => {
    const name = componentReferenceName(reference);
    if (name) names.add(name);
  });
}

type NormalizedContext = ReturnType<typeof validateContext>;
type Descriptor = Parameters<typeof schemaForDescriptor>[0];

/**
 * The `components.schemas` of one run: the classes and enums that Swagger metadata names as components, the schemas built from
 * them, and the diagnostics the schema walk reports. Resolving one component can register another, so the pieces share this state.
 */
class ComponentSchemas {
  private readonly diagnostics: TsToOpenApiDiagnostic[] = [];
  private readonly diagnosticKeys = new Set<string>();
  /** Classes named by `getSchemaPath()`/`refs()` in Swagger metadata; each becomes a component schema. */
  private readonly classes = new Map<string, TypeReference>();
  /** Enums named by `@ApiProperty({ enum, enumName })`; each becomes one component schema. */
  private readonly enums = new Map<string, Record<string, unknown>>();
  private readonly resolved = new Map<string, DtoSchema>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly contractAnalysis: ContractAnalysis,
    private readonly openapiVersion: NormalizedContext['openapiVersion'],
  ) {}

  get reported(): readonly TsToOpenApiDiagnostic[] {
    return this.diagnostics;
  }

  report = (entry: TsToOpenApiDiagnostic): void => {
    const key = `${entry.code}:${entry.file ?? ''}:${entry.line ?? ''}:${entry.column ?? ''}:${entry.message}`;
    if (this.diagnosticKeys.has(key)) return;
    this.diagnosticKeys.add(key);
    this.diagnostics.push(entry);
  };

  private schemaOf(descriptor: Descriptor, sourceNode?: ts.Node): DtoSchema {
    return schemaForDescriptor(descriptor, {
      definitions: this.contractAnalysis.definitions,
      representation: 'wire' as const,
      portable: true,
      referencePrefix: '#/components/schemas/',
      discriminatorMapping: true,
      // OpenAPI 3.1 has no `defaultMapping`; a union with a declared default stays anyOf there.
      discriminatorDefaultMapping: this.openapiVersion === '3.2.0',
      onNonportable: (message: string): void => this.report(diagnostic(
        sourceNode?.getSourceFile(),
        sourceNode,
        TsToOpenApiDiagnosticCode.NonportableSchema,
        message,
        GolemDiagnosticSeverity.Warning,
      )),
    });
  }

  /** The descriptor of a type a controller names. */
  private describe(type: ts.Type, sourceNode: ts.Node, typeNode?: ts.TypeNode): ReturnType<ContractAnalysis['describe']> {
    // The shared analyzer intentionally treats arrays as part of a model
    // conversion walk. A controller return such as `Payment[]` can point at
    // an authored model subclass whose generated companion is also present;
    // describing the item first keeps that named identity intact and avoids
    // re-entering the subclass's runtime fields as an anonymous object.
    if (this.checker.isArrayType(type)) {
      const itemType = this.checker.getTypeArguments(type as ts.TypeReference)[0] ?? this.checker.getAnyType();
      // `readonly T[]` and `(T[])` write the same array as `T[]`; its item node keeps the model's name.
      let written = typeNode;
      while (written && (ts.isParenthesizedTypeNode(written) || (ts.isTypeOperatorNode(written) && written.operator === ts.SyntaxKind.ReadonlyKeyword))) written = written.type;
      const itemNode = written && ts.isArrayTypeNode(written) ? written.elementType
        : written && ts.isTypeReferenceNode(written) ? written.typeArguments?.[0]
          : undefined;
      return { kind: 'array', item: this.describe(itemType, sourceNode, itemNode) };
    }
    return this.contractAnalysis.describe(type, sourceNode, typeNode);
  }

  registerSchemaComponent = (name: string, reference: TypeReference): void => {
    const existing = this.classes.get(name);
    if (existing === undefined) {
      this.classes.set(name, reference);
      return;
    }
    if (existing.type === reference.type) return;
    throw new TsToOpenApiError(diagnostic(
      reference.sourceFile,
      reference.sourceNode,
      TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
      `getSchemaPath() names two different classes called ${name}; Nest would emit one components.schemas.${name} entry for both.`,
    ));
  };

  registerEnumComponent = (name: string, schema: Record<string, unknown>, node: ts.Node): void => {
    const existing = this.enums.get(name);
    const clash = existing !== undefined
      ? JSON.stringify(existing) !== JSON.stringify(schema)
      : this.classes.has(name) || this.contractAnalysis.definitions[name] !== undefined;
    if (clash) {
      throw new TsToOpenApiError(diagnostic(
        node.getSourceFile(),
        node,
        TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
        `enumName ${name} names components.schemas.${name}, which already describes a different schema.`,
      ));
    }
    this.enums.set(name, schema);
  };

  private classSchema(name: string): DtoSchema | undefined {
    const enumSchema = this.enums.get(name);
    if (enumSchema !== undefined) return enumSchema;
    const cached = this.resolved.get(name);
    if (cached !== undefined) return cached;
    const reference = this.classes.get(name);
    if (!reference || this.resolving.has(name)) return undefined;
    this.resolving.add(name);
    try {
      const schema = this.canonicalSchema({ reference, location: `components.schemas.${name}` });
      this.resolved.set(name, schema);
      return schema;
    } finally {
      this.resolving.delete(name);
    }
  }

  resolveReference = (reference: string): DtoSchema | undefined => {
    const name = componentReferenceName(reference);
    if (name === undefined) return undefined;
    const descriptor = this.contractAnalysis.definitions[name];
    return descriptor === undefined ? this.classSchema(name) : this.schemaOf(descriptor);
  };

  canonicalSchema = (schemaContext: Pick<SchemaResolutionContext, 'reference' | 'location'>): DtoSchema => {
    const { reference } = schemaContext;
    let descriptor = this.describe(reference.type, reference.sourceNode ?? reference.declaration ?? reference.sourceFile, reference.node);
    // OpenAPI 3.2 querystring carries the complete object contract in the
    // parameter content. Inline a named root so object-level constraints such
    // such as dependentRequired remain visible to the query serializer;
    // nested named models still use stable component refs.
    if (schemaContext.location === 'querystring' && descriptor.kind === 'reference') {
      descriptor = this.contractAnalysis.definitions[descriptor.name] ?? descriptor;
    }
    const schema = this.schemaOf(descriptor, reference.sourceNode);
    return applySwaggerPropertyMetadata(
      this.checker,
      reference.type,
      schema,
      reference.sourceNode ?? reference.declaration ?? reference.sourceFile,
      {
        authoritative: reference.modelContractName !== undefined,
        resolveReference: this.resolveReference,
        isAuthoritativeType: (type, node) => this.contractAnalysis.isModel(type, node ?? reference.sourceNode ?? reference.sourceFile),
        location: schemaContext.location,
        onWarning: this.report,
        registerSchemaComponent: this.registerSchemaComponent,
        registerEnumComponent: this.registerEnumComponent,
      },
    );
  };

  /** A class named by getSchemaPath() may reuse an existing component only when it is that component's contract. */
  private assertComponentIdentity(name: string, reference: TypeReference): void {
    if (this.contractAnalysis.modelName(reference.type, reference.sourceNode ?? reference.sourceFile) === name) return;
    throw new TsToOpenApiError(diagnostic(
      reference.sourceFile,
      reference.sourceNode,
      TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
      `getSchemaPath() names components.schemas.${name}, but that component is a different contract than ${this.checker.typeToString(reference.type)}. Rename the class or its @ApiSchema({ name }).`,
    ));
  }

  /** The schemas of every registered class and enum. Resolving one registered class can register the classes its own metadata names. */
  registeredSchemas(): Record<string, unknown> {
    const registered: Record<string, unknown> = {};
    for (let added = true; added;) {
      added = false;
      for (const [name, reference] of this.classes) {
        if (name in registered) continue;
        if (this.contractAnalysis.definitions[name] !== undefined) {
          this.assertComponentIdentity(name, reference);
          continue;
        }
        registered[name] = this.classSchema(name);
        added = true;
      }
    }
    for (const [name, schema] of this.enums) {
      if (!(name in registered)) registered[name] = schema;
    }
    return registered;
  }

  /** The schemas of the model definitions that `document` reaches by `$ref` and does not already hold. */
  reachableSchemas(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const components = objectRecord(document.components);
    const existingSchemas = objectRecord(components?.schemas) ?? {};
    const pending = new Set<string>();
    collectComponentReferences(document, pending);
    const generated: Record<string, unknown> = {};
    const visited = new Set<string>();
    while (pending.size > 0) {
      const name = pending.values().next().value as string;
      pending.delete(name);
      if (visited.has(name)) continue;
      visited.add(name);
      const existing = existingSchemas[name];
      if (existing !== undefined) {
        collectComponentReferences(existing, pending);
        continue;
      }
      const descriptor = this.contractAnalysis.definitions[name];
      if (descriptor === undefined) continue;
      const schema = this.schemaOf(descriptor);
      generated[name] = schema;
      collectComponentReferences(schema, pending);
    }
    return generated;
  }
}

/** The document with `schemas` as its `components.schemas`; a document keeps its other components. */
function withSchemas(
  document: Readonly<Record<string, unknown>>,
  schemas: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.keys(schemas).length === 0
    ? document
    : { ...document, components: { ...(objectRecord(document.components) ?? {}), schemas } };
}

/** The document with the registered schemas and the model schemas it reaches. */
function completeDocument(builtDocument: Readonly<Record<string, unknown>>, schemas: ComponentSchemas): Readonly<Record<string, unknown>> {
  const registered = schemas.registeredSchemas();
  const generated = schemas.reachableSchemas(withSchemas(builtDocument, registered));
  return withSchemas(builtDocument, { ...registered, ...generated });
}

/** Reports each file the run reads to the caller's observer, and keeps the set for the watch inputs. */
function inputObserver(onInput: InputObserver | undefined): { readonly observed: Set<string>; readonly observe: InputObserver } {
  const observed = new Set<string>();
  return {
    observed,
    observe: (filename) => {
      const canonical = canonicalFilename(filename);
      observed.add(canonical);
      onInput?.(canonical);
    },
  };
}

function controllerSources(normalized: NormalizedContext, observe: InputObserver): readonly string[] {
  const sources = normalized.sources ?? discoverControllerSources(normalized.root, observe, normalized.suffixes);
  if (sources.length === 0) {
    throw new TsToOpenApiError({
      severity: GolemDiagnosticSeverity.Error,
      code: TsToOpenApiDiagnosticCode.NoControllerSources,
      message: `No controller source files found under ${displayPath(path.join(normalized.root, 'src'))}. Add a file that ends in ${normalized.suffixes.join(' or ')}, or list the controller files in \`sources\` of the controller job. In code, pass them as the \`sources\` option of \`generate\`.`,
    });
  }
  for (const source of sources) {
    observe(source);
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Controller source does not exist: ${displayPath(source)}`);
  }
  return sources;
}

function openProgram(
  sources: readonly string[],
  normalized: NormalizedContext,
  observe: InputObserver,
  session: ReturnType<typeof retainedProgramSession>,
): ProgramInfo {
  // With the models job known, a generated base class is a stub of its model, as in that job's program: the generated file on
  // disk is missing on the first run and stale until the models job rewrites it, which runs after this job.
  return normalized.boundary
    ? createModelStubProgram(sources, normalized.root, normalized.boundary, discoverModelSources(normalized.boundary.root, undefined, normalized.boundary.suffixes), observe, session, normalized.tsconfig)
    : createProgram(sources, normalized.root, observe, session, normalized.tsconfig);
}

function analyzeContracts(
  programInfo: ProgramInfo,
  sources: readonly string[],
  normalized: NormalizedContext,
  observe: InputObserver,
): ContractAnalysis {
  // The controllers job analyses the models its controllers use, with a models job or without one, so a syntax error in any file of the project stops here. A later job's output is left out: that job writes it again.
  assertNoSyntaxErrors(programInfo.program, [...new Set([...sources, ...projectFilenames(programInfo.program).filter(file => !isUnderOutputs(normalized.laterOutputs, file))])]);
  return createContractAnalysis(programInfo.program, {
    root: normalized.root,
    allowAny: normalized.profile.allowAny,
    exact: normalized.exact,
    laterOutputs: normalized.laterOutputs,
    classComponentName: declaration => apiSchemaName(programInfo.program.getTypeChecker(), declaration),
    // With the models job known, the manifests the program advertises decide which model files are SDK files, as they do for that job.
    // A manifest that a later job writes is not read, as no file under a later output is.
    ...(normalized.boundary ? { boundary: normalized.boundary, manifests: loadModelManifests(normalized.root, programInfo, [], normalized.profile, observe, normalized.laterOutputs) } : {}),
  });
}

/**
 * Analyse exported Nest controllers and return the exact OpenAPI artifact.
 * This provider never writes files; the shared CLI owns output ownership and
 * the check/watch lifecycle.
 */
export async function generate(context: TsToOpenApiContext): Promise<TsToOpenApiResult> {
  const normalized = validateContext(context);
  const { observed, observe } = inputObserver(normalized.onInput);
  const sources = controllerSources(normalized, observe);
  const session = retainedProgramSession(context.session, normalized.tsconfig === undefined ? normalized.root : path.dirname(normalized.tsconfig));
  const programInfo = openProgram(sources, normalized, observe, session);
  using program = programInfo.program;
  const checker = program.getTypeChecker();
  const contractAnalysis = analyzeContracts(programInfo, sources, normalized, observe);
  const schemas = new ComponentSchemas(checker, contractAnalysis, normalized.openapiVersion);
  const analysis = await analyzeControllers({
    root: normalized.root,
    sources,
    suffixes: normalized.suffixes,
    program,
    checker,
    openapiVersion: normalized.openapiVersion,
    maxResultBytes: normalized.maxResultBytes,
    onInput: observe,
    contractAnalysis,
    registerSchemaComponent: schemas.registerSchemaComponent,
    onWarning: schemas.report,
  }, {
    globalPrefix: context.globalPrefix,
    uriVersioning: context.uriVersioning,
  });
  const builtDocument = await buildDocument({
    checker,
    program,
    openapiVersion: normalized.openapiVersion,
    schemaResolver: schemas.canonicalSchema,
    resolveSchemaReference: schemas.resolveReference,
    info: context.info,
    ...(context.servers ? { servers: context.servers } : {}),
    ...(context.securitySchemes ? { securitySchemes: context.securitySchemes } : {}),
    ...(context.tags ? { tags: context.tags } : {}),
    routes: analysis.routes,
  });
  const finalDocument = completeDocument(builtDocument, schemas);
  assertResolvedLocalReferences(finalDocument);
  const artifact: GolemArtifact = { path: normalized.output, content: serializeForOutput(finalDocument, normalized.output) };
  const watchInputs = new Set(projectWatchInputs(programInfo, program, sources, []));
  for (const filename of observed) watchInputs.add(filename);
  return {
    apiVersion,
    artifacts: [artifact],
    manifestPaths: [],
    watchInputs: [...watchInputs].sort(),
    ...(schemas.reported.length > 0 ? { diagnostics: schemas.reported.map(asGolemDiagnostic) } : {}),
  };
}
