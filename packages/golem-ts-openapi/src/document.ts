import * as path from 'node:path';
import { stableValue } from '@exprtlabs/golem/generator-api';
import YAML from 'yaml';
import { GolemDiagnosticSeverity, TsToOpenApiDiagnosticCode, TsToOpenApiError } from './diagnostics.js';
import {
  collectOperations,
  type OperationBuildContext,
  type SchemaResolver,
} from './operations.js';
import type { ControllerRoute } from './nest/types.js';

interface OpenApiDocumentContext extends OperationBuildContext {
  readonly openapiVersion?: '3.2.0' | '3.1.2';
  readonly info: Readonly<Record<string, unknown>>;
  readonly servers?: readonly Readonly<Record<string, unknown>>[];
  readonly securitySchemes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly tags?: readonly Readonly<Record<string, unknown>>[];
  readonly routes: readonly ControllerRoute[];
  readonly schemaResolver?: SchemaResolver;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TsToOpenApiError({
      severity: GolemDiagnosticSeverity.Error,
      code: TsToOpenApiDiagnosticCode.InvalidInfo,
      message: `OpenAPI info.${field} must be a non-empty string.`,
    });
  }
  return value;
}

type DocumentRecord = Record<string, unknown>;

function invalidDocument(
  code: TsToOpenApiDiagnosticCode,
  message: string,
): never {
  throw new TsToOpenApiError({
    severity: GolemDiagnosticSeverity.Error,
    code,
    message,
  });
}

function recordValue(
  value: unknown,
  pathName: string,
  code: TsToOpenApiDiagnosticCode,
): DocumentRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidDocument(code, `OpenAPI ${pathName} must be an object.`);
  }
  return value as DocumentRecord;
}

function nonEmptyDocumentString(
  value: unknown,
  pathName: string,
  code: TsToOpenApiDiagnosticCode,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalidDocument(code, `OpenAPI ${pathName} must be a non-empty string.`);
  }
  return value;
}

function documentString(
  value: unknown,
  pathName: string,
  code: TsToOpenApiDiagnosticCode,
): string {
  if (typeof value !== 'string') {
    invalidDocument(code, `OpenAPI ${pathName} must be a string.`);
  }
  return value;
}

function own(record: DocumentRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateKnownKeys(
  record: DocumentRecord,
  pathName: string,
  allowed: readonly string[],
  code: TsToOpenApiDiagnosticCode,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!accepted.has(key) && !key.startsWith('x-')) {
      invalidDocument(code, `OpenAPI ${pathName} contains unsupported property "${key}".`);
    }
  }
}

function validateServers(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    invalidDocument(TsToOpenApiDiagnosticCode.InvalidServer, 'OpenAPI servers must be an array.');
  }
  for (const [index, rawServer] of value.entries()) {
    const pathName = `servers[${index}]`;
    const server = recordValue(rawServer, pathName, TsToOpenApiDiagnosticCode.InvalidServer);
    validateKnownKeys(server, pathName, ['url', 'description', 'variables'], TsToOpenApiDiagnosticCode.InvalidServer);
    nonEmptyDocumentString(server.url, `${pathName}.url`, TsToOpenApiDiagnosticCode.InvalidServer);
    if (server.description !== undefined) {
      documentString(server.description, `${pathName}.description`, TsToOpenApiDiagnosticCode.InvalidServer);
    }
    if (server.variables === undefined) continue;
    const variables = recordValue(server.variables, `${pathName}.variables`, TsToOpenApiDiagnosticCode.InvalidServer);
    for (const [name, rawVariable] of Object.entries(variables)) {
      const variablePath = `${pathName}.variables.${name}`;
      const variable = recordValue(rawVariable, variablePath, TsToOpenApiDiagnosticCode.InvalidServer);
      validateKnownKeys(variable, variablePath, ['enum', 'default', 'description'], TsToOpenApiDiagnosticCode.InvalidServer);
      if (!own(variable, 'default') || typeof variable.default !== 'string') {
        invalidDocument(TsToOpenApiDiagnosticCode.InvalidServer, `OpenAPI ${variablePath}.default must be a string.`);
      }
      if (variable.enum !== undefined) {
        if (!Array.isArray(variable.enum) || variable.enum.some(item => typeof item !== 'string')) {
          invalidDocument(TsToOpenApiDiagnosticCode.InvalidServer, `OpenAPI ${variablePath}.enum must be an array of strings.`);
        }
        if (!(variable.enum as readonly string[]).includes(variable.default as string)) {
          invalidDocument(TsToOpenApiDiagnosticCode.InvalidServer, `OpenAPI ${variablePath}.default must be included in enum.`);
        }
      }
      if (variable.description !== undefined) {
        documentString(variable.description, `${variablePath}.description`, TsToOpenApiDiagnosticCode.InvalidServer);
      }
    }
  }
}

function validateReferenceObject(value: DocumentRecord, pathName: string): void {
  validateKnownKeys(value, pathName, ['$ref', 'summary', 'description'], TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  nonEmptyDocumentString(value.$ref, `${pathName}.$ref`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  if (value.summary !== undefined) documentString(value.summary, `${pathName}.summary`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  if (value.description !== undefined) documentString(value.description, `${pathName}.description`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
}

function validateScopes(value: unknown, pathName: string): void {
  const scopes = recordValue(value, pathName, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  for (const [name, description] of Object.entries(scopes)) {
    if (name.trim() === '') {
      invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName} contains an empty scope name.`);
    }
    documentString(description, `${pathName}.${name}`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  }
}

function validateOAuthFlow(
  value: unknown,
  pathName: string,
  flowName: string,
  openapi: '3.2.0' | '3.1.2',
): void {
  const flow = recordValue(value, pathName, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  const allowed = ['authorizationUrl', 'tokenUrl', 'refreshUrl', 'scopes'];
  if (openapi === '3.2.0' && flowName === 'deviceAuthorization') {
    allowed.push('deviceAuthorizationUrl');
  }
  validateKnownKeys(flow, pathName, allowed, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  const requires = flowName === 'implicit'
    ? ['authorizationUrl']
    : flowName === 'password' || flowName === 'clientCredentials'
      ? ['tokenUrl']
      : flowName === 'authorizationCode'
        ? ['authorizationUrl', 'tokenUrl']
        : ['deviceAuthorizationUrl', 'tokenUrl'];
  for (const key of requires) {
    nonEmptyDocumentString(flow[key], `${pathName}.${key}`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  }
  if (flow.refreshUrl !== undefined) {
    nonEmptyDocumentString(flow.refreshUrl, `${pathName}.refreshUrl`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  }
  if (!own(flow, 'scopes')) {
    invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName}.scopes must be an object.`);
  }
  validateScopes(flow.scopes, `${pathName}.scopes`);
}

function validateOAuthFlows(
  value: unknown,
  pathName: string,
  openapi: '3.2.0' | '3.1.2',
): void {
  const flows = recordValue(value, pathName, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  const names = ['implicit', 'password', 'clientCredentials', 'authorizationCode'];
  if (openapi === '3.2.0') names.push('deviceAuthorization');
  validateKnownKeys(flows, pathName, names, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  let found = false;
  for (const name of names) {
    if (flows[name] === undefined) continue;
    found = true;
    validateOAuthFlow(flows[name], `${pathName}.${name}`, name, openapi);
  }
  if (!found) {
    invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName} must define at least one OAuth flow.`);
  }
}

function validateSecurityScheme(
  value: unknown,
  pathName: string,
  openapi: '3.2.0' | '3.1.2',
): void {
  const scheme = recordValue(value, pathName, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  if (scheme.$ref !== undefined) {
    validateReferenceObject(scheme, pathName);
    return;
  }
  const type = nonEmptyDocumentString(scheme.type, `${pathName}.type`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  if (!['apiKey', 'http', 'mutualTLS', 'oauth2', 'openIdConnect'].includes(type)) {
    invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName}.type "${type}" is not a supported security scheme type.`);
  }
  if (scheme.description !== undefined) {
    documentString(scheme.description, `${pathName}.description`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  }
  if (type === 'apiKey') {
    validateKnownKeys(scheme, pathName, ['type', 'description', 'name', 'in'], TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    nonEmptyDocumentString(scheme.name, `${pathName}.name`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    if (!['query', 'header', 'cookie'].includes(scheme.in as string)) {
      invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName}.in must be query, header, or cookie.`);
    }
    return;
  }
  if (type === 'http') {
    validateKnownKeys(scheme, pathName, ['type', 'description', 'scheme', 'bearerFormat'], TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    nonEmptyDocumentString(scheme.scheme, `${pathName}.scheme`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    if (scheme.bearerFormat !== undefined) documentString(scheme.bearerFormat, `${pathName}.bearerFormat`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    return;
  }
  if (type === 'mutualTLS') {
    validateKnownKeys(scheme, pathName, ['type', 'description'], TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    return;
  }
  if (type === 'openIdConnect') {
    validateKnownKeys(scheme, pathName, ['type', 'description', 'openIdConnectUrl'], TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    nonEmptyDocumentString(scheme.openIdConnectUrl, `${pathName}.openIdConnectUrl`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
    return;
  }
  const oauthAllowed = ['type', 'description', 'flows'];
  if (openapi === '3.2.0') oauthAllowed.push('oauth2MetadataUrl');
  validateKnownKeys(scheme, pathName, oauthAllowed, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  if (openapi === '3.2.0' && scheme.oauth2MetadataUrl !== undefined) {
    nonEmptyDocumentString(scheme.oauth2MetadataUrl, `${pathName}.oauth2MetadataUrl`, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  }
  if (!own(scheme, 'flows')) {
    invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName}.flows must be an object.`);
  }
  validateOAuthFlows(scheme.flows, `${pathName}.flows`, openapi);
}

function validateSecuritySchemes(
  value: unknown,
  openapi: '3.2.0' | '3.1.2',
  pathName = 'components.securitySchemes',
): ReadonlySet<string> {
  if (value === undefined) return new Set();
  const schemes = recordValue(value, pathName, TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  const names = new Set<string>();
  for (const [name, scheme] of Object.entries(schemes)) {
    if (name.trim() === '') {
      invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityScheme, `OpenAPI ${pathName} contains an empty scheme name.`);
    }
    validateSecurityScheme(scheme, `${pathName}.${name}`, openapi);
    names.add(name);
  }
  return names;
}

function validateSecurityRequirements(
  routes: readonly ControllerRoute[],
  schemeNames: ReadonlySet<string>,
): void {
  for (const route of routes) {
    if (!route.security) continue;
    for (const [index, requirement] of route.security.entries()) {
      if (requirement === null || typeof requirement !== 'object' || Array.isArray(requirement)) {
        invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityRequirement, `Operation ${route.operationId} security[${index}] must be an object.`);
      }
      for (const [name, scopes] of Object.entries(requirement)) {
        if (!schemeNames.has(name)) {
          invalidDocument(
            TsToOpenApiDiagnosticCode.InvalidSecurityRequirement,
            `Operation ${route.operationId} references security scheme "${name}", but no matching components.securitySchemes entry is configured.`,
          );
        }
        if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) {
          invalidDocument(TsToOpenApiDiagnosticCode.InvalidSecurityRequirement, `Operation ${route.operationId} security[${index}].${name} must be an array of strings.`);
        }
      }
    }
  }
}

export async function buildDocument(
  context: OpenApiDocumentContext,
): Promise<Readonly<Record<string, unknown>>> {
  const openapi = context.openapiVersion ?? '3.2.0';
  if (openapi !== '3.2.0' && openapi !== '3.1.2') {
    throw new TsToOpenApiError({
      severity: GolemDiagnosticSeverity.Error,
      code: TsToOpenApiDiagnosticCode.UnsupportedOpenApiVersion,
      message: `OpenAPI version ${openapi} is not supported; use 3.2.0 or 3.1.2.`,
    });
  }
  const infoRecord = recordValue(context.info, 'info', TsToOpenApiDiagnosticCode.InvalidInfo);
  const info = {
    ...infoRecord,
    title: requiredString(infoRecord.title, 'title'),
    version: requiredString(infoRecord.version, 'version'),
  };
  validateServers(context.servers);
  const configuredSecuritySchemes = context.securitySchemes === undefined
    ? undefined
    : recordValue(context.securitySchemes, 'securitySchemes', TsToOpenApiDiagnosticCode.InvalidSecurityScheme);
  const schemeNames = validateSecuritySchemes(configuredSecuritySchemes, openapi);
  validateSecurityRequirements(context.routes, schemeNames);
  const operations = await collectOperations(context.routes, context);
  const document: Record<string, unknown> = {
    openapi,
    'x-generator': '@exprtlabs/golem-ts-openapi',
    info,
    ...(context.servers && context.servers.length > 0 ? { servers: context.servers } : {}),
    ...(context.tags && context.tags.length > 0 ? { tags: context.tags } : {}),
    paths: operations.paths,
  };
  if (configuredSecuritySchemes && Object.keys(configuredSecuritySchemes).length > 0) {
    document.components = { securitySchemes: configuredSecuritySchemes };
  }
  return stableValue(document) as Readonly<Record<string, unknown>>;
}

function serializeDocument(
  document: Readonly<Record<string, unknown>>,
  format: 'json' | 'yaml' = 'json',
): string {
  const canonical = stableValue(document);
  if (format === 'yaml') return `${YAML.stringify(canonical, { sortMapEntries: false })}`;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function serializeForOutput(
  document: Readonly<Record<string, unknown>>,
  output: string,
): string {
  const extension = path.extname(output).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') {
    return `# Generated by @exprtlabs/golem-ts-openapi. Do not edit.\n${serializeDocument(document, 'yaml')}`;
  }
  return serializeDocument(document, 'json');
}
