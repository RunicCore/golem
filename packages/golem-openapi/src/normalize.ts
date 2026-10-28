import { asRecord, isJsonObject, objectEntries, readBoolean, readString, type JsonObject } from './json.js';
import { GolemDiagnosticSeverity, identifier, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { inboundOperationName, operationName } from './names.js';

const HTTP_METHODS_31 = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export const HTTP_METHODS_32 = [...HTTP_METHODS_31, 'query'] as const;

const VERSION_ADAPTERS = {
  '3.1': {
    featureLine: '3.1',
    schemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    methods: HTTP_METHODS_31,
    additionalOperations: false,
  },
  '3.2': {
    featureLine: '3.2',
    schemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    methods: HTTP_METHODS_32,
    additionalOperations: true,
  },
} as const;

type OpenApiFeatureLine = keyof typeof VERSION_ADAPTERS;
export type OpenApiSchema = boolean | JsonObject;

export interface OpenApiMediaType {
  readonly contentType: string;
  readonly schema: OpenApiSchema | null;
  readonly itemSchema: OpenApiSchema | null;
  readonly itemSchemaPresent: boolean;
  readonly encoding: JsonObject;
  readonly prefixEncoding: readonly unknown[];
  readonly itemEncoding: unknown;
}

export interface NormalizedParameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: OpenApiSchema;
  readonly content?: JsonObject;
  readonly style?: string;
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly [key: string]: unknown;
}

export interface NormalizedResponse {
  readonly status: string;
  readonly description: string;
  readonly headers: JsonObject;
  readonly links: JsonObject;
  readonly content: readonly OpenApiMediaType[];
  readonly schema: OpenApiSchema | null;
  readonly success: boolean;
}

export interface NormalizedOperation {
  readonly name: string;
  readonly typeName: string;
  readonly method: string;
  readonly route: string;
  readonly sourceKind: string;
  readonly sourceName: string;
  readonly parameters: readonly NormalizedParameter[];
  readonly requestBody: JsonObject | undefined;
  readonly requestContent: readonly OpenApiMediaType[];
  readonly responses: readonly NormalizedResponse[];
  readonly responseSchema: OpenApiSchema | null;
  readonly security: readonly JsonObject[];
  readonly callbacks: JsonObject;
  readonly servers: readonly unknown[];
}

export interface NormalizedDocument {
  readonly openapi: string;
  readonly featureLine: OpenApiFeatureLine;
  readonly schemaDialect: string;
  readonly operations: readonly NormalizedOperation[];
  readonly inboundOperations: readonly NormalizedOperation[];
  readonly schemas: JsonObject;
  readonly securitySchemes: JsonObject;
  readonly webhooks: JsonObject;
  /** Deterministic renames the allocator applied to generated operation names. */
  readonly diagnostics: readonly GolemDiagnostic[];
}

export function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolveLocalPointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').map(decodePointerToken)
    .reduce<unknown>((value, key) => (isJsonObject(value) ? value[key] : undefined), document);
}

export function resolveLocal(document: unknown, value: unknown): unknown {
  if (!isJsonObject(value) || typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) {
    return value;
  }
  return resolveLocalPointer(document, value.$ref) ?? value;
}

function contentEntries(content: unknown, featureLine?: OpenApiFeatureLine): OpenApiMediaType[] {
  return objectEntries(content).map(([contentType, media]) => {
    const mediaObject = asRecord(media);
    const itemSchemaPresent = Object.prototype.hasOwnProperty.call(mediaObject, 'itemSchema')
      && (typeof mediaObject.itemSchema === 'boolean' || isJsonObject(mediaObject.itemSchema));
    if (itemSchemaPresent && featureLine !== undefined && featureLine !== '3.2') {
      throw new Error(`itemSchema is only supported in OpenAPI 3.2 (found ${featureLine} in ${contentType})`);
    }
    return {
      contentType,
      schema: 'schema' in mediaObject ? schemaValue(mediaObject.schema) : null,
      itemSchema: itemSchemaPresent ? schemaValue(mediaObject.itemSchema) : null,
      itemSchemaPresent,
      encoding: asRecord(mediaObject.encoding),
      prefixEncoding: Array.isArray(mediaObject.prefixEncoding) ? mediaObject.prefixEncoding : [],
      itemEncoding: mediaObject.itemEncoding ?? null,
    };
  });
}

function schemaValue(value: unknown): OpenApiSchema | null {
  if (typeof value === 'boolean') return value;
  if (isJsonObject(value)) return value;
  return null;
}

function preferredSchema(content: unknown): OpenApiSchema | null {
  if (!isJsonObject(content)) return null;
  const preferred = content['application/json'] ?? content['application/problem+json'];
  if (isJsonObject(preferred) && 'schema' in preferred) return schemaValue(preferred.schema);
  const first = Object.values(content)[0];
  return isJsonObject(first) && 'schema' in first ? schemaValue(first.schema) : null;
}

export function parameterSchema(parameter: unknown): OpenApiSchema | null {
  const record = asRecord(parameter);
  if ('schema' in record) return schemaValue(record.schema);
  return preferredSchema(record.content);
}

function parameterKey(parameter: NormalizedParameter): string {
  // A header name is case-insensitive (RFC 9110); every other location is case-sensitive.
  return `${parameter.in}\0${parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name}`;
}

function asParameter(value: unknown, origin: string): NormalizedParameter {
  const record = asRecord(value);
  const name = readString(record.name);
  const location = readString(record.in);
  if (!name || !location) {
    throw new Error(`${origin} is missing parameter name or in`);
  }
  return {
    ...record,
    name,
    in: location,
    required: readBoolean(record.required),
    // Keep the distinction between an absent schema and an explicitly supplied
    // schema.  Parameter Objects may use either `schema` or `content`; adding a
    // schema property with an `undefined` value makes `parameterSchema` stop at
    // the former and silently discard the latter.  Boolean schemas are valid on
    // OAS 3.1/3.2, so preserve `false` instead of using a truthiness check.
    ...('schema' in record ? { schema: schemaValue(record.schema) ?? undefined } : {}),
    content: isJsonObject(record.content) ? record.content : undefined,
    style: readString(record.style),
    explode: readBoolean(record.explode),
    allowReserved: readBoolean(record.allowReserved),
  };
}

function uniqueParameters(parameters: readonly unknown[], origin: string): NormalizedParameter[] {
  const seen = new Map<string, string>();
  const result: NormalizedParameter[] = [];
  for (const [index, raw] of parameters.entries()) {
    const parameter = asParameter(raw, `${origin}[${index}]`);
    const key = parameterKey(parameter);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `duplicate parameter ${JSON.stringify(parameter.name)} in ${JSON.stringify(parameter.in)} at ${origin}: ${previous} and ${origin}[${index}]`,
      );
    }
    seen.set(key, `${origin}[${index}]`);
    result.push(parameter);
  }
  return result;
}

function resolveParameterList(
  document: unknown,
  parameters: readonly unknown[],
  origin: string,
): NormalizedParameter[] {
  return uniqueParameters(
    parameters.map((raw) => resolveLocal(document, raw)),
    origin,
  );
}

function mergeParameters(
  document: unknown,
  pathItemParameters: readonly unknown[],
  operationParameters: readonly unknown[],
  pathOrigin: string,
  operationOrigin: string,
): NormalizedParameter[] {
  const pathParameters = resolveParameterList(document, pathItemParameters, pathOrigin);
  const operationLevel = resolveParameterList(document, operationParameters, operationOrigin);
  const merged = new Map<string, NormalizedParameter>();
  for (const parameter of pathParameters) merged.set(parameterKey(parameter), parameter);
  for (const parameter of operationLevel) merged.set(parameterKey(parameter), parameter);
  return [...merged.values()];
}

function normalizeResponses(document: unknown, responses: unknown): NormalizedResponse[] {
  return objectEntries(responses).map(([status, rawResponse]) => {
    const response = asRecord(resolveLocal(document, rawResponse));
    const links = Object.fromEntries(
      objectEntries(response.links).map(([name, link]) => [name, asRecord(resolveLocal(document, link))]),
    );
    return {
      status,
      description: readString(response.description) ?? '',
      headers: asRecord(response.headers),
      links,
      content: contentEntries(response.content, featureLineOf(asRecord(document).openapi)),
      schema: preferredSchema(response.content),
      success: /^2\d\d$/.test(status) || /^2XX$/i.test(status),
    };
  });
}

function asSecurityRequirements(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item));
}

function normalizeOperation(
  document: unknown,
  pathItem: JsonObject,
  operation: JsonObject,
  method: string,
  route: string,
  name: string,
  sourceKind = 'path',
  sourceName = route,
  wireMethod = method.toUpperCase(),
): NormalizedOperation {
  const featureLine = featureLineOf(asRecord(document).openapi);
  const parameters = mergeParameters(
    document,
    Array.isArray(pathItem.parameters) ? pathItem.parameters : [],
    Array.isArray(operation.parameters) ? operation.parameters : [],
    `${sourceKind} ${sourceName} parameters`,
    `operation ${name} parameters`,
  );
  const requestBodyValue = resolveLocal(document, operation.requestBody);
  const requestBody = isJsonObject(requestBodyValue) ? requestBodyValue : undefined;
  const responses = normalizeResponses(document, operation.responses);
  const documentRecord = asRecord(document);
  const security = operation.security === undefined
    ? asSecurityRequirements(documentRecord.security)
    : asSecurityRequirements(operation.security);
  return {
    name,
    typeName: identifier(name),
    method: wireMethod,
    route,
    sourceKind,
    sourceName,
    parameters,
    requestBody,
    requestContent: contentEntries(requestBody?.content, featureLine),
    responses,
    responseSchema: responses.find((response) => response.success)?.schema ?? null,
    security,
    callbacks: asRecord(operation.callbacks),
    // An empty `servers` list counts as not given.
    servers: [operation.servers, pathItem.servers, documentRecord.servers].filter(Array.isArray).find((list) => list.length > 0) ?? [],
  };
}

/** Generated operation names claimed so far, with the source that claimed each. */
type OperationNames = Map<string, string>;

function reserveName(names: OperationNames, requested: string, source: string, allocatedFrom = requested): string {
  const previous = names.get(requested);
  if (previous !== undefined) {
    const origin = allocatedFrom === requested ? '' : ` (allocated from ${JSON.stringify(allocatedFrom)})`;
    throw new Error(`duplicate generated operation name "${requested}" for ${source}${origin}; ${previous} already uses it`);
  }
  names.set(requested, allocatedFrom === requested ? source : `${source} (allocated from ${JSON.stringify(allocatedFrom)})`);
  return requested;
}

function reserveOperationName(
  names: OperationNames,
  allocated: { readonly name: string; readonly requested: string },
  diagnostics: GolemDiagnostic[],
  source: string,
): string {
  const name = reserveName(names, allocated.name, source, allocated.requested);
  if (allocated.requested !== name) {
    diagnostics.push({
      code: 'OPENAPI_OPERATION_RENAMED',
      severity: GolemDiagnosticSeverity.Warning,
      message: `operation ${source} name ${JSON.stringify(allocated.requested)} is reserved; generated as ${JSON.stringify(name)}`,
    });
  }
  return name;
}

/** Effective JSON Schema `type` list shared by TypeScript, model and runtime schema emission. */
export function effectiveSchemaTypes(schema: { readonly type?: unknown }): string[] {
  return Array.isArray(schema.type) ? schema.type.map(String) : schema.type ? [String(schema.type)] : [];
}

function featureLineOf(openapi: unknown): OpenApiFeatureLine {
  const featureLine = String(openapi).split('.').slice(0, 2).join('.');
  if (featureLine === '3.1' || featureLine === '3.2') return featureLine;
  throw new Error(`no version adapter for OpenAPI ${String(openapi)}`);
}

export function collectOperations(document: unknown): readonly NormalizedOperation[] {
  return normalizeDocument(document).operations;
}

function assertParameterStyles(
  document: unknown,
  operations: readonly NormalizedOperation[],
  featureLine: OpenApiFeatureLine,
): void {
  for (const operation of operations) {
    for (const parameter of operation.parameters) {
      if (parameter.style === 'cookie' && (parameter.in !== 'cookie' || featureLine !== '3.2')) {
        throw new Error(
          `style "cookie" is only valid for cookie parameters in OpenAPI 3.2 (${operation.name} ${parameter.in} ${JSON.stringify(parameter.name)})`,
        );
      }
    }
    for (const response of operation.responses) {
      for (const [name, rawHeader] of objectEntries(response.headers)) {
        const header = asRecord(resolveLocal(document, rawHeader));
        if (readString(header.style) === 'cookie') {
          throw new Error(
            `style "cookie" is not valid for response header ${JSON.stringify(name)} on ${operation.name}`,
          );
        }
      }
    }
  }
}

/** The operations of a path item, named by their lowercase method; the standard methods first, then the OpenAPI 3.2 additional ones. */
function* pathItemOperations(
  document: unknown,
  pathItem: JsonObject,
  adapter: (typeof VERSION_ADAPTERS)[OpenApiFeatureLine],
): Generator<{ method: string; wireMethod: string; operation: JsonObject }> {
  for (const method of adapter.methods) {
    if (pathItem[method] === undefined) continue;
    yield { method, wireMethod: method.toUpperCase(), operation: asRecord(resolveLocal(document, pathItem[method])) };
  }
  if (adapter.additionalOperations) {
    for (const [wireMethod, rawOperation] of objectEntries(pathItem.additionalOperations)) {
      yield { method: wireMethod, wireMethod, operation: asRecord(resolveLocal(document, rawOperation)) };
    }
  }
}

export function normalizeDocument(document: unknown): NormalizedDocument {
  const root = asRecord(document);
  const featureLine = featureLineOf(root.openapi);
  const adapter = VERSION_ADAPTERS[featureLine];
  const names: OperationNames = new Map();
  const diagnostics: GolemDiagnostic[] = [];
  const operations: NormalizedOperation[] = [];
  for (const [route, rawPathItem] of objectEntries(root.paths)) {
    const pathItem = asRecord(resolveLocal(document, rawPathItem));
    for (const { method, wireMethod, operation } of pathItemOperations(document, pathItem, adapter)) {
      const name = reserveOperationName(names, operationName(operation, method, route), diagnostics, `${wireMethod} ${route}`);
      operations.push(normalizeOperation(document, pathItem, operation, method, route, name, 'path', route, wireMethod));
    }
  }

  const inboundOperations: NormalizedOperation[] = [];
  for (const [webhookName, rawPathItem] of objectEntries(root.webhooks)) {
    const pathItem = asRecord(resolveLocal(document, rawPathItem));
    for (const { method, wireMethod, operation } of pathItemOperations(document, pathItem, adapter)) {
      const name = reserveName(
        names,
        inboundOperationName('webhook', webhookName, operation, method, webhookName),
        `webhook ${webhookName} ${wireMethod}`,
      );
      inboundOperations.push(
        normalizeOperation(document, pathItem, operation, method, webhookName, name, 'webhook', webhookName, wireMethod),
      );
    }
  }

  for (const parentOperation of operations) {
    for (const [callbackName, rawCallback] of objectEntries(parentOperation.callbacks)) {
      const callback = asRecord(resolveLocal(document, rawCallback));
      for (const [expression, rawPathItem] of objectEntries(callback)) {
        const pathItem = asRecord(resolveLocal(document, rawPathItem));
        for (const { method, wireMethod, operation } of pathItemOperations(document, pathItem, adapter)) {
          const sourceName = `${parentOperation.name} ${callbackName}`;
          const name = reserveName(
            names,
            inboundOperationName('callback', sourceName, operation, method, expression),
            `callback ${sourceName} ${wireMethod} ${expression}`,
          );
          inboundOperations.push(
            normalizeOperation(document, pathItem, operation, method, expression, name, 'callback', sourceName, wireMethod),
          );
        }
      }
    }
  }

  const components = asRecord(root.components);
  const normalized = Object.freeze({
    openapi: String(root.openapi),
    featureLine: adapter.featureLine,
    schemaDialect: readString(root.jsonSchemaDialect) ?? adapter.schemaDialect,
    operations,
    inboundOperations,
    schemas: asRecord(components.schemas),
    securitySchemes: asRecord(components.securitySchemes),
    webhooks: asRecord(root.webhooks),
    diagnostics: Object.freeze(diagnostics),
  });
  assertParameterStyles(document, [...operations, ...inboundOperations], adapter.featureLine);
  return normalized;
}
