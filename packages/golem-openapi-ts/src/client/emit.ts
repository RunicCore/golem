import type { EmissionPlan } from '../emission-plan.js';
import { mediaFraming } from '../emission-plan.js';
import type { SchemaPlace, SdkValidatorsInput } from '@exprtlabs/golem/internal/validation-plan';
import { asRecord, escapeJsonPointerToken, isJsonObject, objectEntries } from '../json.js';
import { componentPlace, type OriginLocator } from '../origin.js';
import { identifier, NameScope } from '@exprtlabs/golem/internal/generator-support';
import {
  aliased,
  code,
  fileImports,
  identifier as identifierPart,
  importLines,
  importGroups,
  ImportSource,
  isEmpty,
  join,
  literal,
  docComment,
  documentLiteral,
  exportedName,
  renderModule,
  type RenderedModule,
  propertyKey,
  render,
  rt,
  rtType,
  type Code,
  packageKeysOf,
  runtimeLinesOf,
  type ImportGroup,
  type ImportOptions,
} from '@exprtlabs/golem/internal/emitter';
import {
  effectiveSchemaTypes,
  parameterSchema,
  resolveLocal,
  type NormalizedOperation,
} from '../normalize.js';
import { operationNameType } from '../names.js';
import { generatedBannerComment } from '../package-info.js';
import type { RuntimeSpecifiers } from '../runtime-copy.js';
import type { OperationWrapper } from '../plan.js';
import type { OpenApiGenerationProfile } from '../profile.js';
import { requireProfile } from '../profile.js';
import { operationConverts, parameterKey, requestBodyKey, responseBodyKey, responseHeaderKey } from '../model-schema-graph.js';
import type { OperationCodecsFor } from '../operation-codecs.js';
import type { OperationValidatorNames } from '../model-emission.js';
import { buildOperationValidationSchemaBundle, buildOperationValidationSchemaBundles, buildSchemaData, operationSourceSchemas } from '../schemas.js';
import { authoredPointer, type MovedUnions } from '../document.js';
import { textCodecRequirement } from '../types.js';

/** A client runtime function: the name is a key of the client module, so a misspelled name is a type error. */
type ClientFunction = keyof typeof rt.client;


const BLANK = code``;

const CONTENT_PARAMETER_LOCATION = { path: code`'path'`, query: code`'query'`, header: code`'header'`, cookie: code`'cookie'` } as const;

/** A parameter that carries its value as a media type: the runtime serializes it by the first media type its `content` names. */
function serializedContentParameter(
  operation: NormalizedOperation,
  use: (name: ClientFunction) => Code,
  location: keyof typeof CONTENT_PARAMETER_LOCATION,
  name: string,
  content: object,
  value: Code,
): Code {
  const contentType = Object.keys(content)[0] || 'text/plain';
  return code`${use('serializeContentParameter')}(runtime, ${value}, { operation: ${literal(operation.name)}, name: ${literal(name)}, in: ${CONTENT_PARAMETER_LOCATION[location]}, contentType: ${literal(contentType)} })`;
}

function routeExpression(operation: NormalizedOperation, use: (name: ClientFunction) => Code, input: Code): { declarations: Code; expression: Code } {
  const parameters = new Map(operation.parameters.filter((item) => item.in === 'path').map(item => [item.name, item]));
  const variables = new Map<string, Code>();
  const wholeSegments = new Set(operation.route.split('/').flatMap((segment) => /^\{[^{}]+\}$/.test(segment) ? [segment.slice(1, -1)] : []));
  const declarations: Code[] = [];
  const parts: Code[] = [];
  let offset = 0;
  for (const match of operation.route.matchAll(/\{([^{}]+)\}/g)) {
    const parameter = parameters.get(match[1] ?? '');
    if (!parameter) continue;
    parts.push(literal(operation.route.slice(offset, match.index)));
    offset = match.index + match[0].length;
    const previous = variables.get(parameter.name);
    if (previous) { parts.push(previous); continue; }
    const variable = identifierPart(`pathValue${variables.size}`);
    variables.set(parameter.name, variable);
    parts.push(variable);
    if (parameter.content) {
      declarations.push(code`    const ${variable} = ${use('encode')}(${serializedContentParameter(operation, use, 'path', parameter.name, parameter.content, code`${input}.path[${literal(parameter.name)}]`)});`);
      continue;
    }
    const style = parameter.style || 'simple';
    const explode = parameter.explode === undefined ? false : parameter.explode;
    // Only a parameter that stands alone between slashes can form a dot-segment; the call states the other case.
    const inSegment = wholeSegments.has(parameter.name) ? BLANK : code`, false`;
    declarations.push(code`    const ${variable} = ${use('serializePath')}(runtime, ${literal(parameter.name)}, ${input}.path[${literal(parameter.name)}], ${literal(style)}, ${literal(explode)}${inSegment});`);
  }
  parts.push(literal(operation.route.slice(offset)));
  return { declarations: join(declarations, code`\n`), expression: join(parts, code` + `) };
}

/**
 * The scalar kind a response header value decodes to: the first non-null `type` of the schema itself, else the one
 * non-null kind that all its `anyOf`/`oneOf`/`allOf` members (and the schemas they `$ref`) agree on, else null.
 */
function headerSchemaKind(document: unknown, rawSchema: unknown, depth = 0): string | null {
  const schema = asRecord(resolveLocal(document, rawSchema));
  const own = effectiveSchemaTypes(schema).find((type) => type !== 'null');
  if (own !== undefined) return own;
  if (depth >= 32) return null;
  const kinds = new Set<string | null>();
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = schema[keyword];
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const kind = headerSchemaKind(document, member, depth + 1);
      if (kind !== null) kinds.add(kind);
    }
  }
  return kinds.size === 1 ? [...kinds][0] ?? null : null;
}

/** Whether a declared response header (or a reference to one) is required. */
function responseHeaderRequired(document: unknown, rawHeader: unknown): boolean {
  return asRecord(resolveLocal(document, rawHeader)).required === true;
}

function responseContractsForOperation(
  document: unknown,
  operation: NormalizedOperation,
): readonly unknown[] {
  return operation.responses.map((response) => ({
    status: response.status,
    content: response.content.map((media) => {
      const requirement = textCodecRequirement(media, 'responseDecoders', document);
      return {
        contentType: media.contentType,
        framing: mediaFraming(media),
        ...(requirement
          ? { requiredCodec: requirement.option, schemaType: requirement.schemaType }
          : {}),
      };
    }),
    headers: objectEntries(response.headers).map(([name, rawHeader]) => {
      const header = asRecord(resolveLocal(document, rawHeader));
      const contentType = Object.keys(asRecord(header.content))[0] || null;
      const schema = asRecord(resolveLocal(document, parameterSchema(header)));
      const itemSchema = asRecord(resolveLocal(document, schema.items));
      return {
        name,
        style: header.style || 'simple',
        explode: header.explode === true,
        contentType,
        ...(responseHeaderRequired(document, rawHeader) ? { required: true } : {}),
        kind: headerSchemaKind(document, schema),
        itemKind: headerSchemaKind(document, itemSchema),
        propertyKinds: Object.fromEntries(
          objectEntries(schema.properties).map(([propertyKey, propertySchema]) => [propertyKey, headerSchemaKind(document, propertySchema)]),
        ),
      };
    }),
  }));
}

function operationSecuritySchemeData(
  operation: NormalizedOperation,
  schemes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const names = new Set(operation.security.flatMap((requirement) => Object.keys(requirement)));
  return Object.fromEntries(Object.entries(schemes).filter(([name]) => names.has(name)));
}

function literalType(value: unknown): Code {
  if (value === undefined) return code`undefined`;
  if (value === null) return code`null`;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return documentLiteral(value);
  }
  if (Array.isArray(value)) {
    return code`readonly [${join(value.map(literalType), code`, `)}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return code`{}`;
    return code`{ ${join(entries.map(([name, child]) => code`readonly ${propertyKey(name)}: ${literalType(child)}`), code`; `)} }`;
  }
  return code`unknown`;
}

interface GeneratedClientModules {
  readonly client: RenderedModule;
  /** Module paths are relative to the generated package root. */
  readonly operations: ReadonlyMap<string, string>;
}

function operationFactoryName(operation: NormalizedOperation): string {
  return `create${identifier(operation.name)}Operation`;
}

function requireValidatorExport(operation: string, reference: string, exports: ReadonlyMap<string, string>): string {
  const exported = exports.get(reference);
  if (exported === undefined) throw new Error(`The generated validators of operation ${JSON.stringify(operation)} have no export for ${JSON.stringify(reference)}.`);
  return exported;
}

function operationSource(
  clientName: string,
  operation: NormalizedOperation,
  document: unknown,
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  responseContracts: readonly unknown[],
  securitySchemes: Readonly<Record<string, unknown>>,
  convertedNodeIds: ReadonlyMap<string, string>,
  codecsFor: OperationCodecsFor,
  specifiers: RuntimeSpecifiers | undefined,
  wrapper: OperationWrapper | undefined,
): string {
  const usedFunctions = new Set<string>();
  const use = (name: ClientFunction): Code => {
    usedFunctions.add(name);
    return rt.client[name];
  };
  const encodesParameters = operation.parameters.some((parameter) => convertedNodeIds.has(parameterKey(operation.name, parameter.in, parameter.name)));
  // The parameters are read from the call's input, or from its copy with each converted parameter in its wire form.
  const parameterInput = encodesParameters ? code`wireInput` : code`input`;
  const route = routeExpression(operation, use, parameterInput);
  const queryParameters = operation.parameters.filter((item) => item.in === 'query');
  const queryStringParameter = operation.parameters.find((item) => item.in === 'querystring');
  const headerParameters = operation.parameters.filter((item) => item.in === 'header');
  const cookieParameters = operation.parameters.filter((item) => item.in === 'cookie');
  const requestBody = operation.requestContent.length > 0;
  const singleContentType = operation.requestContent.length === 1
    ? operation.requestContent[0]?.contentType
    : null;
  const bodyValue = operation.requestContent.length > 1 ? code`input.body?.value` : code`input.body`;
  const bodyContentType = operation.requestContent.length > 1
    ? code`input.body?.contentType`
    : documentLiteral(singleContentType ?? null);
  const bodyEncodings = documentLiteral(Object.fromEntries(
    operation.requestContent.map((media) => {
      const requirement = textCodecRequirement(media, 'bodyEncoders', document);
      return [media.contentType, {
        encoding: media.encoding || {},
        prefixEncoding: media.prefixEncoding || [],
        itemEncoding: media.itemEncoding || null,
        ...(requirement
          ? { requiredCodec: requirement.option, schemaType: requirement.schemaType }
          : {}),
      }];
    }),
  ));
  const security = documentLiteral(operation.security || []);
  const surfaces = plan.clientSurfaces;
  // An empty effective requirement list (an operation-level `security: []` or no
  // security anywhere) is a no-op in applySecurity, so the call is not emitted.
  const appliesSecurity = (surfaces.auth || surfaces.mutualTls) && operation.security.length > 0;
  const queryLines = queryParameters.map((parameter) => {
    if (parameter.content) {
      return code`    if (${parameterInput}.query?.[${literal(parameter.name)}] !== undefined) ${use('appendQuery')}(runtime, query, ${literal(parameter.name)}, ${serializedContentParameter(operation, use, 'query', parameter.name, parameter.content, code`${parameterInput}.query[${literal(parameter.name)}]`)}, ${literal(parameter.allowReserved === true)});`;
    }
    return code`    ${use('addQueryParameter')}(runtime, query, ${literal(parameter.name)}, ${parameterInput}.query?.[${literal(parameter.name)}], ${literal(parameter.style || 'form')}, ${literal(parameter.explode === undefined ? true : parameter.explode)}, ${literal(parameter.allowReserved === true)});`;
  });
  const headerLines = headerParameters.map((parameter) => {
    if (parameter.content) {
      return code`    if (${parameterInput}.header?.[${literal(parameter.name)}] !== undefined) headers.set(${literal(parameter.name)}, ${serializedContentParameter(operation, use, 'header', parameter.name, parameter.content, code`${parameterInput}.header[${literal(parameter.name)}]`)});`;
    }
    return code`    if (${parameterInput}.header?.[${literal(parameter.name)}] !== undefined) headers.set(${literal(parameter.name)}, ${use('serializeHeaderSimple')}(runtime, ${parameterInput}.header[${literal(parameter.name)}], ${literal(parameter.explode === true)}, ${literal(parameter.name)}));`;
  });
  const cookieLines = cookieParameters.map((parameter) => {
    if (parameter.content) {
      return code`    if (${parameterInput}.cookie?.[${literal(parameter.name)}] !== undefined) cookies.push(${literal(parameter.name)} + '=' + encodeURIComponent(${serializedContentParameter(operation, use, 'cookie', parameter.name, parameter.content, code`${parameterInput}.cookie[${literal(parameter.name)}]`)}));`;
    }
    // OpenAPI 3.2 sets explode true for style form and style cookie when the parameter does not say (see the styles-for-cookie rule in openapi-schemas/oas-3-2.ts).
    const explode = literal(parameter.explode === undefined ? true : parameter.explode);
    return code`    ${use(parameter.style === 'cookie' ? 'addCookieStyleParameter' : 'addCookieParameter')}(runtime, cookies, ${literal(parameter.name)}, ${parameterInput}.cookie?.[${literal(parameter.name)}], ${explode});`;
  });
  const queryStringLine = queryStringParameter
    ? code`    ${use('setQueryString')}(runtime, query, ${parameterInput}.querystring, { operation: ${literal(operation.name)}, name: ${literal(queryStringParameter.name)}, in: 'querystring', contentType: ${literal(Object.keys(queryStringParameter.content || {})[0] || 'application/x-www-form-urlencoded')} });`
    : BLANK;
  const readsInput = Boolean(profile.validation || operation.parameters.length || requestBody);
  const inputName = identifierPart(readsInput ? 'input' : '_input');
  const factoryName = operationFactoryName(operation);
  if (appliesSecurity) use('applySecurity');
  if (requestBody) use('encodeBody');
  const validatesWithSources = profile.validation;
  // The operation's codec module holds the validators, and the conversion of each body that has a Date or Temporal value.
  const encodes = operation.requestContent.some((media) => convertedNodeIds.has(requestBodyKey(operation.name, media.contentType)));
  const decodes = operation.responses.some((response) =>
    response.content.some((media) => convertedNodeIds.has(responseBodyKey(operation.name, response.status, media.contentType)))
    || Object.keys(response.headers).some((name) => convertedNodeIds.has(responseHeaderKey(operation.name, response.status, name))));
  const usesCodecs = validatesWithSources || operationConverts(operation, convertedNodeIds);
  if (encodes) use('convertRequestBody');
  if (encodesParameters) use('convertRequestParameters');
  if (readsInput) use('requireObjectInput');
  if (decodes) use('responseDecoder');
  const validationFunctions = validatesWithSources ? ['callLevels', 'operationValidators', 'responseCheck', 'validateOperationInput'] : [];
  const runtimeFunctions = [...usedFunctions].sort();
  const importedNames: Array<readonly [string, string]> = [
    ['ClientRuntime', 'client runtime import'],
    ['ClientOptions', 'client options import'],
    ['RequestOptions', 'request options import'],
    ['RuntimeResponseContract', 'response contract type import'],
    ['Types', 'generated types import'],
    ['createApiOperation', 'API operation factory import'],
    ['ApiOperation', 'API operation type import'],
    ['responseContracts', 'response metadata'],
    ...runtimeFunctions.map((name): readonly [string, string] => [name, `client runtime function ${name}`]),
    ...validationFunctions.map((name): readonly [string, string] => [name, `operation validation function ${name}`]),
  ];
  if (surfaces.auth || surfaces.mutualTls) importedNames.push(['__golemSecuritySchemes', 'security metadata']);
  if (appliesSecurity) importedNames.push(['RuntimeSecuritySchemes', 'security scheme type import']);
  if (usesCodecs) importedNames.push(['OperationCodecs', 'operation codecs type import']);
  const codecsAt = codecsFor(`operations/${operation.name}.ts`);
  if (usesCodecs) for (const name of codecsAt.claimed) importedNames.push([name, 'SDK codecs table import']);
  if (plan.servers.length) importedNames.push(['__golemServers', 'document servers import']);
  const overrideIndex = plan.operationServerIndex.get(operation.name);
  if (overrideIndex !== undefined) importedNames.push(['__golemOperationServers', 'operation servers import']);
  const moduleScope = new NameScope(`operation ${JSON.stringify(operation.name)}`);
  for (const [name, origin] of importedNames) {
    moduleScope.claim(name, origin);
  }
  moduleScope.claim(operation.name, `operation factory ${JSON.stringify(operation.name)}`);
  moduleScope.claim(factoryName, `internal operation factory ${JSON.stringify(operation.name)}`);
  const uniqueModuleName = (base: string, origin: string): string => {
    let name = base;
    for (let suffix = 1; moduleScope.has(name); suffix += 1) name = `${base}${suffix}`;
    if (usesCodecs) moduleScope.claim(name, origin);
    return name;
  };
  const codecsName = identifierPart(uniqueModuleName('__operationCodecs', 'operation codecs'));
  const codecsModuleName = uniqueModuleName('__golemOperationCodecs', 'operation codecs module import');
  const typesModule = new ImportSource('../types.js', true, { namespace: 'Types' });
  const inputType = code`${typesModule.namespace()}.${identifierPart(`${operation.typeName}OperationInput`)}`;
  const responseType = code`${typesModule.namespace()}.${identifierPart(`${operation.typeName}OperationHttpResponse`)}`;
  const validatorSetup = validatesWithSources
    ? code`  const validators = ${rt.validation.operationValidators}(runtime, ${literal(operation.name)}, ${codecsName});`
    : BLANK;
  // A validating SDK resolves the levels of each call, and the response check and decoder follow them.
  const decoderSetup = decodes ? code`  const decodeResponse = ${use('responseDecoder')}(${codecsName});` : BLANK;
  const levelLines = profile.validation
    ? [
      code`    const levels = ${rt.validation.callLevels}(runtime, options.validate, ${literal(profile.validation === 'sanity' ? 'sanity' : true)});`,
      code`    const checkResponse = ${rt.validation.responseCheck}(validators, levels.response, levels.responseHeaders);`,
    ]
    : [];
  const requestLevel = profile.validation ? code`, levels.request` : BLANK;
  const parameterLevels = profile.validation ? code`, levels` : BLANK;
  const clientModule = new ImportSource('../client.js', true);
  const serversModule = new ImportSource('../servers.js');
  const serversCode = plan.servers.length ? serversModule.name('servers', { alias: '__golemServers' }) : BLANK;
  const overrideCode = overrideIndex === undefined ? BLANK : code`, ${serversModule.name('operationServers', { alias: '__golemOperationServers' })}[${literal(overrideIndex)}]`;
  const clientOptions = clientModule.name(`${clientName}ClientOptions`, { alias: 'ClientOptions' });
  const requestOptions = clientModule.name(`${clientName}RequestOptions`, { alias: 'RequestOptions' });
  const clientRuntime = rt.client.ClientRuntime;
  const apiOperation = wrapper ? wrapper.operationType : rtType.client.ApiOperation;
  const createApiOperation = wrapper ? wrapper.createOperation : rt.client.createApiOperation;
  const codecsDeclaration = usesCodecs
    ? code`const ${codecsName}: ${rtType.client.OperationCodecs} = ${codecsAt.read(operation.name, codecsModuleName)};`
    : BLANK;
  const securitySchemesType = rtType.client.RuntimeSecuritySchemes;
  // The client module imports `__golemSecuritySchemes` from every operation module.
  const securityDeclaration = surfaces.auth || surfaces.mutualTls
    ? code`export const __golemSecuritySchemes = ${documentLiteral(securitySchemes, 2)} as const;${appliesSecurity ? code`\nconst securitySchemes: ${securitySchemesType} = __golemSecuritySchemes;` : BLANK}`
    : BLANK;
  const securityCall = appliesSecurity
    ? code`    await ${use('applySecurity')}(runtime, ${security}, query, headers, cookies, securitySchemes);`
    : BLANK;
  const wireBodyExpression = operation.requestContent.length > 1
    ? code`input.body && { contentType: input.body.contentType, value: ${use('convertRequestBody')}(${codecsName}, input.body.contentType, input.body.value${requestLevel}) }`
    : code`${use('convertRequestBody')}(${codecsName}, ${bodyContentType}, input.body${requestLevel})`;
  const usesQuery = queryLines.length > 0 || !isEmpty(queryStringLine) || !isEmpty(securityCall);
  const usesCookies = cookieLines.length > 0 || !isEmpty(securityCall);
  const bodyLines = [
    readsInput ? code`    ${use('requireObjectInput')}(${literal(operation.name)}, input);` : BLANK,
    ...levelLines,
    encodesParameters ? code`    const wireInput = ${use('convertRequestParameters')}(${codecsName}, input${parameterLevels});` : BLANK,
    encodes ? code`    const wireBody = ${wireBodyExpression};` : BLANK,
    profile.validation ? code`    await ${rt.validation.validateOperationInput}(${literal(operation.name)}, ${encodes ? code`{ ...${parameterInput}, body: wireBody }` : parameterInput}, validators, levels);` : BLANK,
    usesQuery ? code`    const query: string[] = [];` : BLANK,
    ...queryLines,
    queryStringLine,
    code`    const headers = new Headers(runtime.defaultHeaders);`,
    ...headerLines,
    usesCookies ? code`    const cookies: string[] = [];` : BLANK,
    ...cookieLines,
    securityCall,
    usesCookies ? code`    if (cookies.length) headers.set('Cookie', cookies.join('; '));` : BLANK,
    requestBody ? code`    const encodedBody = ${use('encodeBody')}(runtime, ${literal(operation.name)}, ${encodes ? (operation.requestContent.length > 1 ? code`wireBody?.value` : code`wireBody`) : bodyValue}, ${bodyContentType}, ${bodyEncodings});\n    if (encodedBody.contentType) headers.set('Content-Type', encodedBody.contentType);` : BLANK,
    route.declarations,
    code`    const request: RequestInit = {`,
    code`      method: ${literal(operation.method)},`,
    code`      headers,`,
    code`    };`,
    code`    if (options.signal !== undefined) request.signal = options.signal;`,
    requestBody ? code`    if (encodedBody.body !== undefined) request.body = encodedBody.body;` : BLANK,
    code`    const response = await runtime.fetchImpl(runtime.url(${route.expression}, ${usesQuery ? code`query` : code`[]`}${overrideCode}), request);`,
    code`    return runtime.readResponse<${responseType}>(`,
    code`      ${literal(operation.name)},`,
    code`      response,`,
    code`      responseContracts,${validatesWithSources ? code`\n      checkResponse,` : decodes ? code`\n      undefined,` : BLANK}${decodes ? code`\n      decodeResponse,` : BLANK}`,
    code`    );`,
  ].filter(line => !isEmpty(line));
  const body = code`  return ${createApiOperation}(${literal(operation.name)}, async (${inputName}: ${inputType}, options: ${requestOptions} = {}): Promise<${responseType}> => {
${join(bodyLines, code`\n`)}
  });`;
  const declarations = join([
    securityDeclaration,
    code`const responseContracts: readonly ${rtType.client.RuntimeResponseContract}[] = ${documentLiteral(responseContracts)};`,
    codecsDeclaration,
  ].filter((part) => !isEmpty(part)), code`\n`);
  const factoryCode = identifierPart(factoryName);
  const functions = code`export function ${identifierPart(operation.name)}(options: ${clientOptions}): ${apiOperation}<${inputType}, ${responseType}, ${requestOptions}> {
  return ${factoryCode}(new ${clientRuntime}(${literal(clientName)}, options${plan.servers.length ? code`, ${serversCode}` : BLANK}));
}

export function ${factoryCode}(runtime: ${clientRuntime}): ${apiOperation}<${inputType}, ${responseType}, ${requestOptions}> {
${!isEmpty(validatorSetup) ? code`${validatorSetup}\n` : BLANK}${!isEmpty(decoderSetup) ? code`${decoderSetup}\n` : BLANK}${body}
}
`;
  const file = join([declarations, functions], code`\n`);
  // The imports are the names the code uses, in the order the generated modules have always listed them.
  const extensionModules = packageKeysOf(file);
  const imports: ImportOptions = {
    typeNames: 'ordered',
    modules: ['client', ...extensionModules, 'validation'],
    ...(specifiers ? { specifiers: specifiers(`operations/${operation.name}.ts`) } : {}),
    order: { client: ['ClientRuntime', ...[...usedFunctions].sort(), 'createApiOperation', 'ApiOperation', 'RuntimeResponseContract', 'RuntimeSecuritySchemes', 'OperationCodecs'] },
  };
  const runtimeLines = runtimeLinesOf(file, imports);
  const codecsSources = codecsAt.sources();
  const clientImports = fileImports(file, [clientModule], { elsewhere: [typesModule, ...codecsSources, serversModule] });
  const typesImports = fileImports(file, [typesModule], { elsewhere: [clientModule, ...codecsSources, serversModule] });
  const serversImports = fileImports(file, [serversModule], { elsewhere: [typesModule, clientModule, ...codecsSources] });
  const codecsImportLines = fileImports(file, codecsSources, { elsewhere: [typesModule, clientModule, serversModule] });
  return render(code`${join([
    generatedBannerComment(),
    ...runtimeLines('client'),
    ...clientImports,
    ...typesImports,
    ...serversImports,
    ...runtimeLines(...extensionModules),
    ...codecsImportLines,
    ...runtimeLines('validation'),
    BLANK,
    ...(!isEmpty(declarations) ? [declarations] : []),
  ], code`\n`)}

${functions}`);
}

function emitSecurityTypes(
  clientName: string,
  rawSecuritySchemes: Readonly<Record<string, unknown>>,
  runtime: Code,
): Code {
  const entries = objectEntries(rawSecuritySchemes);
  const contextSchemes = entries.filter(([, scheme]) => isJsonObject(scheme) && !scheme.$ref && scheme.type !== 'mutualTLS');
  const named = (suffix: string): Code => identifierPart(`${clientName}${suffix}`);
  const exported = (suffix: string): Code => exportedName(`${clientName}${suffix}`);
  const schemeNames = entries.map(([name]) => literal(name));
  const nameType = schemeNames.length ? join(schemeNames, code` | `) : code`never`;
  const flowCases = contextSchemes.map(([name, scheme]) =>
    code`  Name extends ${literal(name)} ? ${literalType(asRecord(scheme).flows)} :`,
  );
  const urlCases = contextSchemes.map(([name, scheme]) =>
    code`  Name extends ${literal(name)} ? ${literalType(asRecord(scheme).openIdConnectUrl)} :`,
  );
  const contexts = contextSchemes.map(([name, scheme]) => {
    const record = asRecord(scheme);
    const scopes = [...new Set(
      Object.values(asRecord(record.flows)).flatMap((flow) =>
        Object.keys(asRecord(asRecord(flow).scopes)),
      ),
    )];
    const scopeType = scopes.length
      ? code`readonly (${join(scopes.map((scope) => literal(scope)), code` | `)})[]`
      : code`readonly string[]`;
    return code`export type ${exported(`${identifier(name)}Context`)} =
  Omit<${named('AuthContext')}, 'scheme' | 'type' | 'scopes' | 'flows' | 'openIdConnectUrl'> & {
    readonly scheme: ${literal(name)};
    readonly type: ${documentLiteral(record.type)};
    readonly scopes: ${scopeType};
    readonly flows: ${named('SecuritySchemeFlows')}<${literal(name)}>;
    readonly openIdConnectUrl: ${named('SecuritySchemeOpenIdConnectUrl')}<${literal(name)}>;
  };`;
  });
  const properties = contextSchemes.map(([name, scheme]) => {
    const record = asRecord(scheme);
    const contextType = named(`${identifier(name)}Context`);
    const valueType = record.type === 'http' && String(record.scheme).toLowerCase() === 'basic'
      ? code`${named('BasicAuthValue')}<${contextType}>`
      : code`${named('TokenAuthValue')}<${contextType}>`;
    return code`  ${propertyKey(name)}?: ${valueType};`;
  });
  if (!entries.length) return BLANK;
  const otherwise = code`  Name extends ${named('SecuritySchemeName')} ? undefined : never;`;

  return code`export type ${exported('AuthContext')} = ${runtime}.AuthContext;

export type ${exported('SecuritySchemeName')} = ${nameType};

export type ${exported('SecuritySchemeFlows')}<
  Name extends ${named('SecuritySchemeName')},
> =
${flowCases.length ? code`${join(flowCases, code`\n`)}  undefined;` : otherwise}

export type ${exported('SecuritySchemeOpenIdConnectUrl')}<
  Name extends ${named('SecuritySchemeName')},
> =
${urlCases.length ? code`${join(urlCases, code`\n`)}  undefined;` : otherwise}

${join(contexts, code`\n\n`)}

export type ${exported('TokenAuthValue')}<
  Context extends ${named('AuthContext')} = ${named('AuthContext')},
> = ${runtime}.TokenAuthValue<Context>;

export type ${exported('BasicCredentials')} = ${runtime}.BasicCredentials;
export type ${exported('BasicAuthValue')}<
  Context extends ${named('AuthContext')} = ${named('AuthContext')},
> = ${runtime}.BasicAuthValue<Context>;

export interface ${exported('Auth')} {
${join(properties, code`\n`)}
}
`;
}

function emitClient(
  clientName: string,
  operations: readonly NormalizedOperation[],
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  rawSecuritySchemes: Readonly<Record<string, unknown>>,
  specifiers: RuntimeSpecifiers | undefined,
  wrapper: OperationWrapper | undefined,
): RenderedModule {
  const scope = new NameScope(`${clientName}Client`);
  const surfaces = plan.clientSurfaces;
  scope.claim('ClientRuntime', 'shared client runtime');
  scope.claim('Runtime', 'shared client runtime types');
  scope.claim('ClientOptions', 'client options import');
  scope.claim('RequestOptions', 'request options import');
  scope.claim('Types', 'generated types import');
  scope.claim('ApiOperation', 'API operation type import');
  scope.claim(`${clientName}Client`, 'client class');
  scope.claim(`${clientName}ClientPort`, 'client interface');
  if (plan.helpers.has('selectResponse')) scope.claim(`${clientName}UndeclaredResponseError`, 'undeclared response error export');
  if (plan.helpers.has('selectResponse')) scope.claim(`is${clientName}UndeclaredResponseError`, 'undeclared response error guard');
  if (plan.helpers.has('selectResponse')) scope.claim('isUndeclaredResponseError', 'shared undeclared response error guard');
  if (profile.validation) {
    scope.claim('__GolemOperationName', 'operation name type');
    scope.claim('__GolemOperationRuntimeValidators', 'operation validators type import');
  }
  const metadataName = `${clientName[0]?.toLowerCase() ?? 'c'}${clientName.slice(1)}SecuritySchemeMetadata`;
  if (plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls) scope.claim(metadataName, 'security metadata export');
  const aliases = new Map<string, string>();
  const securityAliases = new Map<string, string>();
  operations.forEach((operation, index) => {
    scope.claim(operation.name, `operation ${JSON.stringify(operation.name)}`);
    let alias = `__golemOperationFactory${index}`;
    while (scope.has(alias)) alias += '_';
    scope.claim(alias, `operation factory ${JSON.stringify(operation.name)}`);
    aliases.set(operation.name, alias);
    if (plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls) {
      let securityAlias = `__golemSecuritySchemes${index}`;
      while (scope.has(securityAlias)) securityAlias += '_';
      scope.claim(securityAlias, `security metadata ${JSON.stringify(operation.name)}`);
      securityAliases.set(operation.name, securityAlias);
    }
  });
  // Each operation module is imported under the aliases that the scope decided; a name is imported when the code calls it.
  const operationSources = operations.map((operation) => new ImportSource(`./operations/${operation.name}.js`));
  const serversSource = new ImportSource('./servers.js');
  const localSources = [...operationSources, serversSource];
  if (plan.servers.length) scope.claim('__golemServers', 'document servers import');
  const factoryCodes = operations.map((operation, index) => operationSources[index]?.name(operationFactoryName(operation), { alias: aliases.get(operation.name) ?? '' }) ?? BLANK);
  const securityCodes = operations.flatMap((operation, index) => {
    const securityAlias = securityAliases.get(operation.name);
    return securityAlias ? [operationSources[index]?.name('__golemSecuritySchemes', { alias: securityAlias }) ?? BLANK] : [];
  });
  const metadata = plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls
    ? code`export const ${exportedName(metadataName)} = {
${join(securityCodes.map((alias) => code`  ...${alias},`), code`\n`)}
} as const;`
    : BLANK;
  const clientRuntime = rt.client.ClientRuntime;
  const runtimeTypes = new ImportSource(specifiers ? specifiers('client.ts').types.client : '@exprtlabs/golem/client', true, { namespace: 'Runtime' });
  const typesModule = new ImportSource('./types.js', true, { namespace: 'Types' });
  const runtimeNamespace = runtimeTypes.namespace();
  const typesNamespace = typesModule.namespace();
  const named = (suffix: string): Code => identifierPart(`${clientName}${suffix}`);
  const exported = (suffix: string): Code => exportedName(`${clientName}${suffix}`);
  const inputTypeOf = (operation: NormalizedOperation): Code => code`${typesNamespace}.${identifierPart(`${operation.typeName}OperationInput`)}`;
  const responseTypeOf = (operation: NormalizedOperation): Code => code`${typesNamespace}.${identifierPart(`${operation.typeName}OperationHttpResponse`)}`;
  const apiOperation = wrapper ? wrapper.operationType : rtType.client.ApiOperation;
  const methods = join(operations.map((operation) =>
    code`  ${identifierPart(operation.name)}(): ${apiOperation}<${inputTypeOf(operation)}, ${responseTypeOf(operation)}, ${named('RequestOptions')}>;`,
  ), code`\n`);
  const implementations = join(operations.map((operation, index) =>
    code`  ${identifierPart(operation.name)}(): ${apiOperation}<${inputTypeOf(operation)}, ${responseTypeOf(operation)}, ${named('RequestOptions')}> {
    return ${factoryCodes[index] ?? BLANK}(this.runtime);
  }`,
  ), code`\n\n`);
  const undeclared = plan.helpers.has('selectResponse');
  const usesAuth = surfaces.auth || surfaces.mutualTls;
  const optionExtensions: Code[] = [
    ...(plan.servers.length ? [] : [code`  ${docComment('The API endpoint. The document lists no servers.')}\n  baseUrl: string;`]),
    ...(surfaces.auth ? [code`  ${docComment('Values or lazy providers keyed by OpenAPI security-scheme name.')}\n  auth?: ${named('Auth')};`] : []),
    ...(profile.validation ? [code`  ${docComment('Overrides generated validators for individual operations.')}\n  operationValidators?: ReadonlyMap<__GolemOperationName, ${aliased(rtType.validation.OperationRuntimeValidators, '__GolemOperationRuntimeValidators')}>;`] : []),
  ];
  const omittedOptions = [
    ...(plan.servers.length ? [] : ['baseUrl', 'server', 'serverVariables']),
    ...(surfaces.bodyEncoders ? [] : ['bodyEncoders']),
    ...(surfaces.responseDecoders ? [] : ['responseDecoders']),
    ...(surfaces.parameterSerializers ? [] : ['parameterSerializers']),
    ...(surfaces.responseHeaderDecoders ? [] : ['responseHeaderDecoders']),
    ...(surfaces.streamDecoders ? [] : ['streamDecoders']),
    ...(surfaces.mutualTls ? [] : ['mutualTls']),
    'auth',
    'operationValidators',
    ...(profile.validation ? [] : ['validate']),
  ];
  const optionsType = code`Omit<${runtimeNamespace}.ClientOptions, ${join(omittedOptions.map((name) => literal(name)), code` | `)}>${optionExtensions.length ? code` & {\n${join(optionExtensions, code`\n`)}\n}` : BLANK}`;
  const aliases_ = join([
    code`export type ${exported('ClientOptions')} = ${optionsType};`,
    code`export type ${exported('RequestOptions')} = ${profile.validation ? code`${runtimeNamespace}.RequestOptions` : code`Omit<${runtimeNamespace}.RequestOptions, 'validate'>`};`,
    ...(undeclared ? [
      code`export type ${exported('UndeclaredResponseError')} = ${runtimeNamespace}.UndeclaredResponseError;`,
      code`export function ${exportedName(`is${clientName}UndeclaredResponseError`)}(error: unknown): error is ${runtimeNamespace}.UndeclaredResponseError {\n  return ${rt.client.isUndeclaredResponseError}(error, ${literal(clientName)});\n}`,
    ] : []),
    ...(surfaces.mutualTls ? [code`export type ${exported('MutualTlsTransport')} = ${runtimeNamespace}.MutualTlsTransport;`] : []),
    ...(surfaces.streamDecoders ? [
      code`export type ${exported('StreamDecoderContext')} = ${runtimeNamespace}.StreamDecoderContext;`,
      code`export type ${exported('StreamDecoder')} = ${runtimeNamespace}.StreamDecoder;`,
    ] : []),
    ...(surfaces.parameterSerializers ? [
      code`export type ${exported('ParameterSerializerContext')} = ${runtimeNamespace}.ParameterSerializerContext;`,
      code`export type ${exported('ParameterSerializer')} = ${runtimeNamespace}.ParameterSerializer;`,
    ] : []),
    ...(surfaces.responseHeaderDecoders ? [
      code`export type ${exported('ResponseHeaderDecoderContext')} = ${runtimeNamespace}.ResponseHeaderDecoderContext;`,
      code`export type ${exported('ResponseHeaderDecoder')} = ${runtimeNamespace}.ResponseHeaderDecoder;`,
    ] : []),
    ...(surfaces.bodyEncoders ? [
      code`export type ${exported('EncodedBody')} = ${runtimeNamespace}.EncodedBody;`,
      code`export type ${exported('EncodingMetadata')} = ${runtimeNamespace}.EncodingMetadata;`,
      code`export type ${exported('BodyEncoderContext')} = ${runtimeNamespace}.BodyEncoderContext;`,
      code`export type ${exported('BodyEncoder')} = ${runtimeNamespace}.BodyEncoder;`,
    ] : []),
  ], code`\n`);
  const tail = code`
${profile.validation ? code`\n${operationNameType('__GolemOperationName', operations)}\n` : BLANK}
${aliases_}
${usesAuth ? code`\n${emitSecurityTypes(clientName, rawSecuritySchemes, runtimeNamespace)}` : BLANK}
export interface ${exported('ClientPort')} {
${methods}
}

export class ${exported('Client')} implements ${named('ClientPort')} {
  private readonly runtime: ${clientRuntime};

  constructor(options: ${named('ClientOptions')}) {
    this.runtime = new ${clientRuntime}(${literal(clientName)}, options${plan.servers.length ? code`, ${serversSource.name('servers', { alias: '__golemServers' })}` : BLANK});
  }

${implementations}
}
${metadata}
`;
  const imports = join(fileImports(tail, localSources, { quote: '"', elsewhere: [runtimeTypes, typesModule] }), code`\n`);
  const rest = code`${imports}${tail}`;
  const extensionModules = packageKeysOf(rest);
  const imports_: ImportOptions = { modules: ['client', ...extensionModules, 'validation'], ...(specifiers ? { specifiers: specifiers('client.ts') } : {}) };
  const groups = importGroups(rest, imports_);
  const written = new Set<string>();
  // The statements of the runtime groups that `wanted` picks: the values come from the internal entry, the types from the public subpaths.
  const lines = (wanted: (group: ImportGroup) => boolean): readonly Code[] => groups.filter((group) => !written.has(group.specifier) && wanted(group)).flatMap((group) => {
    written.add(group.specifier);
    return importLines(group, imports_);
  });
  const importLinesOfFile = [
    ...lines((group) => group.names.length > 0),
    ...fileImports(rest, [runtimeTypes], { elsewhere: [typesModule, ...localSources] }),
    ...lines((group) => group.modules.includes('validation')),
    ...fileImports(rest, [typesModule], { elsewhere: [runtimeTypes, ...localSources] }),
    ...lines((group) => group.modules.some((module) => extensionModules.includes(module))),
    ...lines((group) => group.modules.includes('client')),
  ];
  const unwritten = groups.find((group) => !written.has(group.specifier));
  if (unwritten) throw new Error(`Internal error: the client file uses the runtime names ${[...unwritten.names, ...unwritten.types].map(({ name }) => name).join(', ')} of ${unwritten.specifier}, which its import list does not write.`);
  return renderModule(code`${join([generatedBannerComment(), ...importLinesOfFile], code`\n`)}
${rest}`);
}

type OperationValidationBundle = ReturnType<typeof buildOperationValidationSchemaBundle>;

/** What the SDK's validators module compiles for the operations. */
export interface OperationValidationSchemas {
  /** The validation schema bundle of each operation, by operation name. */
  readonly bundles: ReadonlyMap<string, OperationValidationBundle>;
  /** The roots and resources of each operation, for `compileSdkValidators`. */
  readonly operations: SdkValidatorsInput['operations'];
  /** Where a diagnostic about an operation schema belongs in the user's document. */
  readonly locate: (resource: string, pointer: string) => SchemaPlace | undefined;
}

/** The validation schemas of every operation; none when the profile does not validate. */
export function buildOperationValidationSchemas(
  operations: readonly NormalizedOperation[],
  document: unknown,
  profile: OpenApiGenerationProfile,
  schemaData?: ReturnType<typeof buildSchemaData>,
  locate?: OriginLocator,
  moved: MovedUnions = new Map(),
): OperationValidationSchemas | undefined {
  if (!profile.validation) return undefined;
  const bundles = buildOperationValidationSchemaBundles(document, operations, schemaData);
  const list = operations.map((operation) => {
    const bundle = bundles.get(operation.name);
    if (!bundle) throw new Error(`Missing generated validation schema bundle for operation ${operation.name}`);
    return bundle;
  });
  const componentNames = new Map(list.flatMap((bundle) => Object.entries(bundle.componentNames)));
  const operationRoots = new Map(list.map((bundle) => [bundle.operationRootId, bundle.operationName] as const));
  const sources = new Map(operations.map((operation) => [operation.name, operationSourceSchemas(operation, document)] as const));
  return {
    bundles,
    operations: list.map((bundle) => ({ roots: bundle.roots, resources: bundle.schemas })),
    locate: (resource, pointer) => {
      const component = componentNames.get(resource);
      if (component !== undefined) return componentPlace(locate, component, pointer);
      const operationName = operationRoots.get(resource);
      if (operationName === undefined) return undefined;
      const prefix = `/operations/${escapeJsonPointerToken(operationName)}`;
      if (!pointer.startsWith(prefix)) return undefined;
      const place = authoredPointer(sources.get(operationName), pointer.slice(prefix.length), moved);
      return { where: `operation ${JSON.stringify(operationName)} at ${place || '/'}` };
    },
  };
}

/** The export name of each validator an operation's codec module lists, from the SDK's validators module. */
export function operationValidatorNames(
  schemas: OperationValidationSchemas,
  validatorExports: ReadonlyMap<string, string>,
): ReadonlyMap<string, OperationValidatorNames> {
  return new Map([...schemas.bundles].map(([name, bundle]) => [name, {
    input: requireValidatorExport(name, bundle.inputReference, validatorExports),
    ...(bundle.headersReference === undefined ? {} : { headers: requireValidatorExport(name, bundle.headersReference, validatorExports) }),
    responses: bundle.responseReferences.map((item) => ({ key: `${item.status}:${item.contentType}`, name: requireValidatorExport(name, item.reference, validatorExports) })),
    responseHeaders: bundle.responseHeaderReferences.map((item) => ({ key: `${item.status}:${item.name}`, name: requireValidatorExport(name, item.reference, validatorExports) })),
  }] as const));
}

/**
 * The modules of the client. Each operation module reads its validators and body conversions from its codecs (`codecsFor`);
 * `convertedNodeIds` names the bodies, parameters and response headers that convert something.
 */
export function generateClientModules(
  clientName: string,
  operations: readonly NormalizedOperation[],
  document: unknown = {},
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  convertedNodeIds: ReadonlyMap<string, string>,
  codecsFor: OperationCodecsFor,
  specifiers?: RuntimeSpecifiers,
  wrapper?: OperationWrapper,
): GeneratedClientModules {
  requireProfile(profile);
  const rawSecuritySchemes = Object.fromEntries(plan.referencedAuthSchemes);
  const securitySchemes = Object.fromEntries(
    objectEntries(rawSecuritySchemes).map(([name, scheme]) => [
      name,
      isJsonObject(scheme) && scheme.$ref ? { type: 'unresolved' } : {
        type: isJsonObject(scheme) ? scheme.type : undefined,
        scheme: isJsonObject(scheme) ? scheme.scheme : undefined,
        in: isJsonObject(scheme) ? scheme.in : undefined,
        name: isJsonObject(scheme) ? scheme.name : undefined,
        flows: isJsonObject(scheme) ? scheme.flows : undefined,
        openIdConnectUrl: isJsonObject(scheme) ? scheme.openIdConnectUrl : undefined,
      },
    ]),
  );
  const emittedOperations = new Map<string, string>();
  for (const operation of operations) {
    const operationSchemes = operationSecuritySchemeData(operation, securitySchemes);
    emittedOperations.set(`operations/${operation.name}.ts`, operationSource(
      clientName,
      operation,
      document,
      profile,
      plan,
      responseContractsForOperation(document, operation),
      operationSchemes,
      convertedNodeIds,
      codecsFor,
      specifiers,
      wrapper,
    ));
  }
  const client = emitClient(clientName, operations, profile, plan, rawSecuritySchemes, specifiers, wrapper);
  return { client, operations: emittedOperations };
}
