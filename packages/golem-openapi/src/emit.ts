import path from 'node:path';
import type { GolemArtifact, GolemDiagnostic, GolemResult } from '@exprtlabs/golem/generator-api';
import { isRecord } from '@exprtlabs/golem/generator-api';
import { stableJson } from '@exprtlabs/golem/manifest';
import { generateClientModules } from './client/emit.js';
import { browserCookieDiagnostics, normalizeAndValidate, unsupportedHttpAuthSchemes } from './document.js';
import { buildEmissionPlan, type ArtifactFile, type EmissionPlan } from './emission-plan.js';
import { asRecord, readString } from './json.js';
import { assertPortableFilenames, assertUniquePublicExports, identifier } from '@exprtlabs/golem/generator-api';
import { operationName, operationNameType } from './names.js';
import type { NormalizedOperation } from './normalize.js';
import { generatedBanner } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  analyzeOpenApiModels,
  generateModelManifest,
  generateOpenApiModelArtifacts,
  type OpenApiDates,
} from './models.js';
import { withOrigins, type OriginLocator } from './origin.js';
import { buildSchemaData } from './schemas.js';
import { generateDirectionalSchemas, generateTypes } from './types.js';

export interface OpenApiArtifact extends GolemArtifact {}

export interface WriteSdkResult extends GolemResult {}

export interface WriteSdkOptions {
  readonly output: string;
  readonly name?: string;
  readonly profile: OpenApiGenerationProfile;
  /** `temporal` maps date formats to Temporal types; the default keeps `Date`. */
  readonly dates?: OpenApiDates;
  /** Names where a bundled component came from; generator errors that name one append it. */
  readonly locate?: OriginLocator;
}

export function generateLinks(operations: readonly NormalizedOperation[]): string {
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
  return `${generatedBanner()}
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
export const responseLinks = ${JSON.stringify(links, null, 2)} as const satisfies Partial<ResponseLinkRegistry>;
`;
}

export function generateIndex(profile: OpenApiGenerationProfile, plan?: EmissionPlan, modelReexports = ''): string {
  requireProfile(profile);
  const artifacts = plan?.artifacts;
  const include = (name: ArtifactFile): boolean => artifacts ? artifacts.has(name) : true;
  return `${generatedBanner()}
export * from './types.js';
${include('input-schemas.ts') ? "export type * as InputSchemas from './input-schemas.js';" : ''}
${include('output-schemas.ts') ? "export type * as OutputSchemas from './output-schemas.js';" : ''}
${modelReexports}
${include('client.ts') ? "export * from './client.js';" : ''}
${include('inbound.ts') ? "export * from './inbound.js';" : ''}
${include('links.ts') ? "export * from './links.js';" : ''}
`;
}

export function generateInbound(clientName: string, operations: readonly NormalizedOperation[]): string {
  const methods = operations.map((operation) =>
    `  /** ${operation.sourceKind} ${operation.sourceName}: ${operation.method} ${operation.route} */\n` +
    `  ${operation.name}(input: Types.${operation.typeName}OperationInput): Promise<Types.${operation.typeName}OperationHttpResponse>;`
  ).join('\n\n');
  return `${generatedBanner()}
import type * as Types from './types.js';

/**
 * Application-owned handlers for inbound OpenAPI callbacks and webhooks.
 * This contract intentionally does not choose an HTTP server framework.
 */
export interface ${clientName}InboundPort {
${methods}
}
`;
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
  let modelReexports = '';
  if (plan.hasModels) {
    const models = generateOpenApiModelArtifacts(document, profile, modelAnalysis, {
      copyAdditionalProperties: plan.copyAdditionalProperties,
      objectFromJSON: plan.objectFromJSON,
    });
    for (const [name, source] of models.files) files.set(name, source);
    modelReexports = models.entryReexports;
  }
  files.set('model-manifest.json', stableJson(generateModelManifest(document, profile, modelAnalysis)));
  if (plan.artifacts.has('client.ts')) {
    const clientModules = generateClientModules(clientName, operations, document, profile, plan, schemaData);
    files.set('client.ts', clientModules.client);
    for (const [name, source] of clientModules.operations) files.set(name, source);
    for (const [name, source] of clientModules.sharedSchemas) files.set(name, source);
    for (const [name, compiled] of clientModules.standaloneValidators) {
      files.set(name, compiled.source);
      files.set(`${name.slice(0, -3)}.d.ts`, compiled.declarations);
      files.set(`${name.slice(0, -3)}.NOTICES.txt`, compiled.notices);
    }
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
  return { files, output, clientName, operations, inboundOperations, diagnostics: [...ir.diagnostics, ...browserCookieDiagnostics(document, operations), ...modelAnalysis.diagnostics] };
}

/**
 * Compatibility helper for callers that already hold a validated document.
 * Generation is intentionally pure: the caller owns filesystem writes.
 */
export function writeSdk(document: unknown, options: WriteSdkOptions): WriteSdkResult {
  const generated = generatedFiles(document, options);
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
