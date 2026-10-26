import { isBinaryMediaType, isJsonSeqMediaType, isNdjsonMediaType, isServerSentEventsMediaType, mediaEssence } from './client/codecs.js';
import { asRecord, isJsonObject, objectEntries } from './json.js';
import { collectOpenApiModelDefinitions } from './models.js';
import {
  resolveLocal,
  parameterSchema,
  type NormalizedDocument,
  type NormalizedOperation,
  type NormalizedParameter,
  type OpenApiMediaType,
} from './normalize.js';
import type { OpenApiGenerationProfile } from './profile.js';
import {
  collectCanonicalResources,
  nextSchemaBase,
  resolveSchemaTarget,
  schemaDocumentBase,
  schemaTargetIdentity,
  type ResourceIndex,
} from './schema-projection.js';

const ALWAYS_ARTIFACTS = ['types.ts', 'index.ts', 'model-manifest.json'] as const;

export type ArtifactFile =
  | typeof ALWAYS_ARTIFACTS[number]
  | 'input-schemas.ts'
  | 'output-schemas.ts'
  | 'client.ts'
  | 'inbound.ts'
  | 'links.ts'
  | 'servers.ts';

type ClientHelperName =
  | 'constructor' | 'baseUrl' | 'fetchImpl' | 'defaultHeaders' | 'url'
  | 'matchesStatus' | 'selectResponse' | 'mediaRank' | 'httpResponse' | 'readResponse'
  | 'formValue' | 'encode' | 'entries' | 'serializePath' | 'serializeSimple' | 'serializeHeaderSimple'
  | 'appendQuery' | 'addQueryParameter' | 'addCookieParameter' | 'addCookieStyleParameter'
  | 'setQueryString' | 'serializeContentParameter' | 'encodeBody' | 'isEncodedBody'
  | 'decodeHeaderScalar' | 'decodeResponseHeader' | 'responseHeaders'
  | 'readNdjson' | 'readJsonSeq' | 'readServerSentEvents'
  | 'operationValidators' | 'validateOperationInput' | 'responseCheck'
  | 'auth' | 'authValue' | 'applySecurity' | 'applyAuthScheme' | 'securitySchemes' | 'mutualTls'
  | 'bodyEncoders' | 'responseDecoders' | 'parameterSerializers' | 'responseHeaderDecoders' | 'streamDecoders';

interface ClientSurfaces {
  readonly bodyEncoders: boolean;
  readonly responseDecoders: boolean;
  readonly parameterSerializers: boolean;
  readonly responseHeaderDecoders: boolean;
  readonly streamDecoders: boolean;
  readonly auth: boolean;
  readonly mutualTls: boolean;
}

interface StreamPlan {
  readonly ndjson: boolean;
  readonly jsonSeq: boolean;
  readonly sse: boolean;
  readonly custom: boolean;
}

/** A server of the document's `servers` list, with the fields that the client reads. */
export interface DocumentServer {
  readonly url: string;
  readonly description?: string;
  readonly name?: string;
  readonly variables?: Readonly<Record<string, { readonly default: string; readonly enum?: readonly string[] }>>;
}

export interface EmissionPlan {
  readonly profile: OpenApiGenerationProfile;
  readonly artifacts: ReadonlySet<ArtifactFile>;
  readonly servers: readonly DocumentServer[];
  readonly hasComponentSchemas: boolean;
  readonly hasModels: boolean;
  readonly hasOutboundOperations: boolean;
  readonly hasInboundOperations: boolean;
  readonly hasLinks: boolean;
  readonly typesUsesInputSchemas: boolean;
  readonly typesUsesOutputSchemas: boolean;
  readonly clientSurfaces: ClientSurfaces;
  readonly streams: StreamPlan;
  readonly helpers: ReadonlySet<ClientHelperName>;
  readonly referencedAuthSchemes: ReadonlyMap<string, unknown>;
  readonly hasRequestBodies: boolean;
  readonly hasResponseContent: boolean;
  readonly hasItemSchema: boolean;
  readonly hasParameterContent: boolean;
  readonly contentParameterLocations: ReadonlySet<string>;
  readonly hasResponseHeaderContent: boolean;
  readonly hasResponseHeaders: boolean;
  readonly hasPathParams: boolean;
  readonly hasQueryParams: boolean;
  readonly hasHeaderParams: boolean;
  readonly hasCookieParams: boolean;
  readonly hasCookieStyleCookie: boolean;
  readonly hasFormCookies: boolean;
  readonly hasQueryString: boolean;
  readonly hasFormBody: boolean;
  readonly hasMultipartBody: boolean;
}

const BASE_CLIENT_HELPERS = [
  'constructor',
  'baseUrl',
  'fetchImpl',
  'defaultHeaders',
  'url',
  'matchesStatus',
  'selectResponse',
  'mediaRank',
  'httpResponse',
  'readResponse',
] as const;

function mediaList(operations: readonly NormalizedOperation[]): OpenApiMediaType[] {
  return operations.flatMap((operation) => [
    ...operation.requestContent,
    ...operation.responses.flatMap((response) => [...response.content]),
  ]);
}

function documentServers(document: unknown): readonly DocumentServer[] {
  const servers = asRecord(document).servers;
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((server): DocumentServer[] => {
    const { url, description, name, variables } = asRecord(server);
    if (typeof url !== 'string') return [];
    const declared = objectEntries(variables).flatMap(([variable, entry]) => {
      const { default: fallback, enum: values } = asRecord(entry);
      return typeof fallback === 'string'
        ? [[variable, { default: fallback, ...(Array.isArray(values) ? { enum: values.filter((value) => typeof value === 'string') } : {}) }] as const]
        : [];
    });
    return [{
      url,
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      ...(declared.length ? { variables: Object.fromEntries(declared) } : {}),
    }];
  });
}

function hasLinks(operations: readonly NormalizedOperation[]): boolean {
  return operations.some((operation) =>
    operation.responses.some((response) => Object.keys(response.links).length > 0),
  );
}

interface ComponentRefEnv {
  readonly document: unknown;
  readonly resources: ResourceIndex;
  readonly currentBase: string;
}

function usesComponentRef(
  schema: unknown,
  env: ComponentRefEnv,
  visiting = new Set<unknown>(),
  uris = new Set<string>(),
): boolean {
  if (!isJsonObject(schema) || visiting.has(schema)) return false;
  visiting.add(schema);
  const currentBase = nextSchemaBase(schema, env.currentBase, env.resources);
  const nested: ComponentRefEnv = { ...env, currentBase };
  for (const keyword of ['$ref', '$dynamicRef'] as const) {
    const reference = schema[keyword];
    if (typeof reference !== 'string') continue;
    const target = resolveSchemaTarget(reference, currentBase, env.resources, env.document);
    if (target?.exactComponent) return true;
    if (!target) continue;
    const identity = schemaTargetIdentity(target);
    if (uris.has(identity)) continue;
    uris.add(identity);
    if (usesComponentRef(target.schema, { ...nested, currentBase: target.currentBase }, visiting, uris)) {
      return true;
    }
    uris.delete(identity);
  }
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (objectEntries(schema[keyword]).some(([, child]) => usesComponentRef(child, nested, visiting, uris))) return true;
  }
  for (const keyword of ['items', 'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema']) {
    if (usesComponentRef(schema[keyword], nested, visiting, uris)) return true;
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const children = schema[keyword];
    if (Array.isArray(children) && children.some(child => usesComponentRef(child, nested, visiting, uris))) return true;
  }
  return false;
}

function operationUsesComponentRef(
  operation: NormalizedOperation,
  side: 'input' | 'output',
  env: ComponentRefEnv,
): boolean {
  if (side === 'input') {
    return operation.requestContent.some(media => usesComponentRef(media.schema, env) || usesComponentRef(media.itemSchema, env))
      || operation.parameters.some(parameter => usesComponentRef(parameterSchema(parameter), env));
  }
  return operation.responses.some(response =>
    response.content.some(media => usesComponentRef(media.schema, env) || usesComponentRef(media.itemSchema, env))
    || objectEntries(response.headers).some(([, header]) => usesComponentRef(parameterSchema(resolveLocal(env.document, header)), env)),
  );
}

function referencedSchemes(
  document: unknown,
  operations: readonly NormalizedOperation[],
): Map<string, unknown> {
  const raw = asRecord(asRecord(asRecord(document).components).securitySchemes);
  const names = new Set<string>();
  for (const operation of operations) {
    for (const requirement of operation.security) {
      for (const name of Object.keys(requirement)) names.add(name);
    }
  }
  const result = new Map<string, unknown>();
  for (const name of names) {
    if (name in raw) result.set(name, resolveLocal(document, raw[name]));
  }
  return result;
}

function schemeIsMutualTls(scheme: unknown): boolean {
  return isJsonObject(scheme) && scheme.type === 'mutualTLS';
}

function parameterHasContent(parameter: NormalizedParameter): boolean {
  return parameter.content !== undefined && Object.keys(parameter.content).length > 0;
}

function framingFor(contentType: string): 'ndjson' | 'json-seq' | 'sse' | 'custom' {
  if (isNdjsonMediaType(contentType)) return 'ndjson';
  if (isJsonSeqMediaType(contentType)) return 'json-seq';
  if (isServerSentEventsMediaType(contentType)) return 'sse';
  return 'custom';
}

// Fragment dependencies are shared by emission and member-name reservation.
// Seeds describe actual consumers; this closure includes only their callees.
const HELPER_DEPENDENCIES: Partial<Record<ClientHelperName, readonly ClientHelperName[]>> = {
  constructor: [],
  url: ['baseUrl'],
  selectResponse: ['matchesStatus', 'mediaRank'],
  httpResponse: [],
  readResponse: ['selectResponse', 'httpResponse'],
  serializePath: ['serializeSimple', 'encode', 'entries'],
  serializeSimple: ['encode', 'entries'],
  serializeHeaderSimple: ['entries'],
  appendQuery: ['encode'],
  addQueryParameter: ['appendQuery', 'encode', 'entries'],
  addCookieParameter: ['encode', 'entries'],
  addCookieStyleParameter: ['entries'],
  setQueryString: ['formValue', 'serializeContentParameter', 'encode'],
  serializeContentParameter: ['parameterSerializers', 'entries', 'formValue'],
  encodeBody: ['bodyEncoders', 'isEncodedBody'],
  decodeResponseHeader: ['decodeHeaderScalar'],
  responseHeaders: ['decodeResponseHeader'],
  applySecurity: ['authValue', 'applyAuthScheme'],
  authValue: ['auth', 'securitySchemes'],
  applyAuthScheme: ['securitySchemes', 'appendQuery'],
};

function computeHelpers(plan: Omit<EmissionPlan, 'helpers'>): Set<ClientHelperName> {
  const helpers = new Set<ClientHelperName>();
  if (!plan.hasOutboundOperations) return helpers;
  const add = (...names: readonly ClientHelperName[]): void => {
    for (const name of names) {
      if (helpers.has(name)) continue;
      helpers.add(name);
      add(...(HELPER_DEPENDENCIES[name] ?? []));
    }
  };
  add(...BASE_CLIENT_HELPERS);
  if (plan.hasPathParams) add('serializePath');
  if (plan.hasHeaderParams) add('serializeHeaderSimple');
  if (plan.hasQueryParams) add('addQueryParameter');
  if (plan.hasFormCookies) add('addCookieParameter');
  if (plan.hasCookieStyleCookie) add('addCookieStyleParameter');
  if (plan.hasQueryString) add('setQueryString');
  if (plan.hasParameterContent) add('serializeContentParameter');
  if (plan.contentParameterLocations.has('path')) add('encode');
  if (plan.contentParameterLocations.has('query')) add('appendQuery');
  if (plan.hasRequestBodies) add('encodeBody');
  if (plan.hasFormBody) add('addQueryParameter');
  if (plan.hasResponseHeaders) add('responseHeaders');
  if (plan.streams.ndjson) add('readNdjson');
  if (plan.streams.jsonSeq) add('readJsonSeq');
  if (plan.streams.sse) add('readServerSentEvents');
  if (plan.profile.validation) {
    add('validateOperationInput', 'operationValidators', 'responseCheck');
  }
  if (plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls) add('applySecurity');
  if (plan.clientSurfaces.mutualTls) add('mutualTls');
  if (plan.clientSurfaces.responseDecoders) add('responseDecoders');
  if (plan.clientSurfaces.responseHeaderDecoders) add('responseHeaderDecoders');
  if (plan.clientSurfaces.streamDecoders) add('streamDecoders');
  return helpers;
}

export function buildEmissionPlan(
  document: unknown,
  ir: NormalizedDocument,
  profile: OpenApiGenerationProfile,
): EmissionPlan {
  const outbound = ir.operations;
  const inbound = ir.inboundOperations;
  const allOperations = [...outbound, ...inbound];
  const hasComponentSchemas = Object.keys(ir.schemas).length > 0;
  const { ordered } = collectOpenApiModelDefinitions(document);
  const hasModels = ordered.length > 0;
  const hasOutboundOperations = outbound.length > 0;
  const hasInboundOperations = inbound.length > 0;
  const links = hasLinks(outbound);
  const resources = collectCanonicalResources(document);
  const componentRefEnv: ComponentRefEnv = {
    document,
    resources,
    currentBase: schemaDocumentBase(document),
  };
  const typesUsesInputSchemas = hasComponentSchemas
    && allOperations.some((operation) => operationUsesComponentRef(operation, 'input', componentRefEnv));
  const typesUsesOutputSchemas = hasComponentSchemas
    && allOperations.some((operation) => operationUsesComponentRef(operation, 'output', componentRefEnv));
  const requestContent = outbound.flatMap((operation) => operation.requestContent);
  const responseContent = outbound.flatMap((operation) =>
    operation.responses.flatMap((response) => [...response.content]),
  );
  const hasRequestBodies = requestContent.length > 0;
  const hasResponseContent = responseContent.length > 0;
  const hasItemSchema = mediaList(outbound).some((media) => media.itemSchemaPresent);
  const parameters = outbound.flatMap((operation) => [...operation.parameters]);
  const hasParameterContent = parameters.some(parameterHasContent);
  const hasResponseHeaderContent = outbound.some((operation) =>
    operation.responses.some((response) =>
      objectEntries(response.headers).some(([, rawHeader]) => {
        const header = asRecord(resolveLocal(document, rawHeader));
        return Object.keys(asRecord(header.content)).length > 0;
      }),
    ),
  );
  const hasResponseHeaders = outbound.some((operation) =>
    operation.responses.some((response) => Object.keys(response.headers).length > 0),
  );
  const hasPathParams = parameters.some((parameter) => parameter.in === 'path' && !parameterHasContent(parameter));
  const hasQueryParams = parameters.some((parameter) => parameter.in === 'query' && !parameterHasContent(parameter));
  const hasHeaderParams = parameters.some((parameter) => parameter.in === 'header' && !parameterHasContent(parameter));
  const hasCookieParams = parameters.some((parameter) => parameter.in === 'cookie');
  const hasCookieStyleCookie = parameters.some((parameter) =>
    parameter.in === 'cookie' && parameter.style === 'cookie' && !parameterHasContent(parameter),
  );
  const hasFormCookies = parameters.some((parameter) =>
    parameter.in === 'cookie' && parameter.style !== 'cookie' && !parameterHasContent(parameter),
  );
  const hasQueryString = parameters.some((parameter) => parameter.in === 'querystring');
  const hasFormBody = requestContent.some((media) => mediaEssence(media.contentType) === 'application/x-www-form-urlencoded');
  const hasMultipartBody = requestContent.some((media) => mediaEssence(media.contentType) === 'multipart/form-data');
  const streams: StreamPlan = {
    ndjson: responseContent.some((media) => media.itemSchemaPresent && framingFor(media.contentType) === 'ndjson'),
    jsonSeq: responseContent.some((media) => media.itemSchemaPresent && framingFor(media.contentType) === 'json-seq'),
    sse: responseContent.some((media) => media.itemSchemaPresent && framingFor(media.contentType) === 'sse'),
    custom: responseContent.some((media) => media.itemSchemaPresent && framingFor(media.contentType) === 'custom'),
  };
  const authSchemes = referencedSchemes(document, outbound);
  const hasMutualTls = [...authSchemes.values()].some(schemeIsMutualTls);
  const hasNonTlsAuth = [...authSchemes.entries()].some(([, scheme]) => !schemeIsMutualTls(scheme));
  const clientSurfaces: ClientSurfaces = {
    bodyEncoders: hasRequestBodies,
    responseDecoders: hasResponseContent,
    parameterSerializers: hasParameterContent || hasQueryString,
    responseHeaderDecoders: hasResponseHeaderContent,
    streamDecoders: hasItemSchema,
    auth: hasNonTlsAuth,
    mutualTls: hasMutualTls,
  };
  const artifacts = new Set<ArtifactFile>(ALWAYS_ARTIFACTS);
  if (hasComponentSchemas) {
    artifacts.add('input-schemas.ts');
    artifacts.add('output-schemas.ts');
  }
  const servers = documentServers(document);
  if (hasOutboundOperations) artifacts.add('client.ts');
  if (hasOutboundOperations && servers.length) artifacts.add('servers.ts');
  if (hasInboundOperations) artifacts.add('inbound.ts');
  if (links) artifacts.add('links.ts');

  const partial = {
    profile,
    artifacts,
    servers,
    hasComponentSchemas,
    hasModels,
    hasOutboundOperations,
    hasInboundOperations,
    hasLinks: links,
    typesUsesInputSchemas,
    typesUsesOutputSchemas,
    clientSurfaces,
    streams,
    referencedAuthSchemes: authSchemes,
    hasRequestBodies,
    hasResponseContent,
    hasItemSchema,
    hasParameterContent,
    contentParameterLocations: new Set(parameters.filter(parameterHasContent).map(parameter => parameter.in)),
    hasResponseHeaderContent,
    hasResponseHeaders,
    hasPathParams,
    hasQueryParams,
    hasHeaderParams,
    hasCookieParams,
    hasCookieStyleCookie,
    hasFormCookies,
    hasQueryString,
    hasFormBody,
    hasMultipartBody,
  };
  return { ...partial, helpers: computeHelpers(partial) };
}

export function mediaFraming(media: OpenApiMediaType): 'ndjson' | 'json-seq' | 'sse' | 'custom-stream' | 'binary' | 'body' {
  if (media.itemSchemaPresent) {
    const framing = framingFor(media.contentType);
    return framing === 'custom' ? 'custom-stream' : framing;
  }
  if (media.schema === null && isBinaryMediaType(media.contentType)) return 'binary';
  return 'body';
}
