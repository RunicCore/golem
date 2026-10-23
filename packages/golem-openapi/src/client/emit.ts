import type { EmissionPlan } from '../emission-plan.js';
import { mediaFraming } from '../emission-plan.js';
import type { SchemaPlace, SdkValidatorsInput } from '@exprtlabs/golem/internal/validation-plan';
import { asRecord, escapeJsonPointerToken, isJsonObject, objectEntries } from '../json.js';
import { componentPlace, type OriginLocator } from '../origin.js';
import { identifier, NameScope, propertyName } from '@exprtlabs/golem/generator-api';
import {
  aliased,
  code,
  fileImports,
  identifier as identifierPart,
  importLines,
  importSet,
  ImportSource,
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
  type ImportOptions,
} from '@exprtlabs/golem/internal/emitter';
import {
  parameterSchema,
  resolveLocal,
  type NormalizedOperation,
} from '../normalize.js';
import { operationNameType } from '../names.js';
import { generatedBannerComment } from '../package-info.js';
import type { OpenApiGenerationProfile } from '../profile.js';
import { requireProfile } from '../profile.js';
import { buildOperationValidationSchemaBundle, buildOperationValidationSchemaBundles, buildSchemaData } from '../schemas.js';
import { textCodecRequirement } from '../types.js';

/** A client runtime function: the name is a key of the client module, so a misspelled name is a type error. */
type ClientFunction = keyof typeof rt.client;

const BLANK = code``;

function routeExpression(operation: NormalizedOperation, use: (name: ClientFunction) => Code): { declarations: Code; expression: Code } {
  const parameters = new Map(operation.parameters.filter((item) => item.in === 'path').map(item => [item.name, item]));
  const variables = new Map<string, Code>();
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
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      declarations.push(code`    const ${variable} = ${use('encode')}(${use('serializeContentParameter')}(runtime, input.path[${literal(parameter.name)}], { operation: ${literal(operation.name)}, name: ${literal(parameter.name)}, in: 'path', contentType: ${literal(contentType)} }));`);
      continue;
    }
    const style = parameter.style || 'simple';
    const explode = parameter.explode === undefined ? false : parameter.explode;
    declarations.push(code`    const ${variable} = ${use('serializePath')}(runtime, ${literal(parameter.name)}, input.path[${literal(parameter.name)}], ${literal(style)}, ${literal(explode)});`);
  }
  parts.push(literal(operation.route.slice(offset)));
  return { declarations: join(declarations, code`\n`), expression: join(parts, code` + `) };
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
      const types = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type ?? '')];
      const kind = types.find((type) => type && type !== 'null') || null;
      const itemSchema = asRecord(resolveLocal(document, schema.items));
      const itemTypes = Array.isArray(itemSchema.type) ? itemSchema.type.map(String) : [String(itemSchema.type ?? '')];
      return {
        name,
        style: header.style || 'simple',
        explode: header.explode === true,
        contentType,
        kind,
        itemKind: itemTypes.find((type) => type && type !== 'null') || null,
        propertyKinds: Object.fromEntries(
          objectEntries(schema.properties).map(([propertyKey, propertySchema]) => {
            const resolvedProperty = asRecord(resolveLocal(document, propertySchema));
            const propertyTypes = Array.isArray(resolvedProperty.type)
              ? resolvedProperty.type.map(String)
              : [String(resolvedProperty.type ?? '')];
            return [propertyKey, propertyTypes.find((type) => type && type !== 'null') || null];
          }),
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
  validationBundle: ReturnType<typeof buildOperationValidationSchemaBundle> | undefined,
  validatorExports: ReadonlyMap<string, string>,
): string {
  const usedFunctions = new Set<string>();
  const use = (name: ClientFunction): Code => {
    usedFunctions.add(name);
    return rt.client[name];
  };
  const route = routeExpression(operation, use);
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
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return code`    if (input.query?.[${literal(parameter.name)}] !== undefined) ${use('appendQuery')}(runtime, query, ${literal(parameter.name)}, ${use('serializeContentParameter')}(runtime, input.query[${literal(parameter.name)}], { operation: ${literal(operation.name)}, name: ${literal(parameter.name)}, in: 'query', contentType: ${literal(contentType)} }), ${literal(parameter.allowReserved === true)});`;
    }
    return code`    ${use('addQueryParameter')}(runtime, query, ${literal(parameter.name)}, input.query?.[${literal(parameter.name)}], ${literal(parameter.style || 'form')}, ${literal(parameter.explode === undefined ? true : parameter.explode)}, ${literal(parameter.allowReserved === true)});`;
  });
  const headerLines = headerParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return code`    if (input.header?.[${literal(parameter.name)}] !== undefined) headers.set(${literal(parameter.name)}, ${use('serializeContentParameter')}(runtime, input.header[${literal(parameter.name)}], { operation: ${literal(operation.name)}, name: ${literal(parameter.name)}, in: 'header', contentType: ${literal(contentType)} }));`;
    }
    return code`    if (input.header?.[${literal(parameter.name)}] !== undefined) headers.set(${literal(parameter.name)}, ${use('serializeHeaderSimple')}(runtime, input.header[${literal(parameter.name)}], ${literal(parameter.explode === true)}));`;
  });
  const cookieLines = cookieParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return code`    if (input.cookie?.[${literal(parameter.name)}] !== undefined) cookies.push(${literal(parameter.name)} + '=' + encodeURIComponent(${use('serializeContentParameter')}(runtime, input.cookie[${literal(parameter.name)}], { operation: ${literal(operation.name)}, name: ${literal(parameter.name)}, in: 'cookie', contentType: ${literal(contentType)} })));`;
    }
    if (parameter.style === 'cookie') {
      return code`    ${use('addCookieStyleParameter')}(runtime, cookies, ${literal(parameter.name)}, input.cookie?.[${literal(parameter.name)}], ${literal(parameter.explode === true)});`;
    }
    return code`    ${use('addCookieParameter')}(runtime, cookies, ${literal(parameter.name)}, input.cookie?.[${literal(parameter.name)}], ${literal(parameter.explode === undefined ? true : parameter.explode)});`;
  });
  const queryStringLine = queryStringParameter
    ? code`    ${use('setQueryString')}(runtime, query, input.querystring, { operation: ${literal(operation.name)}, name: ${literal(queryStringParameter.name)}, in: 'querystring', contentType: ${literal(Object.keys(queryStringParameter.content || {})[0] || 'application/x-www-form-urlencoded')} });`
    : BLANK;
  const inputName = identifierPart(profile.validation || operation.parameters.length || requestBody ? 'input' : '_input');
  const factoryName = operationFactoryName(operation);
  if (appliesSecurity) use('applySecurity');
  if (requestBody) use('encodeBody');
  // The bundle exists exactly when the profile validates.
  const validatesWithSources = validationBundle !== undefined;
  const validationFunctions = validatesWithSources ? ['operationValidators', 'responseCheck', 'validateOperationInput'] : [];
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
  if (profile.validation) importedNames.push(['OperationValidationSources', 'validation source type import']);
  const moduleScope = new NameScope(`operation ${JSON.stringify(operation.name)}`);
  for (const [name, origin] of importedNames) {
    moduleScope.claim(name, origin);
  }
  moduleScope.claim(operation.name, `operation factory ${JSON.stringify(operation.name)}`);
  moduleScope.claim(factoryName, `internal operation factory ${JSON.stringify(operation.name)}`);
  const uniqueModuleName = (base: string, origin: string): string => {
    let name = base;
    for (let suffix = 1; moduleScope.has(name); suffix += 1) name = `${base}${suffix}`;
    if (validatesWithSources) moduleScope.claim(name, origin);
    return name;
  };
  const validationSourcesName = identifierPart(uniqueModuleName('__operationValidationSources', 'operation validation sources'));
  const typesModule = new ImportSource('../types.js', true, { namespace: 'Types' });
  const inputType = code`${typesModule.namespace()}.${identifierPart(`${operation.typeName}OperationInput`)}`;
  const responseType = code`${typesModule.namespace()}.${identifierPart(`${operation.typeName}OperationHttpResponse`)}`;
  const validatorSetup = validatesWithSources
    ? code`  const validators = ${rt.validation.operationValidators}(runtime, ${literal(operation.name)}, ${validationSourcesName});\n  const checkResponse = ${rt.validation.responseCheck}(validators);`
    : BLANK;
  // The generated validators this operation imports, each under a module-local alias that no operation name can take.
  const validatorImports = validationBundle
    ? [
      { reference: validationBundle.inputReference, local: uniqueModuleName('__validateInput', 'generated input validator import') },
      ...validationBundle.responseReferences.map((item, index) => ({ reference: item.reference, local: uniqueModuleName(`__validateResponse${index}`, 'generated response validator import') })),
    ].map(item => ({ ...item, exported: requireValidatorExport(operation.name, item.reference, validatorExports) }))
    : [];
  const validatorsSource = new ImportSource('../validators.generated.js');
  const validatorNames = validatorImports.map((item) => validatorsSource.name(item.exported, { alias: item.local }));
  const clientModule = new ImportSource('../client.js', true);
  const clientOptions = clientModule.name(`${clientName}ClientOptions`, { alias: 'ClientOptions' });
  const requestOptions = clientModule.name(`${clientName}RequestOptions`, { alias: 'RequestOptions' });
  const clientRuntime = rt.client.ClientRuntime;
  const apiOperation = profile.mobx ? aliased(rtType.mobx.ObservableApiOperation, 'ApiOperation') : rtType.client.ApiOperation;
  const createApiOperation = profile.mobx ? aliased(rt.mobx.createObservableApiOperation, 'createApiOperation') : rt.client.createApiOperation;
  const validationSources = validationBundle
    ? join([
      code`const ${validationSourcesName}: ${rtType.client.OperationValidationSources} = {`,
      code`  input: ${validatorNames[0]},`,
      code`  responses: [${join(validationBundle.responseReferences.map((item, index) => code`{ status: ${literal(item.status)}, contentType: ${literal(item.contentType)}, validator: ${validatorNames[index + 1]} }`), code`, `)}],`,
      code`};`,
    ], code`\n`)
    : BLANK;
  const securitySchemesType = rtType.client.RuntimeSecuritySchemes;
  // The client module imports `__golemSecuritySchemes` from every operation module.
  const securityDeclaration = surfaces.auth || surfaces.mutualTls
    ? code`export const __golemSecuritySchemes = ${documentLiteral(securitySchemes, 2)} as const;${appliesSecurity ? code`\nconst securitySchemes: ${securitySchemesType} = __golemSecuritySchemes;` : BLANK}`
    : BLANK;
  const securityCall = appliesSecurity
    ? code`    await ${use('applySecurity')}(runtime, ${security}, query, headers, cookies, securitySchemes);`
    : BLANK;
  const usesQuery = queryLines.length > 0 || queryStringLine.parts.length > 0 || securityCall.parts.length > 0;
  const usesCookies = cookieLines.length > 0 || securityCall.parts.length > 0;
  const bodyLines = [
    profile.validation ? code`    await ${rt.validation.validateOperationInput}(${literal(operation.name)}, input, validators);` : BLANK,
    usesQuery ? code`    const query: string[] = [];` : BLANK,
    ...queryLines,
    queryStringLine,
    code`    const headers = new Headers(runtime.defaultHeaders);`,
    ...headerLines,
    usesCookies ? code`    const cookies: string[] = [];` : BLANK,
    ...cookieLines,
    securityCall,
    usesCookies ? code`    if (cookies.length) headers.set('Cookie', cookies.join('; '));` : BLANK,
    requestBody ? code`    const encodedBody = ${use('encodeBody')}(runtime, ${literal(operation.name)}, ${bodyValue}, ${bodyContentType}, ${bodyEncodings});\n    if (encodedBody.contentType) headers.set('Content-Type', encodedBody.contentType);` : BLANK,
    route.declarations,
    code`    const request: RequestInit = {`,
    code`      method: ${literal(operation.method)},`,
    code`      headers,`,
    code`    };`,
    code`    if (options.signal !== undefined) request.signal = options.signal;`,
    requestBody ? code`    if (encodedBody.body !== undefined) request.body = encodedBody.body;` : BLANK,
    code`    const response = await runtime.fetchImpl(runtime.url(${route.expression}, ${usesQuery ? code`query` : code`[]`}), request);`,
    code`    return runtime.readResponse<${responseType}>(`,
    code`      ${literal(operation.name)},`,
    code`      response,`,
    code`      responseContracts,${validatesWithSources ? code`\n      checkResponse,` : BLANK}`,
    code`    );`,
  ].filter(line => line.parts.length > 0);
  const body = code`  return ${createApiOperation}(${literal(operation.name)}, async (${inputName}: ${inputType}, options: ${requestOptions} = {}): Promise<${responseType}> => {
${join(bodyLines, code`\n`)}
  });`;
  const declarations = join([
    securityDeclaration,
    code`const responseContracts: readonly ${rtType.client.RuntimeResponseContract}[] = ${documentLiteral(responseContracts)};`,
    validationSources,
  ].filter((part) => part.parts.length > 0), code`\n`);
  const factoryCode = identifierPart(factoryName);
  const functions = code`export function ${identifierPart(operation.name)}(options: ${clientOptions}): ${apiOperation}<${inputType}, ${responseType}, ${requestOptions}> {
  return ${factoryCode}(new ${clientRuntime}(${literal(clientName)}, options));
}

export function ${factoryCode}(runtime: ${clientRuntime}): ${apiOperation}<${inputType}, ${responseType}, ${requestOptions}> {
${validatorSetup.parts.length > 0 ? code`${validatorSetup}\n` : BLANK}${body}
}
`;
  const file = join([declarations, functions], code`\n`);
  // The imports are the names the code uses, in the order the generated modules have always listed them.
  const imports: ImportOptions = {
    typeNames: 'ordered',
    modules: ['client', 'mobx', 'validation'],
    order: { client: ['ClientRuntime', ...[...usedFunctions].sort(), 'createApiOperation', 'ApiOperation', 'RuntimeResponseContract', 'RuntimeSecuritySchemes', 'OperationValidationSources'] },
  };
  const runtime = new Map(importSet(file, imports).map((entry) => [entry.module, entry] as const));
  const runtimeLines = (module: 'client' | 'mobx' | 'validation'): readonly Code[] => {
    const entry = runtime.get(module);
    return entry ? importLines(entry, imports) : [];
  };
  const clientImports = fileImports(file, [clientModule], { elsewhere: [typesModule, validatorsSource] });
  const typesImports = fileImports(file, [typesModule], { elsewhere: [clientModule, validatorsSource] });
  const validatorImportLines = fileImports(file, [validatorsSource], { elsewhere: [typesModule, clientModule] });
  return render(code`${join([
    generatedBannerComment(),
    ...runtimeLines('client'),
    ...clientImports,
    ...typesImports,
    ...runtimeLines('mobx'),
    ...validatorImportLines,
    ...runtimeLines('validation'),
    BLANK,
    ...(declarations.parts.length > 0 ? [declarations] : []),
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
  const runtimeTypes = new ImportSource('@exprtlabs/golem/client', true, { namespace: 'Runtime' });
  const typesModule = new ImportSource('./types.js', true, { namespace: 'Types' });
  const runtimeNamespace = runtimeTypes.namespace();
  const typesNamespace = typesModule.namespace();
  const named = (suffix: string): Code => identifierPart(`${clientName}${suffix}`);
  const exported = (suffix: string): Code => exportedName(`${clientName}${suffix}`);
  const inputTypeOf = (operation: NormalizedOperation): Code => code`${typesNamespace}.${identifierPart(`${operation.typeName}OperationInput`)}`;
  const responseTypeOf = (operation: NormalizedOperation): Code => code`${typesNamespace}.${identifierPart(`${operation.typeName}OperationHttpResponse`)}`;
  const apiOperation = profile.mobx ? aliased(rtType.mobx.ObservableApiOperation, 'ApiOperation') : rtType.client.ApiOperation;
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
    ...(surfaces.auth ? [code`  ${docComment('Values or lazy providers keyed by OpenAPI security-scheme name.')}\n  auth?: ${named('Auth')};`] : []),
    ...(profile.validation ? [code`  ${docComment('Overrides generated validators for individual operations.')}\n  operationValidators?: ReadonlyMap<__GolemOperationName, ${aliased(rtType.validation.OperationRuntimeValidators, '__GolemOperationRuntimeValidators')}>;`] : []),
  ];
  const omittedOptions = [
    ...(surfaces.bodyEncoders ? [] : ['bodyEncoders']),
    ...(surfaces.responseDecoders ? [] : ['responseDecoders']),
    ...(surfaces.parameterSerializers ? [] : ['parameterSerializers']),
    ...(surfaces.responseHeaderDecoders ? [] : ['responseHeaderDecoders']),
    ...(surfaces.streamDecoders ? [] : ['streamDecoders']),
    ...(surfaces.mutualTls ? [] : ['mutualTls']),
    'auth',
    'operationValidators',
  ];
  const optionsType = code`Omit<${runtimeNamespace}.ClientOptions, ${join(omittedOptions.map((name) => literal(name)), code` | `)}>${optionExtensions.length ? code` & {\n${join(optionExtensions, code`\n`)}\n}` : BLANK}`;
  const aliases_ = join([
    code`export type ${exported('ClientOptions')} = ${optionsType};`,
    code`export type ${exported('RequestOptions')} = ${runtimeNamespace}.RequestOptions;`,
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
    this.runtime = new ${clientRuntime}(${literal(clientName)}, options);
  }

${implementations}
}
${metadata}
`;
  const imports = join(fileImports(tail, operationSources, { quote: '"', elsewhere: [runtimeTypes, typesModule] }), code`\n`);
  const rest = code`${imports}${tail}`;
  const imports_: ImportOptions = { modules: ['client', 'mobx', 'validation'] };
  const runtime = new Map(importSet(rest, imports_).map((entry) => [entry.module, entry] as const));
  const written = new Set<string>();
  const lines = (module: 'client' | 'mobx' | 'validation', parts: { readonly values?: true; readonly types?: true }): readonly Code[] => {
    if (parts.values) written.add(`${module} values`);
    if (parts.types) written.add(`${module} types`);
    const entry = runtime.get(module);
    return entry ? importLines({ module, names: parts.values ? entry.names : [], types: parts.types ? entry.types : [] }, imports_) : [];
  };
  const importLinesOfFile = [
    ...lines('client', { values: true }),
    ...fileImports(rest, [runtimeTypes], { elsewhere: [typesModule, ...operationSources] }),
    ...lines('validation', { types: true }),
    ...fileImports(rest, [typesModule], { elsewhere: [runtimeTypes, ...operationSources] }),
    ...lines('mobx', { types: true }),
    ...(profile.mobx ? [] : lines('client', { types: true })),
  ];
  for (const [module, entry] of runtime) {
    if (entry.names.length > 0 && !written.has(`${module} values`)) throw new Error(`Internal error: the client file uses the ${module} runtime values ${entry.names.map(({ name }) => name).join(', ')}, which its import list does not write.`);
    if (entry.types.length > 0 && !written.has(`${module} types`)) throw new Error(`Internal error: the client file uses the ${module} runtime types ${entry.types.map(({ name }) => name).join(', ')}, which its import list does not write.`);
  }
  return renderModule(code`${join([generatedBannerComment(), ...importLinesOfFile], code`\n`)}
${rest}`);
}

type OperationValidationBundle = ReturnType<typeof buildOperationValidationSchemaBundle>;

/** What the SDK's validators module compiles for the operations. */
interface OperationValidationSchemas {
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
  return {
    bundles,
    operations: list.map((bundle) => ({ roots: bundle.roots, resources: bundle.schemas })),
    locate: (resource, pointer) => {
      const component = componentNames.get(resource);
      if (component !== undefined) return componentPlace(locate, component, pointer);
      const operationName = operationRoots.get(resource);
      if (operationName === undefined) return undefined;
      const prefix = `/operations/${escapeJsonPointerToken(operationName)}`;
      return pointer.startsWith(prefix) ? { where: `operation ${JSON.stringify(operationName)} at ${pointer.slice(prefix.length) || '/'}` } : undefined;
    },
  };
}

/**
 * The modules of the client. When the profile validates, `validatorExports` is the name the SDK's validators module
 * exports each operation root under, and each operation module imports its validators from that module.
 */
export function generateClientModules(
  clientName: string,
  operations: readonly NormalizedOperation[],
  document: unknown = {},
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  validation?: { readonly schemas: OperationValidationSchemas; readonly validatorExports: ReadonlyMap<string, string> },
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
  if (profile.validation && !validation) throw new Error('A validating SDK imports its operation validators from the SDK validators module; the caller gives its schemas and exports.');
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
      validation?.schemas.bundles.get(operation.name),
      validation?.validatorExports ?? new Map<string, string>(),
    ));
  }
  const client = emitClient(clientName, operations, profile, plan, rawSecuritySchemes);
  return { client, operations: emittedOperations };
}

