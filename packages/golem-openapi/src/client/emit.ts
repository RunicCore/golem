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
  legacyText,
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
import { generatedBanner } from '../package-info.js';
import type { OpenApiGenerationProfile } from '../profile.js';
import { requireProfile } from '../profile.js';
import { buildOperationValidationSchemaBundle, buildOperationValidationSchemaBundles, buildSchemaData } from '../schemas.js';
import { textCodecRequirement } from '../types.js';

/** A client runtime function: the name is a key of the client module, so a misspelled name is a type error. */
type ClientFunction = keyof typeof rt.client;

/** The tag of the templates of this file: the text between the values is code, and a value that is not Code is text of this file. */
function text(strings: TemplateStringsArray, ...values: readonly (string | number | boolean | Code)[]): Code {
  return code(strings, ...values.map((value) => typeof value === 'object' ? value : legacyText(String(value))));
}

const BLANK = code``;

function routeExpression(operation: NormalizedOperation, use: (name: ClientFunction) => Code): { declarations: Code; expression: string } {
  const parameters = new Map(operation.parameters.filter((item) => item.in === 'path').map(item => [item.name, item]));
  const variables = new Map<string, string>();
  const declarations: Code[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const match of operation.route.matchAll(/\{([^{}]+)\}/g)) {
    const parameter = parameters.get(match[1] ?? '');
    if (!parameter) continue;
    parts.push(JSON.stringify(operation.route.slice(offset, match.index)));
    offset = match.index + match[0].length;
    const previous = variables.get(parameter.name);
    if (previous) { parts.push(previous); continue; }
    const variable = `pathValue${variables.size}`;
    variables.set(parameter.name, variable);
    parts.push(variable);
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      declarations.push(text`    const ${variable} = ${use('encode')}(${use('serializeContentParameter')}(runtime, input.path[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'path', contentType: ${JSON.stringify(contentType)} }));`);
      continue;
    }
    const style = parameter.style || 'simple';
    const explode = parameter.explode === undefined ? false : parameter.explode;
    declarations.push(text`    const ${variable} = ${use('serializePath')}(runtime, ${JSON.stringify(parameter.name)}, input.path[${JSON.stringify(parameter.name)}], ${JSON.stringify(style)}, ${explode});`);
  }
  parts.push(JSON.stringify(operation.route.slice(offset)));
  return { declarations: join(declarations, code`\n`), expression: parts.join(' + ') };
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

function literalType(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value) ?? 'unknown';
  }
  if (Array.isArray(value)) {
    return `readonly [${value.map(literalType).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([name, child]) => `readonly ${propertyName(name)}: ${literalType(child)}`).join('; ')} }`;
  }
  return 'unknown';
}

interface GeneratedClientModules {
  readonly client: string;
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
  const bodyValue = operation.requestContent.length > 1 ? 'input.body?.value' : 'input.body';
  const bodyContentType = operation.requestContent.length > 1
    ? 'input.body?.contentType'
    : JSON.stringify(singleContentType);
  const bodyEncodings = JSON.stringify(Object.fromEntries(
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
  const security = JSON.stringify(operation.security || []);
  const surfaces = plan.clientSurfaces;
  // An empty effective requirement list (an operation-level `security: []` or no
  // security anywhere) is a no-op in applySecurity, so the call is not emitted.
  const appliesSecurity = (surfaces.auth || surfaces.mutualTls) && operation.security.length > 0;
  const queryLines = queryParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return text`    if (input.query?.[${JSON.stringify(parameter.name)}] !== undefined) ${use('appendQuery')}(runtime, query, ${JSON.stringify(parameter.name)}, ${use('serializeContentParameter')}(runtime, input.query[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'query', contentType: ${JSON.stringify(contentType)} }), ${parameter.allowReserved === true});`;
    }
    return text`    ${use('addQueryParameter')}(runtime, query, ${JSON.stringify(parameter.name)}, input.query?.[${JSON.stringify(parameter.name)}], ${JSON.stringify(parameter.style || 'form')}, ${parameter.explode === undefined ? true : parameter.explode}, ${parameter.allowReserved === true});`;
  });
  const headerLines = headerParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return text`    if (input.header?.[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, ${use('serializeContentParameter')}(runtime, input.header[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'header', contentType: ${JSON.stringify(contentType)} }));`;
    }
    return text`    if (input.header?.[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, ${use('serializeHeaderSimple')}(runtime, input.header[${JSON.stringify(parameter.name)}], ${parameter.explode === true}));`;
  });
  const cookieLines = cookieParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return text`    if (input.cookie?.[${JSON.stringify(parameter.name)}] !== undefined) cookies.push(${JSON.stringify(parameter.name)} + '=' + encodeURIComponent(${use('serializeContentParameter')}(runtime, input.cookie[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'cookie', contentType: ${JSON.stringify(contentType)} })));`;
    }
    if (parameter.style === 'cookie') {
      return text`    ${use('addCookieStyleParameter')}(runtime, cookies, ${JSON.stringify(parameter.name)}, input.cookie?.[${JSON.stringify(parameter.name)}], ${parameter.explode === true});`;
    }
    return text`    ${use('addCookieParameter')}(runtime, cookies, ${JSON.stringify(parameter.name)}, input.cookie?.[${JSON.stringify(parameter.name)}], ${parameter.explode === undefined ? true : parameter.explode});`;
  });
  const queryStringLine = queryStringParameter
    ? text`    ${use('setQueryString')}(runtime, query, input.querystring, { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(queryStringParameter.name)}, in: 'querystring', contentType: ${JSON.stringify(Object.keys(queryStringParameter.content || {})[0] || 'application/x-www-form-urlencoded')} });`
    : BLANK;
  const inputName = profile.validation || operation.parameters.length || requestBody ? 'input' : '_input';
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
  const validationSourcesName = uniqueModuleName('__operationValidationSources', 'operation validation sources');
  const typesModule = new ImportSource('../types.js', true, { namespace: 'Types' });
  const inputType = code`${typesModule.namespace()}.${identifierPart(`${operation.typeName}OperationInput`)}`;
  const responseType = code`${typesModule.namespace()}.${identifierPart(`${operation.typeName}OperationHttpResponse`)}`;
  const validatorSetup = validatesWithSources
    ? text`  const validators = ${rt.validation.operationValidators}(runtime, ${JSON.stringify(operation.name)}, ${validationSourcesName});\n  const checkResponse = ${rt.validation.responseCheck}(validators);`
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
      text`const ${validationSourcesName}: ${rtType.client.OperationValidationSources} = {`,
      text`  input: ${validatorNames[0]},`,
      text`  responses: [${join(validationBundle.responseReferences.map((item, index) => text`{ status: ${JSON.stringify(item.status)}, contentType: ${JSON.stringify(item.contentType)}, validator: ${validatorNames[index + 1]} }`), code`, `)}],`,
      code`};`,
    ], code`\n`)
    : BLANK;
  const securitySchemesType = rtType.client.RuntimeSecuritySchemes;
  // The client module imports `__golemSecuritySchemes` from every operation module.
  const securityDeclaration = surfaces.auth || surfaces.mutualTls
    ? text`export const __golemSecuritySchemes = ${JSON.stringify(securitySchemes, null, 2)} as const;${appliesSecurity ? text`\nconst securitySchemes: ${securitySchemesType} = __golemSecuritySchemes;` : BLANK}`
    : BLANK;
  const securityCall = appliesSecurity
    ? text`    await ${use('applySecurity')}(runtime, ${security}, query, headers, cookies, securitySchemes);`
    : BLANK;
  const usesQuery = queryLines.length > 0 || queryStringLine.parts.length > 0 || securityCall.parts.length > 0;
  const usesCookies = cookieLines.length > 0 || securityCall.parts.length > 0;
  const bodyLines = [
    profile.validation ? text`    await ${rt.validation.validateOperationInput}(${JSON.stringify(operation.name)}, input, validators);` : BLANK,
    usesQuery ? text`    const query: string[] = [];` : BLANK,
    ...queryLines,
    queryStringLine,
    text`    const headers = new Headers(runtime.defaultHeaders);`,
    ...headerLines,
    usesCookies ? text`    const cookies: string[] = [];` : BLANK,
    ...cookieLines,
    securityCall,
    usesCookies ? text`    if (cookies.length) headers.set('Cookie', cookies.join('; '));` : BLANK,
    requestBody ? text`    const encodedBody = ${use('encodeBody')}(runtime, ${JSON.stringify(operation.name)}, ${bodyValue}, ${bodyContentType}, ${bodyEncodings});\n    if (encodedBody.contentType) headers.set('Content-Type', encodedBody.contentType);` : BLANK,
    route.declarations,
    text`    const request: RequestInit = {`,
    text`      method: ${JSON.stringify(operation.method)},`,
    text`      headers,`,
    text`    };`,
    text`    if (options.signal !== undefined) request.signal = options.signal;`,
    requestBody ? text`    if (encodedBody.body !== undefined) request.body = encodedBody.body;` : BLANK,
    text`    const response = await runtime.fetchImpl(runtime.url(${route.expression}, ${usesQuery ? 'query' : '[]'}), request);`,
    text`    return runtime.readResponse<${responseType}>(`,
    text`      ${JSON.stringify(operation.name)},`,
    text`      response,`,
    text`      responseContracts,${validatesWithSources ? '\n      checkResponse,' : ''}`,
    text`    );`,
  ].filter(line => line.parts.length > 0);
  const body = text`  return ${createApiOperation}(${JSON.stringify(operation.name)}, async (${inputName}: ${inputType}, options: ${requestOptions} = {}): Promise<${responseType}> => {
${join(bodyLines, code`\n`)}
  });`;
  const declarations = join([
    securityDeclaration,
    text`const responseContracts: readonly ${rtType.client.RuntimeResponseContract}[] = ${JSON.stringify(responseContracts)};`,
    validationSources,
  ].filter((part) => part.parts.length > 0), code`\n`);
  const functions = text`export function ${operation.name}(options: ${clientOptions}): ${apiOperation}<${inputType}, ${responseType}, ${requestOptions}> {
  return ${factoryName}(new ${clientRuntime}(${JSON.stringify(clientName)}, options));
}

export function ${factoryName}(runtime: ${clientRuntime}): ${apiOperation}<${inputType}, ${responseType}, ${requestOptions}> {
${validatorSetup.parts.length > 0 ? text`${validatorSetup}\n` : BLANK}${body}
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
    legacyText(generatedBanner().trimEnd()),
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
  const schemeNames = entries.map(([name]) => JSON.stringify(name));
  const nameType = schemeNames.length ? schemeNames.join(' | ') : 'never';
  const flowCases = contextSchemes.map(([name, scheme]) =>
    `  Name extends ${JSON.stringify(name)} ? ${literalType(asRecord(scheme).flows)} :`,
  );
  const urlCases = contextSchemes.map(([name, scheme]) =>
    `  Name extends ${JSON.stringify(name)} ? ${literalType(asRecord(scheme).openIdConnectUrl)} :`,
  );
  const contexts = contextSchemes.map(([name, scheme]) => {
    const record = asRecord(scheme);
    const scopes = [...new Set(
      Object.values(asRecord(record.flows)).flatMap((flow) =>
        Object.keys(asRecord(asRecord(flow).scopes)),
      ),
    )];
    const scopeType = scopes.length
      ? `readonly (${scopes.map((scope) => JSON.stringify(scope)).join(' | ')})[]`
      : 'readonly string[]';
    return `export type ${clientName}${identifier(name)}Context =
  Omit<${clientName}AuthContext, 'scheme' | 'type' | 'scopes' | 'flows' | 'openIdConnectUrl'> & {
    readonly scheme: ${JSON.stringify(name)};
    readonly type: ${JSON.stringify(record.type)};
    readonly scopes: ${scopeType};
    readonly flows: ${clientName}SecuritySchemeFlows<${JSON.stringify(name)}>;
    readonly openIdConnectUrl: ${clientName}SecuritySchemeOpenIdConnectUrl<${JSON.stringify(name)}>;
  };`;
  });
  const properties = contextSchemes.map(([name, scheme]) => {
    const record = asRecord(scheme);
    const contextType = `${clientName}${identifier(name)}Context`;
    const valueType = record.type === 'http' && String(record.scheme).toLowerCase() === 'basic'
      ? `${clientName}BasicAuthValue<${contextType}>`
      : `${clientName}TokenAuthValue<${contextType}>`;
    return `  ${propertyName(name)}?: ${valueType};`;
  });
  if (!entries.length) return BLANK;

  return text`export type ${clientName}AuthContext = ${runtime}.AuthContext;

export type ${clientName}SecuritySchemeName = ${nameType};

export type ${clientName}SecuritySchemeFlows<
  Name extends ${clientName}SecuritySchemeName,
> =
${flowCases.length
    ? `${flowCases.join('\n')}  undefined;`
    : `  Name extends ${clientName}SecuritySchemeName ? undefined : never;`}

export type ${clientName}SecuritySchemeOpenIdConnectUrl<
  Name extends ${clientName}SecuritySchemeName,
> =
${urlCases.length
    ? `${urlCases.join('\n')}  undefined;`
    : `  Name extends ${clientName}SecuritySchemeName ? undefined : never;`}

${contexts.join('\n\n')}

export type ${clientName}TokenAuthValue<
  Context extends ${clientName}AuthContext = ${clientName}AuthContext,
> = ${runtime}.TokenAuthValue<Context>;

export type ${clientName}BasicCredentials = ${runtime}.BasicCredentials;
export type ${clientName}BasicAuthValue<
  Context extends ${clientName}AuthContext = ${clientName}AuthContext,
> = ${runtime}.BasicAuthValue<Context>;

export interface ${clientName}Auth {
${properties.join('\n')}
}
`;
}

function emitClient(
  clientName: string,
  operations: readonly NormalizedOperation[],
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  rawSecuritySchemes: Readonly<Record<string, unknown>>,
): string {
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
  const imports = operations.map((operation) => {
    const names = [`${operationFactoryName(operation)} as ${aliases.get(operation.name)}`];
    const securityAlias = securityAliases.get(operation.name);
    if (securityAlias) names.push(`__golemSecuritySchemes as ${securityAlias}`);
    return `import { ${names.join(', ')} } from ${JSON.stringify(`./operations/${operation.name}.js`)};`;
  }).join('\n');
  const metadata = plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls
    ? `export const ${metadataName} = {
${[...securityAliases.values()].map((alias) => `  ...${alias},`).join('\n')}
} as const;`
    : '';
  const clientRuntime = rt.client.ClientRuntime;
  const runtimeTypes = new ImportSource('@exprtlabs/golem/client', true, { namespace: 'Runtime' });
  const typesModule = new ImportSource('./types.js', true, { namespace: 'Types' });
  const runtimeNamespace = runtimeTypes.namespace();
  const typesNamespace = typesModule.namespace();
  const inputTypeOf = (operation: NormalizedOperation): Code => code`${typesNamespace}.${identifierPart(`${operation.typeName}OperationInput`)}`;
  const responseTypeOf = (operation: NormalizedOperation): Code => code`${typesNamespace}.${identifierPart(`${operation.typeName}OperationHttpResponse`)}`;
  const apiOperation = profile.mobx ? aliased(rtType.mobx.ObservableApiOperation, 'ApiOperation') : rtType.client.ApiOperation;
  const methods = join(operations.map((operation) =>
    text`  ${operation.name}(): ${apiOperation}<${inputTypeOf(operation)}, ${responseTypeOf(operation)}, ${clientName}RequestOptions>;`,
  ), code`\n`);
  const implementations = join(operations.map((operation) =>
    text`  ${operation.name}(): ${apiOperation}<${inputTypeOf(operation)}, ${responseTypeOf(operation)}, ${clientName}RequestOptions> {
    return ${String(aliases.get(operation.name))}(this.runtime);
  }`,
  ), code`\n\n`);
  const undeclared = plan.helpers.has('selectResponse');
  const usesAuth = surfaces.auth || surfaces.mutualTls;
  const optionExtensions: Code[] = [
    ...(surfaces.auth ? [legacyText(`  /** Values or lazy providers keyed by OpenAPI security-scheme name. */\n  auth?: ${clientName}Auth;`)] : []),
    ...(profile.validation ? [text`  /** Overrides generated validators for individual operations. */\n  operationValidators?: ReadonlyMap<__GolemOperationName, ${aliased(rtType.validation.OperationRuntimeValidators, '__GolemOperationRuntimeValidators')}>;`] : []),
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
  const optionsType = text`Omit<${runtimeNamespace}.ClientOptions, ${omittedOptions.map((name) => JSON.stringify(name)).join(' | ')}>${optionExtensions.length ? text` & {\n${join(optionExtensions, code`\n`)}\n}` : ''}`;
  const aliases_ = join([
    text`export type ${clientName}ClientOptions = ${optionsType};`,
    text`export type ${clientName}RequestOptions = ${runtimeNamespace}.RequestOptions;`,
    ...(undeclared ? [
      text`export type ${clientName}UndeclaredResponseError = ${runtimeNamespace}.UndeclaredResponseError;`,
      text`export function is${clientName}UndeclaredResponseError(error: unknown): error is ${runtimeNamespace}.UndeclaredResponseError {\n  return ${rt.client.isUndeclaredResponseError}(error, ${JSON.stringify(clientName)});\n}`,
    ] : []),
    ...(surfaces.mutualTls ? [text`export type ${clientName}MutualTlsTransport = ${runtimeNamespace}.MutualTlsTransport;`] : []),
    ...(surfaces.streamDecoders ? [
      text`export type ${clientName}StreamDecoderContext = ${runtimeNamespace}.StreamDecoderContext;`,
      text`export type ${clientName}StreamDecoder = ${runtimeNamespace}.StreamDecoder;`,
    ] : []),
    ...(surfaces.parameterSerializers ? [
      text`export type ${clientName}ParameterSerializerContext = ${runtimeNamespace}.ParameterSerializerContext;`,
      text`export type ${clientName}ParameterSerializer = ${runtimeNamespace}.ParameterSerializer;`,
    ] : []),
    ...(surfaces.responseHeaderDecoders ? [
      text`export type ${clientName}ResponseHeaderDecoderContext = ${runtimeNamespace}.ResponseHeaderDecoderContext;`,
      text`export type ${clientName}ResponseHeaderDecoder = ${runtimeNamespace}.ResponseHeaderDecoder;`,
    ] : []),
    ...(surfaces.bodyEncoders ? [
      text`export type ${clientName}EncodedBody = ${runtimeNamespace}.EncodedBody;`,
      text`export type ${clientName}EncodingMetadata = ${runtimeNamespace}.EncodingMetadata;`,
      text`export type ${clientName}BodyEncoderContext = ${runtimeNamespace}.BodyEncoderContext;`,
      text`export type ${clientName}BodyEncoder = ${runtimeNamespace}.BodyEncoder;`,
    ] : []),
  ].map((item) => typeof item === 'string' ? legacyText(item) : item), code`\n`);
  const rest = text`${imports}
${profile.validation ? `\n${operationNameType('__GolemOperationName', operations)}\n` : ''}
${aliases_}
${usesAuth ? text`\n${emitSecurityTypes(clientName, rawSecuritySchemes, runtimeNamespace)}` : ''}
export interface ${clientName}ClientPort {
${methods}
}

export class ${clientName}Client implements ${clientName}ClientPort {
  private readonly runtime: ${clientRuntime};

  constructor(options: ${clientName}ClientOptions) {
    this.runtime = new ${clientRuntime}(${JSON.stringify(clientName)}, options);
  }

${implementations}
}
${metadata}
`;
  const imports_: ImportOptions = { modules: ['client', 'mobx', 'validation'] };
  const runtime = new Map(importSet(rest, imports_).map((entry) => [entry.module, entry] as const));
  const lines = (module: 'client' | 'mobx' | 'validation', parts: { readonly values?: true; readonly types?: true }): readonly Code[] => {
    const entry = runtime.get(module);
    return entry ? importLines({ module, names: parts.values ? entry.names : [], types: parts.types ? entry.types : [] }, imports_) : [];
  };
  return render(code`${join([
    legacyText(generatedBanner()),
    ...lines('client', { values: true }),
    ...fileImports(rest, [runtimeTypes], { elsewhere: [typesModule] }),
    ...lines('validation', { types: true }),
    ...fileImports(rest, [typesModule], { elsewhere: [runtimeTypes] }),
    ...lines('mobx', { types: true }),
    ...(profile.mobx ? [] : lines('client', { types: true })),
  ], code`\n`)}
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

