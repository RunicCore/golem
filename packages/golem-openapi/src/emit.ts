import path from 'node:path';
import { GolemDiagnosticSeverity, type GolemDiagnostic, type GolemResult } from '@exprtlabs/golem/generator-api';
import { stableJson } from '@exprtlabs/golem/generator-api';
import { assertPortableFilenames, identifier, isRecord } from '@exprtlabs/golem/internal/generator-support';
import { buildOperationValidationSchemas, generateClientModules, operationValidatorNames, responseHeaderRequired } from './client/emit.js';
import { browserCookieDiagnostics, normalizeAndValidate, unsupportedHttpAuthSchemes, type MovedUnions } from './document.js';
import { buildEmissionPlan, serverOverrideDiagnostics, type ArtifactFile, type EmissionPlan } from './emission-plan.js';
import { asRecord, objectEntries, readString } from './json.js';
import { assertUniqueExportNames, code, documentLiteral, exportedName, fileImports, identifier as identifierPart, ImportSource, join, literal, renderModule, rt, rtType, runtimeLinesOf, type Code, type ImportOptions, type PublicModule, type RenderedModule } from '@exprtlabs/golem/internal/emitter';
import { operationName, operationNameType } from './names.js';
import type { NormalizedOperation } from './normalize.js';
import { generatedBannerComment } from './package-info.js';
import { runtimeCopy, standaloneRuntimeSpecifiers, type RuntimeSpecifiers } from './runtime-copy.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  analyzeOpenApiModels,
  checkOperationCompositions,
  generateModelManifest,
  generateOpenApiModelArtifacts,
  generateOperationCodecs,
  type OpenApiDates,
} from './models.js';
import { neverPropertiesReader, type OpenApiModelAnalysis } from './model-resolution.js';
import { requestBodyKey } from './model-schema-graph.js';
import { golemCodecs, standaloneCodecs, type OperationCodecsFor } from './operation-codecs.js';
import { withOrigins, type OriginLocator } from './origin.js';
import { buildSchemaData } from './schemas.js';
import { compileLevel, compileSdkValidators, uniqueDiagnostics, type CodecValidationPlan, type PlanValidators, type SchemaPlace } from '@exprtlabs/golem/internal/validation-plan';
import { descriptionComment, generateDirectionalSchemas, generateTypes } from './types.js';

interface WriteSdkResult extends GolemResult {}

interface WriteSdkOptions {
  readonly output: string;
  readonly name?: string;
  readonly profile: OpenApiGenerationProfile;
  /** `temporal` maps date formats to Temporal types; the default keeps `Date`. */
  readonly dates?: OpenApiDates;
  /** `golem` writes the schema graph into the manifest for the models job; the default, `standalone`, keeps the SDK self-contained. */
  readonly mode?: 'standalone' | 'golem';
  /** Mode `golem` only, and required there: the file the models job writes for this SDK, which the operation modules import. */
  readonly codecsFile?: string;
  /** Names where a bundled component came from; generator errors that name one append it. */
  readonly locate?: OriginLocator;
}

function generateLinks(operations: readonly NormalizedOperation[]): RenderedModule {
  const operationNames = new Set(operations.map((operation) => operation.name));
  // Object.fromEntries defines own keys: assigning a link named `__proto__` would set a prototype and drop the link.
  const linkEntries: Array<[string, Record<string, Record<string, unknown>>]> = [];
  for (const operation of operations) {
    const responseEntries: Array<[string, Record<string, unknown>]> = [];
    for (const response of operation.responses) {
      const linkEntriesOfResponse: Array<[string, unknown]> = [];
      for (const [name, link] of Object.entries(response.links || {})) {
        if (!isRecord(link)) continue;
        let target: Record<string, unknown>;
        if (typeof link.operationId === 'string') {
          const generatedName = operationName({ operationId: link.operationId }, '', '').name;
          if (!operationNames.has(generatedName)) {
            throw new Error(
              `response link "${operation.name}.${response.status}.${name}" targets unknown operationId "${link.operationId}"`,
            );
          }
          target = { operationId: generatedName };
        } else if (typeof link.operationRef === 'string') {
          target = { operationRef: link.operationRef };
        } else {
          throw new Error(
            `response link "${operation.name}.${response.status}.${name}" must declare operationId or operationRef`,
          );
        }
        linkEntriesOfResponse.push([name, {
          ...target,
          parameters: link.parameters || {},
          ...(link.requestBody === undefined ? {} : { requestBody: link.requestBody }),
          ...(link.description === undefined ? {} : { description: link.description }),
          ...(link.server === undefined ? {} : { server: link.server }),
        }]);
      }
      if (linkEntriesOfResponse.length) responseEntries.push([response.status, Object.fromEntries(linkEntriesOfResponse)]);
    }
    if (responseEntries.length) linkEntries.push([operation.name, Object.fromEntries(responseEntries)]);
  }
  const links = Object.fromEntries(linkEntries);
  return renderModule(code`${generatedBannerComment()}
${operationNameType('OperationName', operations)}

export interface ${exportedName('LinkServer')} {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Readonly<Record<string, {
    readonly default: string;
    readonly description?: string;
    readonly enum?: readonly string[];
  }>>;
}

export type ${exportedName('ResponseLinkTarget')} =
  | { readonly operationId: OperationName; readonly operationRef?: never }
  | { readonly operationRef: string; readonly operationId?: never };

export type ${exportedName('ResponseLink')} = ResponseLinkTarget & {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestBody?: unknown;
  readonly description?: string;
  readonly server?: LinkServer;
};

export type ${exportedName('ResponseLinkRegistry')} = Readonly<Record<
  OperationName,
  Readonly<Record<string, Readonly<Record<string, ResponseLink>>>>
>>;

/**
 * OpenAPI response Link Objects indexed by generated operation name, response
 * status key, and link name. Runtime expressions are preserved verbatim for
 * application-owned workflow/navigation code to evaluate.
 */
export const ${exportedName('responseLinks')} = ${documentLiteral(links, 2)} as const satisfies Partial<ResponseLinkRegistry>;
`);
}

/** The index module, and the files it re-exports with `export *`. */
function generateIndex(profile: OpenApiGenerationProfile, plan?: EmissionPlan): RenderedModule & { readonly stars: readonly string[] } {
  requireProfile(profile);
  const artifacts = plan?.artifacts;
  const include = (name: ArtifactFile): boolean => artifacts ? artifacts.has(name) : true;
  const stars = ['types.ts', ...(['client.ts', 'links.ts'] as const).filter(include)];
  return { ...renderModule(code`${generatedBannerComment()}
export * from './types.js';
${include('input-schemas.ts') ? code`export type * as ${exportedName('InputSchemas')} from './input-schemas.js';` : code``}
${include('output-schemas.ts') ? code`export type * as ${exportedName('OutputSchemas')} from './output-schemas.js';` : code``}
${include('client.ts') ? code`export * from './client.js';` : code``}
${include('links.ts') ? code`export * from './links.js';` : code``}
`), stars };
}

/** The document's servers as data, and the base URLs of the operations that other servers override. The client and every operation module pass them to the runtime. */
function generateServers(plan: EmissionPlan): RenderedModule {
  return renderModule(code`${generatedBannerComment()}
export const ${exportedName('servers')} = ${documentLiteral(plan.servers, 2)} as const;
${plan.operationServers.length ? code`
export const ${exportedName('operationServers')} = ${documentLiteral(plan.operationServers, 2)} as const;
` : code``}`);
}

function generatedFiles(document: unknown, options: WriteSdkOptions, moved: MovedUnions): GeneratedFiles {
  return withOrigins(options.locate, () => buildGeneratedFiles(document, options, moved));
}

interface GeneratedFiles {
  files: Map<string, string>;
  output: string;
  clientName: string;
  operations: readonly NormalizedOperation[];
  diagnostics: readonly GolemDiagnostic[];
}

/** A standalone SDK carries no MobX runtime, so a profile with `mobx: true` needs the golem mode. */
function mobxStandaloneDiagnostics(profile: OpenApiGenerationProfile): GolemDiagnostic[] {
  return profile.mobx ? [{
    code: 'OPENAPI_MOBX_NEEDS_GOLEM_MODE',
    severity: GolemDiagnosticSeverity.Error,
    message: 'mobx: true needs the MobX runtime of @exprtlabs/golem, which a standalone SDK does not carry. Set mode: golem on this openapi job, or set mobx: false.',
  }] : [];
}

function buildGeneratedFiles(document: unknown, options: WriteSdkOptions, moved: MovedUnions): GeneratedFiles {
  const profile = requireProfile(options.profile);
  const ir = normalizeAndValidate(document, options.locate);
  unsupportedHttpAuthSchemes(document);
  const operations = ir.operations;
  const inboundOperations = ir.inboundOperations;
  const clientName = identifier(options.name || readString(asRecord(asRecord(document).info).title), 'Api');
  const output = path.resolve(options.output);
  const plan = buildEmissionPlan(document, ir, profile);
  // A standalone SDK imports the runtime it carries and its own codecs. An SDK of golem mode imports `@exprtlabs/golem` and the table that the models job
  // of the same golem.yaml writes later in the run: it holds the types, the client and the manifest, and no validator, group module or codec.
  const golem = options.mode === 'golem';
  if (golem && options.codecsFile === undefined) throw new Error('An SDK of mode golem needs codecsFile, the file that the models job writes for it.');
  // The payloads of webhooks and callbacks are SDK types like any other: their operations take part in the types and the model analysis, and have no codecs, validators or handler.
  const modelAnalysis = analyzeOpenApiModels(document, profile.validation, options.dates ?? 'date', [...operations, ...inboundOperations]);
  const inlineDiagnostics = checkOperationCompositions([...operations, ...inboundOperations], modelAnalysis, document);
  const schemaData = profile.validation && plan.hasOutboundOperations
    // A request body that converts and whose descriptors carry every keyword of its schema is checked by its own conversion, so the input root of its client operation leaves it open; any other request body keeps the wire check of the root.
    ? buildSchemaData(document, ir, (operation, contentType) => modelAnalysis.convertedNodeIds.has(requestBodyKey(operation.name, contentType)) && !modelAnalysis.uncarriedValues.has(requestBodyKey(operation.name, contentType)))
    : undefined;
  const files = new Map<string, string>();
  const specifiers: RuntimeSpecifiers | undefined = golem ? undefined : standaloneRuntimeSpecifiers;
  const codecsFor: OperationCodecsFor = options.codecsFile === undefined ? standaloneCodecs : golemCodecs(output, options.codecsFile);
  // The names that each module of the index exports come from its Code, and the index re-exports the whole modules it stars.
  const modules = new Map<string, PublicModule>();
  const neverProperties = neverPropertiesReader(modelAnalysis, document);
  const types = generateTypes(document, [...operations, ...inboundOperations], plan, options.dates, neverProperties);
  files.set('types.ts', types.source);
  modules.set('types.ts', { exports: types.exports, stars: [] });
  if (plan.artifacts.has('input-schemas.ts')) {
    files.set('input-schemas.ts', generateDirectionalSchemas(document, 'input', options.dates, neverProperties));
  }
  if (plan.artifacts.has('output-schemas.ts')) {
    files.set('output-schemas.ts', generateDirectionalSchemas(document, 'output', options.dates, neverProperties));
  }
  // One validators module serves the models and the operations: it compiles the roots of every model group and
  // every operation together, so a check the two share is written once.
  const hasOperationModules = plan.artifacts.has('client.ts');
  const operationValidation = hasOperationModules
    ? buildOperationValidationSchemas(operations, document, profile, schemaData, options.locate, moved)
    : undefined;
  const validators: { compiled?: PlanValidators } = {};
  const validatorOptions = {
    owner: '@exprtlabs/golem-openapi',
    unknownFormats: profile.unknownFormats,
    level: compileLevel(profile.validation),
    documentName: 'the OpenAPI document',
    ...(operationValidation ? { locate: operationValidation.locate } : {}),
    ...(specifiers ? { specifiers: specifiers('validators.generated.ts') } : {}),
  } as const;
  // Every root is lowered, so each schema check and diagnostic runs; the module exports the roots an operation reads and the roots of the
  // written groups, so a model no operation reaches adds no code to the SDK.
  const compileValidators = (plan: CodecValidationPlan | undefined, locateModel?: (name: string) => SchemaPlace, reached?: ReadonlySet<string>): PlanValidators => {
    const operations = operationValidation?.operations ?? [];
    validators.compiled = compileSdkValidators(
      { ...(plan ? { plan } : {}), operations },
      {
        ...validatorOptions,
        ...(locateModel ? { locateModel } : {}),
        ...(reached ? { emitRoots: new Set([...reached, ...operations.flatMap((operation) => Object.keys(operation.roots))]) } : {}),
      },
    );
    return validators.compiled;
  };
  const modelDiagnostics: GolemDiagnostic[] = [];
  if (!golem && modelAnalysis.grouping.groups.length > 0) {
    const models = generateOpenApiModelArtifacts(document, profile, modelAnalysis, {
      locate: options.locate,
      ...(specifiers ? { specifiers } : {}),
      ...(profile.validation ? { compileValidators: ({ plan, reachedRoots, locateModel }: { plan: CodecValidationPlan; groupPlans: ReadonlyMap<string, CodecValidationPlan>; reachedRoots: ReadonlySet<string>; locateModel: (name: string) => SchemaPlace }) => compileValidators(plan, locateModel, reachedRoots) } : {}),
    });
    for (const [name, source] of models.files) files.set(name, source);
  }
  // An SDK of golem mode compiles nothing: its manifest carries the roots and the models job compiles them (R-82).
  if (!golem && operationValidation && !validators.compiled) compileValidators(undefined);
  if (validators.compiled) {
    modelDiagnostics.push(...validators.compiled.diagnostics);
    // A source is empty when the compile reported an error; no file is written then. Only operations import the module.
    if (operationValidation && validators.compiled.source !== '' && validators.compiled.exports.size > 0) files.set('validators.generated.ts', validators.compiled.source);
  }
  files.set('model-manifest.json', stableJson(generateModelManifest(document, profile, modelAnalysis, options.mode, { operations, validation: operationValidation })));
  if (plan.artifacts.has('client.ts')) {
    const clientModules = generateClientModules(
      clientName,
      operations,
      document,
      profile,
      plan,
      modelAnalysis.convertedNodeIds,
      codecsFor,
      specifiers,
    );
    files.set('client.ts', clientModules.client.source);
    modules.set('client.ts', { exports: clientModules.client.exports, stars: [] });
    for (const [name, source] of clientModules.operations) files.set(name, source);
  }
  if (hasOperationModules && !golem) {
    for (const [name, source] of generateOperationCodecs(
      operations,
      profile,
      modelAnalysis,
      operationValidation && validators.compiled ? operationValidatorNames(operationValidation, validators.compiled.exports) : undefined,
    )) files.set(name, source);
  }
  if (plan.artifacts.has('servers.ts')) {
    const serversModule = generateServers(plan);
    files.set('servers.ts', serversModule.source);
    modules.set('servers.ts', { exports: serversModule.exports, stars: [] });
  }
  if (plan.artifacts.has('links.ts')) {
    const links = generateLinks(operations);
    files.set('links.ts', links.source);
    modules.set('links.ts', { exports: links.exports, stars: [] });
  }
  const index = generateIndex(profile, plan);
  files.set('index.ts', index.source);
  modules.set('index.ts', { exports: index.exports, stars: index.stars });
  assertUniqueExportNames(modules);
  // The runtime copy is written whole beside the files that import it, and only an SDK with operations imports it.
  if (specifiers && plan.artifacts.has('client.ts')) for (const [name, source] of runtimeCopy()) files.set(name, source);
  assertPortableFilenames(files.keys());
  return { files, output, clientName, operations, diagnostics: uniqueDiagnostics([...(specifiers ? mobxStandaloneDiagnostics(profile) : []), ...ir.diagnostics, ...browserCookieDiagnostics(document, operations), ...serverOverrideDiagnostics(document, operations), ...modelAnalysis.diagnostics, ...inlineDiagnostics, ...modelDiagnostics]) };
}

/**
 * Compatibility helper for callers that already hold a validated document.
 * Generation is intentionally pure: the caller owns filesystem writes.
 */
/** `moved` names the schemas whose unions the caller moved under `allOf` (`normalizeSchemaUnions`), so a message names the user's place. */
export function writeSdk(document: unknown, options: WriteSdkOptions, moved: MovedUnions = new Map()): WriteSdkResult {
  const generated = generatedFiles(document, options, moved);
  // A validator that could not be compiled leaves the files incomplete: report the diagnostics and write nothing.
  if (generated.diagnostics.some((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error)) {
    return { artifacts: [], manifestPaths: [], watchInputs: [], diagnostics: generated.diagnostics };
  }
  return {
    artifacts: [...generated.files].map(([name, content]) => ({
      path: path.resolve(generated.output, name),
      content,
    })),
    manifestPaths: [path.resolve(generated.output, 'model-manifest.json')],
    watchInputs: [],
    ...(generated.diagnostics.length ? { diagnostics: generated.diagnostics } : {}),
  };
}
