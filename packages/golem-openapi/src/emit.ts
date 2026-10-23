import path from 'node:path';
import { GolemDiagnosticSeverity, type GolemDiagnostic, type GolemResult } from '@exprtlabs/golem/generator-api';
import { isRecord, stableJson } from '@exprtlabs/golem/generator-api';
import { buildOperationValidationSchemas, generateClientModules } from './client/emit.js';
import { browserCookieDiagnostics, normalizeAndValidate, unsupportedHttpAuthSchemes } from './document.js';
import { buildEmissionPlan, type ArtifactFile, type EmissionPlan } from './emission-plan.js';
import { asRecord, readString } from './json.js';
import { assertPortableFilenames, assertUniquePublicExports, identifier } from '@exprtlabs/golem/generator-api';
import { code, docComment, documentLiteral, identifier as identifierPart, join, render, type Code } from '@exprtlabs/golem/internal/emitter';
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
  type OpenApiDates,
} from './models.js';
import { withOrigins, type OriginLocator } from './origin.js';
import { buildSchemaData } from './schemas.js';
import { compileSdkValidators, uniqueDiagnostics, type CodecValidationPlan, type PlanValidators, type SchemaPlace } from '@exprtlabs/golem/internal/validation-plan';
import { generateDirectionalSchemas, generateTypes } from './types.js';

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

function generateLinks(operations: readonly NormalizedOperation[]): string {
  const operationNames = new Set(operations.map((operation) => operation.name));
  const links: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const operation of operations) {
    const responses: Record<string, Record<string, unknown>> = {};
    for (const response of operation.responses) {
      const responseLinks: Record<string, unknown> = {};
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
        responseLinks[name] = {
          ...target,
          parameters: link.parameters || {},
          ...(link.requestBody === undefined ? {} : { requestBody: link.requestBody }),
          ...(link.description === undefined ? {} : { description: link.description }),
          ...(link.server === undefined ? {} : { server: link.server }),
        };
      }
      if (Object.keys(responseLinks).length) responses[response.status] = responseLinks;
    }
    if (Object.keys(responses).length) links[operation.name] = responses;
  }
  return render(code`${generatedBannerComment()}
${operationNameType('OperationName', operations)}

export interface LinkServer {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Readonly<Record<string, {
    readonly default: string;
    readonly description?: string;
    readonly enum?: readonly string[];
  }>>;
}

export type ResponseLinkTarget =
  | { readonly operationId: OperationName; readonly operationRef?: never }
  | { readonly operationRef: string; readonly operationId?: never };

export type ResponseLink = ResponseLinkTarget & {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestBody?: unknown;
  readonly description?: string;
  readonly server?: LinkServer;
};

export type ResponseLinkRegistry = Readonly<Record<
  OperationName,
  Readonly<Record<string, Readonly<Record<string, ResponseLink>>>>
>>;

/**
 * OpenAPI response Link Objects indexed by generated operation name, response
 * status key, and link name. Runtime expressions are preserved verbatim for
 * application-owned workflow/navigation code to evaluate.
 */
export const responseLinks = ${documentLiteral(links, 2)} as const satisfies Partial<ResponseLinkRegistry>;
`);
}

function generateIndex(profile: OpenApiGenerationProfile, plan?: EmissionPlan, modelReexports: Code = code``): string {
  requireProfile(profile);
  const artifacts = plan?.artifacts;
  const include = (name: ArtifactFile): boolean => artifacts ? artifacts.has(name) : true;
  return render(code`${generatedBannerComment()}
export * from './types.js';
${include('input-schemas.ts') ? code`export type * as InputSchemas from './input-schemas.js';` : code``}
${include('output-schemas.ts') ? code`export type * as OutputSchemas from './output-schemas.js';` : code``}
${modelReexports}
${include('client.ts') ? code`export * from './client.js';` : code``}
${include('inbound.ts') ? code`export * from './inbound.js';` : code``}
${include('links.ts') ? code`export * from './links.js';` : code``}
`);
}

function generateInbound(clientName: string, operations: readonly NormalizedOperation[]): string {
  const methods = join(operations.map((operation) =>
    code`  ${docComment(`${operation.sourceKind} ${operation.sourceName}: ${operation.method} ${operation.route}`)}\n  ${identifierPart(operation.name)}(input: Types.${identifierPart(`${operation.typeName}OperationInput`)}): Promise<Types.${identifierPart(`${operation.typeName}OperationHttpResponse`)}>;`,
  ), code`\n\n`);
  return render(code`${generatedBannerComment()}
import type * as Types from './types.js';

/**
 * Application-owned handlers for inbound OpenAPI callbacks and webhooks.
 * This contract intentionally does not choose an HTTP server framework.
 */
export interface ${identifierPart(`${clientName}InboundPort`)} {
${methods}
}
`);
}

export function generatedFiles(document: unknown, options: WriteSdkOptions): GeneratedFiles {
  return withOrigins(options.locate, () => buildGeneratedFiles(document, options));
}

interface GeneratedFiles {
  files: Map<string, string>;
  output: string;
  clientName: string;
  operations: readonly NormalizedOperation[];
  inboundOperations: readonly NormalizedOperation[];
  diagnostics: readonly GolemDiagnostic[];
}

function buildGeneratedFiles(document: unknown, options: WriteSdkOptions): GeneratedFiles {
  const profile = requireProfile(options.profile);
  const ir = normalizeAndValidate(document, options.locate);
  unsupportedHttpAuthSchemes(document);
  const operations = ir.operations;
  const inboundOperations = ir.inboundOperations;
  const clientName = identifier(options.name || readString(asRecord(asRecord(document).info).title), 'Api');
  const output = path.resolve(options.output);
  const plan = buildEmissionPlan(document, ir, profile);
  const modelAnalysis = analyzeOpenApiModels(document, profile.validation, options.dates ?? 'date');
  const inlineDiagnostics = checkOperationCompositions([...operations, ...inboundOperations], modelAnalysis, document);
  const schemaData = profile.validation && plan.hasOutboundOperations
    ? buildSchemaData(document, ir)
    : undefined;
  const files = new Map<string, string>();
  files.set('types.ts', generateTypes(document, [...operations, ...inboundOperations], plan));
  if (plan.artifacts.has('input-schemas.ts')) {
    files.set('input-schemas.ts', generateDirectionalSchemas(document, 'input'));
  }
  if (plan.artifacts.has('output-schemas.ts')) {
    files.set('output-schemas.ts', generateDirectionalSchemas(document, 'output'));
  }
  // One validators module serves the models and the operations: it compiles the roots of every model group and
  // every operation together, so a check the two share is written once.
  const operationValidation = plan.artifacts.has('client.ts')
    ? buildOperationValidationSchemas(operations, document, profile, schemaData, options.locate)
    : undefined;
  const validators: { compiled?: PlanValidators } = {};
  const validatorOptions = {
    owner: '@exprtlabs/golem-openapi',
    unknownFormats: profile.unknownFormats,
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
  let modelReexports: Code = code``;
  const modelDiagnostics: GolemDiagnostic[] = [];
  if (plan.hasModels) {
    const models = generateOpenApiModelArtifacts(document, profile, modelAnalysis, {
      locate: options.locate,
      ...(profile.validation ? { compileValidators: ({ plan, locateModel }: { plan: CodecValidationPlan; locateModel: (name: string) => SchemaPlace }) => compileValidators(plan, locateModel) } : {}),
    });
    for (const [name, source] of models.files) files.set(name, source);
    modelReexports = models.entryReexports;
    modelDiagnostics.push(...models.diagnostics);
  }
  if (operationValidation && !validators.compiled) compileValidators(undefined);
  if (validators.compiled) {
    modelDiagnostics.push(...validators.compiled.diagnostics);
    // A source is empty when the compile reported an error; no file is written then.
    if (validators.compiled.source !== '' && validators.compiled.exports.size > 0) files.set('validators.generated.ts', validators.compiled.source);
  }
  files.set('model-manifest.json', stableJson(generateModelManifest(document, profile, modelAnalysis)));
  if (plan.artifacts.has('client.ts')) {
    const clientModules = generateClientModules(
      clientName,
      operations,
      document,
      profile,
      plan,
      operationValidation && validators.compiled
        ? { schemas: operationValidation, validatorExports: validators.compiled.exports }
        : undefined,
    );
    files.set('client.ts', clientModules.client);
    for (const [name, source] of clientModules.operations) files.set(name, source);
  }
  if (plan.artifacts.has('inbound.ts')) {
    files.set('inbound.ts', generateInbound(clientName, inboundOperations));
  }
  if (plan.artifacts.has('links.ts')) {
    files.set('links.ts', generateLinks(operations));
  }
  files.set('index.ts', generateIndex(profile, plan, modelReexports));
  assertUniquePublicExports(files);
  assertPortableFilenames(files.keys());
  return { files, output, clientName, operations, inboundOperations, diagnostics: uniqueDiagnostics([...ir.diagnostics, ...browserCookieDiagnostics(document, operations), ...modelAnalysis.diagnostics, ...inlineDiagnostics, ...modelDiagnostics]) };
}

/**
 * Compatibility helper for callers that already hold a validated document.
 * Generation is intentionally pure: the caller owns filesystem writes.
 */
export function writeSdk(document: unknown, options: WriteSdkOptions): WriteSdkResult {
  const generated = generatedFiles(document, options);
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
