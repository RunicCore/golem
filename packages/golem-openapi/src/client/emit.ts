import type { EmissionPlan } from '../emission-plan.js';
import { mediaFraming } from '../emission-plan.js';
import { compileStandaloneValidatorSet } from '@exprtlabs/golem/ajv-tooling';
import { asRecord, isJsonObject, objectEntries } from '../json.js';
import { identifier, NameScope, propertyName } from '@exprtlabs/golem/generator-api';
import {
  parameterSchema,
  resolveLocal,
  type NormalizedOperation,
} from '../normalize.js';
import { generatedBanner } from '../package-info.js';
import type { OpenApiGenerationProfile } from '../profile.js';
import { requireProfile } from '../profile.js';
import { buildOperationValidationSchemaBundle, buildOperationValidationSchemaBundles, buildSchemaData } from '../schemas.js';
import { textCodecRequirement } from '../types.js';

function routeExpression(operation: NormalizedOperation, use: (name: string) => string): { declarations: string; expression: string } {
  const parameters = new Map(operation.parameters.filter((item) => item.in === 'path').map(item => [item.name, item]));
  const variables = new Map<string, string>();
  const declarations: string[] = [];
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
      declarations.push(`    const ${variable} = ${use('encode')}(${use('serializeContentParameter')}(runtime, input.path[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'path', contentType: ${JSON.stringify(contentType)} }));`);
      continue;
    }
    const style = parameter.style || 'simple';
    const explode = parameter.explode === undefined ? false : parameter.explode;
    declarations.push(`    const ${variable} = ${use('serializePath')}(runtime, ${JSON.stringify(parameter.name)}, input.path[${JSON.stringify(parameter.name)}], ${JSON.stringify(style)}, ${explode});`);
  }
  parts.push(JSON.stringify(operation.route.slice(offset)));
  return { declarations: declarations.join('\n'), expression: parts.join(' + ') };
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

export interface GeneratedClientModules {
  readonly client: string;
  /** Module paths are relative to the generated package root. */
  readonly operations: ReadonlyMap<string, string>;
  readonly standaloneValidators: ReadonlyMap<string, {
    readonly source: string;
    readonly declarations: string;
    readonly notices: string;
  }>;
  readonly sharedSchemas: ReadonlyMap<string, string>;
}

function operationFactoryName(operation: NormalizedOperation): string {
  return `create${identifier(operation.name)}Operation`;
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
  sharedSchemaAliases: readonly { readonly id: string; readonly alias: string }[],
): string {
  const usedFunctions = new Set<string>();
  const use = (name: string): string => {
    usedFunctions.add(name);
    return name;
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
  const queryLines = queryParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return `    if (input.query?.[${JSON.stringify(parameter.name)}] !== undefined) ${use('appendQuery')}(runtime, query, ${JSON.stringify(parameter.name)}, ${use('serializeContentParameter')}(runtime, input.query[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'query', contentType: ${JSON.stringify(contentType)} }), ${parameter.allowReserved === true});`;
    }
    return `    ${use('addQueryParameter')}(runtime, query, ${JSON.stringify(parameter.name)}, input.query?.[${JSON.stringify(parameter.name)}], ${JSON.stringify(parameter.style || 'form')}, ${parameter.explode === undefined ? true : parameter.explode}, ${parameter.allowReserved === true});`;
  });
  const headerLines = headerParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return `    if (input.header?.[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, ${use('serializeContentParameter')}(runtime, input.header[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'header', contentType: ${JSON.stringify(contentType)} }));`;
    }
    return `    if (input.header?.[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, ${use('serializeHeaderSimple')}(runtime, input.header[${JSON.stringify(parameter.name)}], ${parameter.explode === true}));`;
  });
  const cookieLines = cookieParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return `    if (input.cookie?.[${JSON.stringify(parameter.name)}] !== undefined) cookies.push(${JSON.stringify(parameter.name)} + '=' + encodeURIComponent(${use('serializeContentParameter')}(runtime, input.cookie[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'cookie', contentType: ${JSON.stringify(contentType)} })));`;
    }
    if (parameter.style === 'cookie') {
      return `    ${use('addCookieStyleParameter')}(runtime, cookies, ${JSON.stringify(parameter.name)}, input.cookie?.[${JSON.stringify(parameter.name)}], ${parameter.explode === true});`;
    }
    return `    ${use('addCookieParameter')}(runtime, cookies, ${JSON.stringify(parameter.name)}, input.cookie?.[${JSON.stringify(parameter.name)}], ${parameter.explode === undefined ? true : parameter.explode});`;
  });
  const queryStringLine = queryStringParameter
    ? `    ${use('setQueryString')}(runtime, query, input.querystring, { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(queryStringParameter.name)}, in: 'querystring', contentType: ${JSON.stringify(Object.keys(queryStringParameter.content || {})[0] || 'application/x-www-form-urlencoded')} });`
    : '';
  const inputName = profile.validation || operation.parameters.length || requestBody ? 'input' : '_input';
  const factoryName = operationFactoryName(operation);
  if (surfaces.auth || surfaces.mutualTls) use('applySecurity');
  if (requestBody) use('encodeBody');
  const validatesWithSources = profile.validation && validationBundle !== undefined;
  const validationFunctions = !profile.validation ? []
    : validatesWithSources ? ['operationValidators', 'responseCheck', 'validateOperationInput'] : ['validateOperationInput'];
  const runtimeFunctions = [...usedFunctions].sort();
  const defaultAjvEngine = profile.validation && !profile.ajvStandalone;
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
  if (surfaces.auth || surfaces.mutualTls) importedNames.push(['__golemSecuritySchemes', 'security metadata'], ['RuntimeSecuritySchemes', 'security scheme type import']);
  if (profile.validation) importedNames.push(['OperationValidationSources', 'validation source type import']);
  if (defaultAjvEngine) importedNames.push(['createOpenApiAjvEngine', 'default validation engine import']);
  if (profile.ajvStandalone && profile.validation) importedNames.push(['createValidatorSet', 'standalone validator import'], ['RuntimeValidator', 'validator type']);
  if (profile.validation && !profile.ajvStandalone) {
    for (const { alias } of sharedSchemaAliases) importedNames.push([alias, 'validation schema resource import']);
  }
  const moduleScope = new NameScope(`operation ${JSON.stringify(operation.name)}`);
  for (const [name, origin] of importedNames) {
    moduleScope.claim(name, origin);
  }
  moduleScope.claim(operation.name, `operation factory ${JSON.stringify(operation.name)}`);
  moduleScope.claim(factoryName, `internal operation factory ${JSON.stringify(operation.name)}`);
  let validationSourcesName = '__resolveOperationValidationSources';
  let validationSourcesSuffix = 0;
  while (moduleScope.has(validationSourcesName)) {
    validationSourcesSuffix += 1;
    validationSourcesName = `__resolveOperationValidationSources${validationSourcesSuffix}`;
  }
  if (profile.validation && validationBundle) {
    moduleScope.claim(validationSourcesName, 'operation validation source resolver');
  }
  const inputType = `Types.${operation.typeName}OperationInput`;
  const responseType = `Types.${operation.typeName}OperationHttpResponse`;
  const validatorSetup = validatesWithSources
    ? `  const validators = operationValidators(runtime, ${JSON.stringify(operation.name)}, ${validationSourcesName});\n  const checkResponse = responseCheck(validators);`
    : profile.validation ? '  const validators = undefined;' : '';
  const standaloneResponseValidation = validationBundle?.responseReferences.length
    ? `    for (const item of ${JSON.stringify(validationBundle.responseReferences)}) {
      const validator = validatorSet.all[item.reference];
      if (!validator) throw new LibError(LibErrorKind.ValidationUnavailable, \`Runtime validator could not compile operation response: ${JSON.stringify(operation.name)} \${item.status} \${item.contentType}\`);
      responses.set(\`\${item.status}:\${item.contentType}\`, validator);
    }`
    : '';
  const validationSources = profile.validation && validationBundle
    ? [
      `const ${validationSourcesName} = (): OperationValidationSources => ({`,
      `  inputReference: ${JSON.stringify(validationBundle.inputReference)},`,
      `  responseReferences: ${JSON.stringify(validationBundle.responseReferences)},`,
      '  schemas: new Map([',
      ...(profile.ajvStandalone ? [] : [
        `    [${JSON.stringify(validationBundle.operationRootId)}, JSON.parse(${JSON.stringify(JSON.stringify(validationBundle.operationSchema))}) as object | boolean],`,
        ...sharedSchemaAliases.map(({ id, alias }) => `    [${JSON.stringify(id)}, ${alias}],`),
      ]),
      '  ]),',
      ...(profile.ajvStandalone ? [
        '  standaloneValidators: () => {',
        '    const validatorSet = createValidatorSet();',
        `    const input = validatorSet.all[${JSON.stringify(validationBundle.inputReference)}];`,
        `    if (!input) throw new LibError(LibErrorKind.ValidationUnavailable, ${JSON.stringify(`Runtime validator could not compile operation input: ${operation.name}`)});`,
        '    const responses = new Map<string, RuntimeValidator>();',
        standaloneResponseValidation,
        '    return { input, responses };',
        '  },',
      ] : []),
      '});',
    ].filter(Boolean).join('\n')
    : '';
  const operationSchemaImports = profile.validation && !profile.ajvStandalone
    ? sharedSchemaAliases.map(({ id: _id, alias }, index) => {
      const resource = validationBundle?.sharedResources[index];
      if (!resource) return '';
      const modulePath = `../${resource.moduleName.replace(/\.ts$/, '.js')}`;
      return `import { schema as ${alias} } from ${JSON.stringify(modulePath)};`;
    }).filter(Boolean).join('\n')
    : '';
  const runtimeImports = [
    `import { ClientRuntime${runtimeFunctions.map(name => `, ${name}`).join('')}${profile.mobx ? '' : ', createApiOperation, type ApiOperation'}, type RuntimeResponseContract${surfaces.auth || surfaces.mutualTls ? ', type RuntimeSecuritySchemes' : ''}${profile.validation ? ', type OperationValidationSources' : ''} } from '@exprtlabs/golem/client';`,
    `import type { ${clientName}ClientOptions as ClientOptions, ${clientName}RequestOptions as RequestOptions } from '../client.js';`,
    `import type * as Types from '../types.js';`,
    profile.mobx
      ? `import { createObservableApiOperation as createApiOperation, type ObservableApiOperation as ApiOperation } from '@exprtlabs/golem/mobx';`
      : '',
    defaultAjvEngine ? `import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';` : '',
    profile.ajvStandalone && profile.validation
      ? `import { createValidatorSet } from './${operation.name}.validators.generated.js';`
      : '',
    profile.validation && profile.ajvStandalone
      ? `import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';`
      : '',
    validationFunctions.length
      ? `import { ${validationFunctions.join(', ')}${profile.ajvStandalone ? ', type RuntimeValidator' : ''} } from '@exprtlabs/golem/validation';`
      : '',
    operationSchemaImports,
  ].filter(Boolean).join('\n');
  const securityDeclaration = surfaces.auth || surfaces.mutualTls
    ? `export const __golemSecuritySchemes = ${JSON.stringify(securitySchemes, null, 2)} as const;\nconst securitySchemes: RuntimeSecuritySchemes = __golemSecuritySchemes;`
    : '';
  const securityCall = plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls
    ? `    await ${use('applySecurity')}(runtime, ${security}, query, headers, cookies, securitySchemes);`
    : '';
  const usesQuery = queryLines.length > 0 || queryStringLine !== '' || securityCall !== '';
  const usesCookies = cookieLines.length > 0 || securityCall !== '';
  const bodyLines = [
    profile.validation ? `    await validateOperationInput(${JSON.stringify(operation.name)}, input, validators);` : '',
    usesQuery ? '    const query: string[] = [];' : '',
    ...queryLines,
    queryStringLine,
    '    const headers = new Headers(runtime.defaultHeaders);',
    ...headerLines,
    usesCookies ? '    const cookies: string[] = [];' : '',
    ...cookieLines,
    securityCall,
    usesCookies ? "    if (cookies.length) headers.set('Cookie', cookies.join('; '));" : '',
    requestBody ? `    const encodedBody = ${use('encodeBody')}(runtime, ${JSON.stringify(operation.name)}, ${bodyValue}, ${bodyContentType}, ${bodyEncodings});\n    if (encodedBody.contentType) headers.set('Content-Type', encodedBody.contentType);` : '',
    route.declarations,
    '    const request: RequestInit = {',
    `      method: ${JSON.stringify(operation.method)},`,
    '      headers,',
    '    };',
    '    if (options.signal !== undefined) request.signal = options.signal;',
    requestBody ? '    if (encodedBody.body !== undefined) request.body = encodedBody.body;' : '',
    `    const response = await runtime.fetchImpl(runtime.url(${route.expression}, ${usesQuery ? 'query' : '[]'}), request);`,
    `    return runtime.readResponse<${responseType}>(`,
    `      ${JSON.stringify(operation.name)},`,
    '      response,',
    `      responseContracts,${validatesWithSources ? '\n      checkResponse,' : ''}`,
    '    );',
  ].filter(line => line.trim() !== '');
  const body = `  return createApiOperation(${JSON.stringify(operation.name)}, async (${inputName}: ${inputType}, options: RequestOptions = {}): Promise<${responseType}> => {
${bodyLines.join('\n')}
  });`;

  return `${[
    generatedBanner().trimEnd(),
    runtimeImports,
    '',
    securityDeclaration,
    `const responseContracts: readonly RuntimeResponseContract[] = ${JSON.stringify(responseContracts)};`,
    validationSources,
  ].filter((part, index) => part !== '' || index === 2).join('\n')}

export function ${operation.name}(options: ClientOptions): ApiOperation<${inputType}, ${responseType}, RequestOptions> {
  return ${factoryName}(new ClientRuntime(${JSON.stringify(clientName)}, options${defaultAjvEngine ? ', { createValidationEngine: createOpenApiAjvEngine }' : ''}));
}

export function ${factoryName}(runtime: ClientRuntime): ApiOperation<${inputType}, ${responseType}, RequestOptions> {
${validatorSetup ? `${validatorSetup}\n` : ''}${body}
}
`;
}

function emitSecurityTypes(
  clientName: string,
  rawSecuritySchemes: Readonly<Record<string, unknown>>,
): string {
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
  if (!entries.length) return '';

  return `export type ${clientName}AuthContext = Runtime.AuthContext;

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
> = Runtime.TokenAuthValue<Context>;

export type ${clientName}BasicCredentials = Runtime.BasicCredentials;
export type ${clientName}BasicAuthValue<
  Context extends ${clientName}AuthContext = ${clientName}AuthContext,
> = Runtime.BasicAuthValue<Context>;

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
  const defaultAjvEngine = profile.validation && !profile.ajvStandalone;
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
  if (defaultAjvEngine) scope.claim('createOpenApiAjvEngine', 'default validation engine import');
  if (profile.validation) {
    scope.claim('__GolemOperationName', 'operation name type import');
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
  const methods = operations.map((operation) =>
    `  ${operation.name}(): ApiOperation<Types.${operation.typeName}OperationInput, Types.${operation.typeName}OperationHttpResponse, ${clientName}RequestOptions>;`,
  ).join('\n');
  const implementations = operations.map((operation) =>
    `  ${operation.name}(): ApiOperation<Types.${operation.typeName}OperationInput, Types.${operation.typeName}OperationHttpResponse, ${clientName}RequestOptions> {
    return ${aliases.get(operation.name)}(this.runtime);
  }`,
  ).join('\n\n');
  const undeclared = plan.helpers.has('selectResponse');
  const usesAuth = surfaces.auth || surfaces.mutualTls;
  const optionExtensions = [
    ...(surfaces.auth ? [`  /** Values or lazy providers keyed by OpenAPI security-scheme name. */\n  auth?: ${clientName}Auth;`] : []),
    ...(profile.validation ? ['  /** Overrides generated validators for individual operations. */\n  operationValidators?: ReadonlyMap<__GolemOperationName, __GolemOperationRuntimeValidators>;'] : []),
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
    ...(profile.validation ? [] : ['validationEngine']),
  ];
  const optionsType = `Omit<Runtime.ClientOptions, ${omittedOptions.map((name) => JSON.stringify(name)).join(' | ')}>${optionExtensions.length ? ` & {\n${optionExtensions.join('\n')}\n}` : ''}`;
  const aliases_ = [
    `export type ${clientName}ClientOptions = ${optionsType};`,
    `export type ${clientName}RequestOptions = Runtime.RequestOptions;`,
    ...(undeclared ? [
      `export type ${clientName}UndeclaredResponseError = Runtime.UndeclaredResponseError;`,
      `export function is${clientName}UndeclaredResponseError(error: unknown): error is Runtime.UndeclaredResponseError {\n  return isUndeclaredResponseError(error, ${JSON.stringify(clientName)});\n}`,
    ] : []),
    ...(surfaces.mutualTls ? [`export type ${clientName}MutualTlsTransport = Runtime.MutualTlsTransport;`] : []),
    ...(surfaces.streamDecoders ? [
      `export type ${clientName}StreamDecoderContext = Runtime.StreamDecoderContext;`,
      `export type ${clientName}StreamDecoder = Runtime.StreamDecoder;`,
    ] : []),
    ...(surfaces.parameterSerializers ? [
      `export type ${clientName}ParameterSerializerContext = Runtime.ParameterSerializerContext;`,
      `export type ${clientName}ParameterSerializer = Runtime.ParameterSerializer;`,
    ] : []),
    ...(surfaces.responseHeaderDecoders ? [
      `export type ${clientName}ResponseHeaderDecoderContext = Runtime.ResponseHeaderDecoderContext;`,
      `export type ${clientName}ResponseHeaderDecoder = Runtime.ResponseHeaderDecoder;`,
    ] : []),
    ...(surfaces.bodyEncoders ? [
      `export type ${clientName}EncodedBody = Runtime.EncodedBody;`,
      `export type ${clientName}EncodingMetadata = Runtime.EncodingMetadata;`,
      `export type ${clientName}BodyEncoderContext = Runtime.BodyEncoderContext;`,
      `export type ${clientName}BodyEncoder = Runtime.BodyEncoder;`,
    ] : []),
  ].join('\n');
  const runtimeValueImports = ['ClientRuntime', ...(undeclared ? ['isUndeclaredResponseError'] : [])];
  return `${generatedBanner()}
import { ${runtimeValueImports.join(', ')} } from '@exprtlabs/golem/client';
import type * as Runtime from '@exprtlabs/golem/client';
${defaultAjvEngine ? "import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';\n" : ''}${profile.validation ? "import type { OperationRuntimeValidators as __GolemOperationRuntimeValidators } from '@exprtlabs/golem/validation';\nimport type { OperationName as __GolemOperationName } from './schemas.js';\n" : ''}import type * as Types from './types.js';
${profile.mobx
    ? "import type { ObservableApiOperation as ApiOperation } from '@exprtlabs/golem/mobx';"
    : "import type { ApiOperation } from '@exprtlabs/golem/client';"}
${imports}

${aliases_}
${usesAuth ? `\n${emitSecurityTypes(clientName, rawSecuritySchemes)}` : ''}
export interface ${clientName}ClientPort {
${methods}
}

export class ${clientName}Client implements ${clientName}ClientPort {
  private readonly runtime: ClientRuntime;

  constructor(options: ${clientName}ClientOptions) {
    this.runtime = new ClientRuntime(${JSON.stringify(clientName)}, options${defaultAjvEngine ? ', { createValidationEngine: createOpenApiAjvEngine }' : ''});
  }

${implementations}
}
${metadata}
`;
}

export function generateClientModules(
  clientName: string,
  operations: readonly NormalizedOperation[],
  document: unknown = {},
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  schemaData?: ReturnType<typeof buildSchemaData>,
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
  const validationBundles = profile.validation
    ? buildOperationValidationSchemaBundles(document, operations, schemaData)
    : new Map<string, ReturnType<typeof buildOperationValidationSchemaBundle>>();
  const sharedSchemas = new Map<string, string>();
  if (profile.validation && !profile.ajvStandalone) {
    for (const bundle of validationBundles.values()) {
      for (const resource of bundle.sharedResources) {
        const previous = sharedSchemas.get(resource.moduleName);
        if (previous !== undefined && previous !== resource.source) {
          throw new Error(`Conflicting generated validation schema module: ${resource.moduleName}`);
        }
        sharedSchemas.set(resource.moduleName, resource.source);
      }
    }
  }
  const standaloneValidators = new Map<string, { source: string; declarations: string; notices: string }>();
  if (profile.validation && profile.ajvStandalone) {
    for (const operation of operations) {
      const bundle = validationBundles.get(operation.name);
      if (!bundle) throw new Error(`Missing generated validation schema bundle for operation ${operation.name}`);
      const compiled = compileStandaloneValidatorSet({
        schemas: bundle.schemas,
        references: [bundle.inputReference, ...bundle.responseReferences.map((item) => item.reference)],
        owner: '@exprtlabs/golem-openapi',
      });
      standaloneValidators.set(`operations/${operation.name}.validators.generated.js`, {
        source: compiled.code,
        declarations: compiled.declarations,
        notices: compiled.notices,
      });
    }
  }

  const emittedOperations = new Map<string, string>();
  for (const operation of operations) {
    const operationSchemes = operationSecuritySchemeData(operation, securitySchemes);
    const bundle = validationBundles.get(operation.name);
    const schemaAliases = (bundle?.sharedResources ?? []).map((resource, index) => ({
      id: resource.id,
      alias: `__golemSchema${index}`,
    }));
    emittedOperations.set(`operations/${operation.name}.ts`, operationSource(
      clientName,
      operation,
      document,
      profile,
      plan,
      responseContractsForOperation(document, operation),
      operationSchemes,
      bundle,
      schemaAliases,
    ));
  }
  const client = emitClient(clientName, operations, profile, plan, rawSecuritySchemes);
  return { client, operations: emittedOperations, standaloneValidators, sharedSchemas };
}

