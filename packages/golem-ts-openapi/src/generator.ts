import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from '@exprtlabs/golem/ts';
import { operationCodecRegistryPath } from '@exprtlabs/golem/generated-paths';
import {
  assertAbsolute,
  canonicalFilename,
  createContractAnalysis,
  createProgram,
  retainedProgramSession,
  projectWatchInputs,
} from '@exprtlabs/golem/type-analysis';
import { schemaForDescriptor } from '@exprtlabs/golem/schema';
import type {
  GolemArtifact,
  GolemDiagnostic,
  GolemResult,
  ControllerContext,
  InputObserver,
  ResolvedGolemProfile,
} from '@exprtlabs/golem/generator-api';
import { DEFAULT_CONTROLLER_SUFFIXES, resolveProfile } from '@exprtlabs/golem/generator-api';
import {
  GolemDiagnosticSeverity,
  diagnostic,
  TsToOpenApiDiagnosticCode,
  TsToOpenApiError,
  type TsToOpenApiDiagnostic,
} from './diagnostics.js';
import { buildDocument, serializeForOutput } from './document.js';
import { analyzeControllers, discoverControllerSources } from './nest/routes.js';
import type { DtoSchema } from './nest/json-schema-merge.js';
import { applySwaggerPropertyMetadata } from './nest/swagger-overlay.js';
import type { NestAnalysisContext, TypeReference } from './nest/types.js';
import { emitOperationRegistry } from './operation-registry.js';
import type { SchemaResolutionContext, SchemaResolver } from './operations.js';

export const apiVersion = 1 as const;

export type TsToOpenApiContext = ControllerContext;

export interface TsToOpenApiResult extends GolemResult {
  readonly apiVersion: 1;
}

export type { GolemArtifact, GolemDiagnostic, InputObserver, ControllerContext };
export { GolemDiagnosticSeverity, TsToOpenApiDiagnosticCode } from './diagnostics.js';

function validateContext(context: TsToOpenApiContext): {
  readonly root: string;
  readonly output: string;
  readonly sources?: readonly string[];
  readonly suffixes: readonly string[];
  readonly openapiVersion: '3.2.0' | '3.1.2';
  readonly profile: ResolvedGolemProfile;
  readonly exact?: boolean;
  readonly onInput?: InputObserver;
} {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('generate(context) requires a context object.');
  }
  const root = assertAbsolute(context.root, 'context.root');
  context.onInput?.(root);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`context.root must be an existing directory: ${root}`);
  }
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
  return { root, output, ...(sources ? { sources } : {}), suffixes: context.suffixes ?? DEFAULT_CONTROLLER_SUFFIXES, openapiVersion, profile, exact: context.exact, onInput: context.onInput };
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
  return value.slice(prefix.length).replaceAll('~1', '/').replaceAll('~0', '~');
}

function assertResolvedLocalReferences(
  document: Readonly<Record<string, unknown>>,
): void {
  const components = objectRecord(document.components);
  const schemas = objectRecord(components?.schemas) ?? {};
  const seen = new Set<object>();
  const visit = (value: unknown, key?: string): void => {
    if (key === '$ref' && typeof value === 'string') {
      const name = componentReferenceName(value);
      if (name && schemas[name] === undefined) {
        throw new TsToOpenApiError({
          severity: GolemDiagnosticSeverity.Error,
          code: TsToOpenApiDiagnosticCode.UnresolvedSchemaReference,
          message: `OpenAPI metadata references missing local schema component ${value}.`,
        });
      }
      return;
    }
    if (typeof value === 'string') return;
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
  };
  visit(document);
}

function collectComponentReferences(value: unknown, names: Set<string>, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    const name = componentReferenceName(value);
    if (name) names.add(name);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectComponentReferences(item, names, seen);
    return;
  }
  for (const item of Object.values(value)) collectComponentReferences(item, names, seen);
}

function reachableGeneratedSchemas(
  document: Readonly<Record<string, unknown>>,
  definitions: Readonly<Record<string, unknown>>,
  schemaOptions: (sourceNode?: ts.Node) => object,
): Readonly<Record<string, unknown>> {
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
    const descriptor = definitions[name];
    if (descriptor === undefined) continue;
    const schema = schemaForDescriptor(descriptor, schemaOptions());
    generated[name] = schema;
    collectComponentReferences(schema, pending);
  }
  return generated;
}

/**
 * Analyse exported Nest controllers and return the exact OpenAPI artifact.
 * This provider never writes files; the shared CLI owns output ownership and
 * the check/watch lifecycle.
 */
export async function generate(context: TsToOpenApiContext): Promise<TsToOpenApiResult> {
  const normalized = validateContext(context);
  const observed = new Set<string>();
  const observe: InputObserver = (filename) => {
    const canonical = canonicalFilename(filename);
    observed.add(canonical);
    normalized.onInput?.(canonical);
  };
  const sources = normalized.sources ?? discoverControllerSources(normalized.root, observe, normalized.suffixes);
  if (sources.length === 0) {
    throw new TsToOpenApiError({
      severity: GolemDiagnosticSeverity.Error,
      code: TsToOpenApiDiagnosticCode.NoControllerSources,
      message: `No controller source files found under ${path.join(normalized.root, 'src')}. Add a file ending in ${normalized.suffixes.join(' or ')}, or provide context.sources.`,
    });
  }
  for (const source of sources) {
    observe(source);
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Controller source does not exist: ${source}`);
  }
  const programInfo = createProgram(
    sources,
    normalized.root,
    observe,
    retainedProgramSession(context.session, '@exprtlabs/golem-ts-openapi', normalized.root),
  );
  using program = programInfo.program;
  const checker = program.getTypeChecker();
  const contractAnalysis = createContractAnalysis(program, {
    root: normalized.root,
    allowAny: normalized.profile.allowAny,
    exact: normalized.exact,
  });
  const schemaDiagnostics: TsToOpenApiDiagnostic[] = [];
  const schemaDiagnosticKeys = new Set<string>();
  const reportSchemaDiagnostic = (entry: TsToOpenApiDiagnostic): void => {
    const key = `${entry.code}:${entry.file ?? ''}:${entry.line ?? ''}:${entry.column ?? ''}:${entry.message}`;
    if (schemaDiagnosticKeys.has(key)) return;
    schemaDiagnosticKeys.add(key);
    schemaDiagnostics.push(entry);
  };
  const schemaOptions = (sourceNode?: ts.Node) => ({
    definitions: contractAnalysis.definitions,
    representation: 'wire' as const,
    portable: true,
    referencePrefix: '#/components/schemas/',
    discriminatorMapping: true,
    onNonportable: (message: string): void => reportSchemaDiagnostic(diagnostic(
      sourceNode?.getSourceFile(),
      sourceNode,
      TsToOpenApiDiagnosticCode.NonportableSchema,
      message,
      GolemDiagnosticSeverity.Warning,
    )),
  });
  const describeControllerType = (
    type: ts.Type,
    sourceNode: ts.Node,
    typeNode?: ts.TypeNode,
  ): ReturnType<typeof contractAnalysis.describe> => {
    // The shared analyzer intentionally treats arrays as part of a model
    // conversion walk. A controller return such as `Payment[]` can point at
    // an authored model subclass whose generated companion is also present;
    // describing the item first keeps that named identity intact and avoids
    // re-entering the subclass's runtime fields as an anonymous object.
    if (checker.isArrayType(type)) {
      const itemType = checker.getTypeArguments(type as ts.TypeReference)[0] ?? checker.getAnyType();
      const itemNode = typeNode && ts.isArrayTypeNode(typeNode) ? typeNode.elementType
        : typeNode && ts.isTypeReferenceNode(typeNode) ? typeNode.typeArguments?.[0]
          : undefined;
      return { kind: 'array', item: describeControllerType(itemType, sourceNode, itemNode) };
    }
    const descriptor = contractAnalysis.describe(type, sourceNode, typeNode);
    return descriptor;
  };
  // Classes named by `getSchemaPath()`/`refs()` in Swagger metadata; each becomes a component schema.
  const schemaComponents = new Map<string, TypeReference>();
  const componentSchemas = new Map<string, DtoSchema>();
  const resolvingComponents = new Set<string>();
  const registerSchemaComponent = (name: string, reference: TypeReference): void => {
    const existing = schemaComponents.get(name);
    if (existing === undefined) {
      schemaComponents.set(name, reference);
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
  // Enums named by `@ApiProperty({ enum, enumName })`; each becomes one component schema.
  const enumComponents = new Map<string, Record<string, unknown>>();
  const registerEnumComponent = (name: string, schema: Record<string, unknown>, node: ts.Node): void => {
    const existing = enumComponents.get(name);
    const clash = existing !== undefined
      ? JSON.stringify(existing) !== JSON.stringify(schema)
      : schemaComponents.has(name) || contractAnalysis.definitions[name] !== undefined;
    if (clash) {
      throw new TsToOpenApiError(diagnostic(
        node.getSourceFile(),
        node,
        TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
        `enumName ${name} names components.schemas.${name}, which already describes a different schema.`,
      ));
    }
    enumComponents.set(name, schema);
  };
  const componentSchema = (name: string): DtoSchema | undefined => {
    const enumSchema = enumComponents.get(name);
    if (enumSchema !== undefined) return enumSchema;
    const cached = componentSchemas.get(name);
    if (cached !== undefined) return cached;
    const reference = schemaComponents.get(name);
    if (!reference || resolvingComponents.has(name)) return undefined;
    resolvingComponents.add(name);
    try {
      const schema = canonicalSchema({ reference, location: `components.schemas.${name}` });
      componentSchemas.set(name, schema);
      return schema;
    } finally {
      resolvingComponents.delete(name);
    }
  };
  const resolveComponentReference = (reference: string): DtoSchema | undefined => {
    const name = componentReferenceName(reference);
    if (name === undefined) return undefined;
    const descriptor = contractAnalysis.definitions[name];
    return descriptor === undefined ? componentSchema(name) : schemaForDescriptor(descriptor, schemaOptions());
  };
  const canonicalSchema = (schemaContext: Pick<SchemaResolutionContext, 'reference' | 'location'>): DtoSchema => {
    let descriptor = describeControllerType(
      schemaContext.reference.type,
      schemaContext.reference.sourceNode ?? schemaContext.reference.declaration ?? schemaContext.reference.sourceFile,
      schemaContext.reference.node,
    );
    // OpenAPI 3.2 querystring carries the complete object contract in the
    // parameter content. Inline a named root so object-level constraints such
    // such as dependentRequired remain visible to the query serializer;
    // nested named models still use stable component refs.
    if (schemaContext.location === 'querystring' && descriptor.kind === 'reference') {
      descriptor = contractAnalysis.definitions[descriptor.name] ?? descriptor;
    }
    const schema = schemaForDescriptor(descriptor, schemaOptions(schemaContext.reference.sourceNode));
    return applySwaggerPropertyMetadata(
      checker,
      schemaContext.reference.type,
      schema,
      schemaContext.reference.sourceNode ?? schemaContext.reference.declaration ?? schemaContext.reference.sourceFile,
      {
        authoritative: schemaContext.reference.modelContractName !== undefined,
        resolveReference: resolveComponentReference,
        isAuthoritativeType: (type, node) => {
          const described = contractAnalysis.describe(type, node ?? schemaContext.reference.sourceNode ?? schemaContext.reference.sourceFile);
          return described.kind === 'reference'
            && contractAnalysis.specFor(described.name) !== undefined;
        },
        location: schemaContext.location,
        onWarning: reportSchemaDiagnostic,
        registerSchemaComponent,
        registerEnumComponent,
      },
    );
  };
  const canonicalSchemaResolver: SchemaResolver = schemaContext => canonicalSchema(schemaContext);
  const analysisContext: NestAnalysisContext = {
    root: normalized.root,
    sources,
    suffixes: normalized.suffixes,
    program: programInfo.program,
    checker,
    openapiVersion: normalized.openapiVersion,
    onInput: observe,
    contractAnalysis,
    registerSchemaComponent,
    onWarning: reportSchemaDiagnostic,
  };
  const analysis = await analyzeControllers(analysisContext, {
    globalPrefix: context.globalPrefix,
    uriVersioning: context.uriVersioning,
  });
  const builtDocument = await buildDocument({
    checker,
    program: programInfo.program,
    openapiVersion: normalized.openapiVersion,
    schemaResolver: canonicalSchemaResolver,
    resolveSchemaReference: resolveComponentReference,
    info: context.info,
    ...(context.servers ? { servers: context.servers } : {}),
    ...(context.securitySchemes ? { securitySchemes: context.securitySchemes } : {}),
    ...(context.tags ? { tags: context.tags } : {}),
    routes: analysis.routes,
  });
  const documentComponents = objectRecord(builtDocument.components);
  // A class named by getSchemaPath() may reuse an existing component only when it is that component's contract.
  const assertComponentIdentity = (name: string, reference: TypeReference): void => {
    const described = contractAnalysis.describe(reference.type, reference.sourceNode ?? reference.sourceFile);
    if (described.kind === 'reference' && described.name === name) return;
    throw new TsToOpenApiError(diagnostic(
      reference.sourceFile,
      reference.sourceNode,
      TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
      `getSchemaPath() names components.schemas.${name}, but that component is a different contract than ${checker.typeToString(reference.type)}. Rename the class or its @ApiSchema({ name }).`,
    ));
  };
  // Resolving one registered component can register the classes its own metadata names.
  const registeredSchemas: Record<string, unknown> = {};
  for (let added = true; added;) {
    added = false;
    for (const [name, reference] of schemaComponents) {
      if (name in registeredSchemas) continue;
      if (contractAnalysis.definitions[name] !== undefined) {
        assertComponentIdentity(name, reference);
        continue;
      }
      registeredSchemas[name] = componentSchema(name);
      added = true;
    }
  }
  const withComponents = (schemas: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => (
    Object.keys(schemas).length === 0
      ? builtDocument
      : { ...builtDocument, components: { ...(documentComponents ?? {}), schemas } }
  );
  for (const [name, schema] of enumComponents) {
    if (!(name in registeredSchemas)) registeredSchemas[name] = schema;
  }
  const registeredDocument = withComponents(registeredSchemas);
  const generatedSchemas = reachableGeneratedSchemas(
    registeredDocument,
    contractAnalysis.definitions,
    schemaOptions,
  );
  const finalDocument = withComponents({ ...registeredSchemas, ...generatedSchemas });
  assertResolvedLocalReferences(finalDocument);
  const content = serializeForOutput(finalDocument, normalized.output);
  const artifact: GolemArtifact = { path: normalized.output, content };
  const operationRegistry = emitOperationRegistry(
    analysis.routes,
    operationCodecRegistryPath(normalized.root),
  );
  const watchInputs = new Set(projectWatchInputs(
    programInfo,
    programInfo.program,
    sources,
    [],
  ));
  for (const filename of observed) watchInputs.add(filename);
  return {
    apiVersion,
    artifacts: [artifact, operationRegistry],
    manifestPaths: [],
    watchInputs: [...watchInputs].sort(),
    ...(schemaDiagnostics.length > 0 ? { diagnostics: schemaDiagnostics.map(asGolemDiagnostic) } : {}),
  };
}
