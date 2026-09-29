import path from 'node:path';
import type { CodegenArtifact, CodegenDiagnostic, CodegenResult } from '@exprtlabs/codegen/generator-api';
import { isRecord } from '@exprtlabs/codegen/generator-api';
import { stableJson } from '@exprtlabs/codegen/manifest';
import { compileStandaloneValidators } from '@exprtlabs/codegen/ajv-tooling';
import { generateClientModules } from './client/emit.js';
import { browserCookieDiagnostics, normalizeAndValidate, unsupportedHttpAuthSchemes } from './document.js';
import { buildEmissionPlan, type ArtifactFile, type EmissionPlan } from './emission-plan.js';
import { asRecord, readString } from './json.js';
import { assertPortableFilenames, assertUniquePublicExports, identifier } from '@exprtlabs/codegen/generator-api';
import { operationName } from './names.js';
import type { NormalizedOperation } from './normalize.js';
import { generatedBanner } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import { emitCodecDeclarationTable } from '@exprtlabs/codegen/schema-graph';
import {
  analyzeOpenApiModels,
  generateModelManifest,
  generateOpenApiModelArtifacts,
  collectOpenApiCodecEntries,
} from './models.js';
import { buildSchemaData, generateSchemas } from './schemas.js';
import { generateDirectionalSchemas, generateTypes } from './types.js';

export interface OpenApiArtifact extends CodegenArtifact {}

export interface WriteSdkResult extends CodegenResult {}

export interface WriteSdkOptions {
  readonly output: string;
  readonly name?: string;
  readonly profile: OpenApiGenerationProfile;
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
import type { OperationName } from './schemas.js';

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
${modelReexports ? `${modelReexports}\nexport * from './iobject-plugin-keys.js';` : ''}
${include('client.ts') ? "export * from './client.js';" : ''}
${include('inbound.ts') ? "export * from './inbound.js';" : ''}
${include('links.ts') ? "export * from './links.js';" : ''}
${include('schemas.ts') ? "export * from './schemas.js';" : ''}
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

export function generatedFiles(document: unknown, options: WriteSdkOptions): {
  files: Map<string, string>;
  output: string;
  clientName: string;
  operations: readonly NormalizedOperation[];
  inboundOperations: readonly NormalizedOperation[];
  diagnostics: readonly CodegenDiagnostic[];
} {
  const profile = requireProfile(options.profile);
  const ir = normalizeAndValidate(document);
  unsupportedHttpAuthSchemes(document);
  const operations = ir.operations;
  const inboundOperations = ir.inboundOperations;
  const clientName = identifier(options.name || readString(asRecord(asRecord(document).info).title), 'Api');
  const output = path.resolve(options.output);
  const plan = buildEmissionPlan(document, ir, profile);
  const modelAnalysis = analyzeOpenApiModels(document, profile.validation);
  const schemaData = plan.artifacts.has('schemas.ts')
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
    const codecEntries = collectOpenApiCodecEntries(document, modelAnalysis);
    files.set('iobject-plugin-keys.ts', emitCodecDeclarationTable(codecEntries, '@exprtlabs/openapi-to-ts'));
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
  if (plan.artifacts.has('schemas.ts')) {
    files.set('schemas.ts', generateSchemas(document, profile, schemaData));
  }
  if (profile.ajvStandalone && profile.validation && plan.artifacts.has('schemas.ts')) {
    const data = schemaData ?? buildSchemaData(document, ir);
    const rootId = String(data.registry.$id);
    if (!isRecord(data.normalizedRegistry)) throw new Error('Generated schema registry must be an object.');
    const schemas: Record<string, object | boolean> = { [rootId]: data.normalizedRegistry };
    for (const resource of Object.values(isRecord(data.normalizedRegistry.$defs) ? data.normalizedRegistry.$defs : {})) {
      if (isRecord(resource) && typeof resource.$id === 'string') schemas[resource.$id] = resource;
    }
    const token = (value: string) => encodeURIComponent(value.replace(/~/g, '~0').replace(/\//g, '~1'));
    const references = [rootId, ...Object.keys(schemas),
      ...data.schemaNames.map(name => `${rootId}#/components/schemas/${token(name)}`),
      ...data.operationNames.map(name => `${rootId}#/operations/${token(name)}/input`),
      ...data.responseSchemaEntries.map(([name, status, media]) => `${rootId}#/operations/${token(name)}/responses/${token(status)}/${token(media)}`),
    ];
    // Nested resources are already registered when Ajv sees the root schema.
    const compiled = compileStandaloneValidators({ schemas: { [rootId]: data.normalizedRegistry }, references, owner: '@exprtlabs/openapi-to-ts' });
    files.set('validators.generated.js', compiled.code);
    files.set('validators.generated.d.ts', compiled.declarations);
    files.set('validators.generated.NOTICES.txt', compiled.notices);
    files.set('validation-engine.ts', `${generatedBanner()}\nimport { configureModelValidationEngine, createStaticValidationEngine } from '@exprtlabs/codegen/validation';\nimport { createValidators } from './validators.generated.js';\nimport { runtimeSchemaRegistry, schemaRegistry } from './schemas.js';\nexport const defaultValidationEngine = createStaticValidationEngine(createValidators(), { [schemaRegistry.$id]: runtimeSchemaRegistry });\nconfigureModelValidationEngine(runtimeSchemaRegistry, schemaRegistry.$id, defaultValidationEngine);\n`);
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
