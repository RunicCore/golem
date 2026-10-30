import path from 'node:path';
import { GolemDiagnosticSeverity, type GolemDiagnostic, type GolemResult } from '@exprtlabs/golem/generator-api';
import { stableJson } from '@exprtlabs/golem/generator-api';
import { assertPortableFilenames, identifier, isRecord } from '@exprtlabs/golem/internal/generator-support';
import { buildOperationValidationSchemas, generateClientModules, operationValidatorNames } from './client/emit.js';
import { browserCookieDiagnostics, normalizeAndValidate, unsupportedHttpAuthSchemes, type MovedUnions } from './document.js';
import { buildEmissionPlan, serverOverrideDiagnostics, type ArtifactFile, type EmissionPlan } from './emission-plan.js';
import { asRecord, readString } from './json.js';
import { assertUniqueExportNames, code, documentLiteral, exportedName, identifier as identifierPart, join, renderModule, type Code, type PublicModule, type RenderedModule } from '@exprtlabs/golem/internal/emitter';
import { operationName, operationNameType } from './names.js';
import type { NormalizedOperation } from './normalize.js';
import { generatedBannerComment } from './package-info.js';
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
import { neverPropertiesReader } from './model-resolution.js';
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
  const stars = ['types.ts', ...(['client.ts', 'inbound.ts', 'links.ts'] as const).filter(include)];
  return { ...renderModule(code`${generatedBannerComment()}
export * from './types.js';
${include('input-schemas.ts') ? code`export type * as ${exportedName('InputSchemas')} from './input-schemas.js';` : code``}
${include('output-schemas.ts') ? code`export type * as ${exportedName('OutputSchemas')} from './output-schemas.js';` : code``}
${include('client.ts') ? code`export * from './client.js';` : code``}
${include('inbound.ts') ? code`export * from './inbound.js';` : code``}
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

function generateInbound(clientName: string, operations: readonly NormalizedOperation[]): RenderedModule {
  const methods = join(operations.map((operation) =>
    code`  ${descriptionComment(`${operation.sourceKind} ${operation.sourceName}: ${operation.method} ${operation.route}`)}\n  ${identifierPart(operation.name)}(input: Types.${identifierPart(`${operation.typeName}OperationInput`)}): Promise<Types.${identifierPart(`${operation.typeName}OperationHttpResponse`)}>;`,
  ), code`\n\n`);
  return renderModule(code`${generatedBannerComment()}
import type * as Types from './types.js';

/**
 * Application-owned handlers for inbound OpenAPI callbacks and webhooks.
 * This contract intentionally does not choose an HTTP server framework.
 */
export interface ${exportedName(`${clientName}InboundPort`)} {
${methods}
}
`);
}

function generatedFiles(document: unknown, options: WriteSdkOptions, moved: MovedUnions): GeneratedFiles {
  return withOrigins(options.locate, () => buildGeneratedFiles(document, options, moved));
}

interface GeneratedFiles {
  files: Map<string, string>;
  output: string;
  clientName: string;
  operations: readonly NormalizedOperation[];
  inboundOperations: readonly NormalizedOperation[];
  diagnostics: readonly GolemDiagnostic[];
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
  const modelAnalysis = analyzeOpenApiModels(document, profile.validation, options.dates ?? 'date', operations);
  const inlineDiagnostics = checkOperationCompositions([...operations, ...inboundOperations], modelAnalysis, document);
  const schemaData = profile.validation && plan.hasOutboundOperations
    ? buildSchemaData(document, ir)
    : undefined;
  const files = new Map<string, string>();
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
  const operationValidation = plan.artifacts.has('client.ts')
    ? buildOperationValidationSchemas(operations, document, profile, schemaData, options.locate, moved)
    : undefined;
  const validators: { compiled?: PlanValidators } = {};
  const validatorOptions = {
    owner: '@exprtlabs/golem-openapi',
    unknownFormats: profile.unknownFormats,
    level: compileLevel(profile.validation),
    documentName: 'the OpenAPI document',
    ...(operationValidation ? { locate: operationValidation.locate } : {}),
  } as const;
  const compileValidators = (plan: CodecValidationPlan | undefined, locateModel?: (name: string) => SchemaPlace): PlanValidators => {
    validators.compiled = compileSdkValidators(
      { ...(plan ? { plan } : {}), operations: operationValidation?.operations ?? [] },
      { ...validatorOptions, ...(locateModel ? { locateModel } : {}) },
    );
    return validators.compiled;
  };
  const modelDiagnostics: GolemDiagnostic[] = [];
  if (modelAnalysis.grouping.groups.length > 0) {
    const models = generateOpenApiModelArtifacts(document, profile, modelAnalysis, {
      locate: options.locate,
      ...(profile.validation ? { compileValidators: ({ plan, locateModel }: { plan: CodecValidationPlan; locateModel: (name: string) => SchemaPlace }) => compileValidators(plan, locateModel) } : {}),
    });
    for (const [name, source] of models.files) files.set(name, source);
  }
  if (operationValidation && !validators.compiled) compileValidators(undefined);
  if (validators.compiled) {
    modelDiagnostics.push(...validators.compiled.diagnostics);
    // A source is empty when the compile reported an error; no file is written then. Only operations import the module.
    if (operationValidation && validators.compiled.source !== '' && validators.compiled.exports.size > 0) files.set('validators.generated.ts', validators.compiled.source);
  }
  files.set('model-manifest.json', stableJson(generateModelManifest(document, profile, modelAnalysis)));
  if (plan.artifacts.has('client.ts')) {
    const clientModules = generateClientModules(
      clientName,
      operations,
      document,
      profile,
      plan,
      modelAnalysis.bodyNodeIds,
    );
    files.set('client.ts', clientModules.client.source);
    modules.set('client.ts', { exports: clientModules.client.exports, stars: [] });
    for (const [name, source] of clientModules.operations) files.set(name, source);
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
  if (plan.artifacts.has('inbound.ts')) {
    const inbound = generateInbound(clientName, inboundOperations);
    files.set('inbound.ts', inbound.source);
    modules.set('inbound.ts', { exports: inbound.exports, stars: [] });
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
  assertPortableFilenames(files.keys());
  return { files, output, clientName, operations, inboundOperations, diagnostics: uniqueDiagnostics([...ir.diagnostics, ...browserCookieDiagnostics(document, operations), ...serverOverrideDiagnostics(document, operations), ...modelAnalysis.diagnostics, ...inlineDiagnostics, ...modelDiagnostics]) };
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
