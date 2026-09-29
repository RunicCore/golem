import type { EmissionPlan } from '../emission-plan.js';
import { mediaFraming } from '../emission-plan.js';
import { compileStandaloneValidatorSet } from '@exprtlabs/codegen/ajv-tooling';
import { asRecord, isJsonObject, objectEntries } from '../json.js';
import { identifier, NameScope, propertyName } from '@exprtlabs/codegen/generator-api';
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
import { emitAuthMethods } from './auth.js';
import { emitCodecMethods } from './codecs.js';
import { emitStreamMethods } from './streams.js';
import { emitTransportMethods } from './transport.js';

function routeExpression(operation: NormalizedOperation, receiver: string): { declarations: string; expression: string } {
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
      declarations.push(`    const ${variable} = ${receiver}.encode(${receiver}.serializeContentParameter(input.path[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'path', contentType: ${JSON.stringify(contentType)} }));`);
      continue;
    }
    const style = parameter.style || 'simple';
    const explode = parameter.explode === undefined ? false : parameter.explode;
    declarations.push(`    const ${variable} = ${receiver}.serializePath(${JSON.stringify(parameter.name)}, input.path[${JSON.stringify(parameter.name)}], ${JSON.stringify(style)}, ${explode});`);
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

function emitValidationHelpers(): string {
  return `
  public async assertValid(
    validator: RuntimeValidator | undefined,
    value: unknown,
  ): Promise<void> {
    if (!validator) return;
    try {
      const result = await runValidation(validator, value);
      if (!result.valid) {
        throw new LibError(LibErrorKind.Validation, 'API data validation failed.', issuesFromErrors(result.errors, value, IssueSource.OpenAPI, IssueRepresentation.Wire));
      }
    } catch (error) {
      if (error instanceof LibError) throw error;
      throw new LibError(LibErrorKind.Validation, 'API data validation could not finish.', [], { cause: error, causedByInput: false });
    }
  }

  public validateOperationInput(
    operation: OperationName,
    value: unknown,
    validators: OperationRuntimeValidators | undefined,
  ): Promise<void> {
    const validator = validators?.input;
    if (!validator) throw new LibError(LibErrorKind.ValidationUnavailable, \`Missing generated input validator for \${operation}\`);
    return this.assertValid(validator, value);
  }

  public responseValidator(
    _operation: OperationName,
    selected: { status: string; contentType: string | null },
    validators: OperationRuntimeValidators | undefined,
  ): RuntimeValidator | undefined {
    if (!validators || selected.contentType === null) return undefined;
    return validators.responses.get(\`\${selected.status}:\${selected.contentType}\`);
  }

  public getOperationValidators(
    operation: OperationName,
    resolveSources: () => OperationValidationSources,
  ): OperationRuntimeValidators {
    const cached = this.operationValidatorCache.get(operation);
    if (cached) return cached;
    const override = this.operationValidatorOverrides?.get(operation);
    if (override) {
      this.operationValidatorCache.set(operation, override);
      return override;
    }

    const sources = resolveSources();
    if (sources.standaloneValidators) {
      const resolved = sources.standaloneValidators();
      this.operationValidatorCache.set(operation, resolved);
      return resolved;
    }
    const engine = this.validationEngine;
    if (!engine) {
      throw new LibError(LibErrorKind.ValidationUnavailable, \`Missing validation engine for operation \${operation}\`);
    }
    for (const [id, schema] of sources.schemas) {
      if (!engine.getSchema(id)) engine.addSchema(schema, id);
    }
    const input = engine.getSchema(sources.inputReference);
    if (!input) {
      throw new LibError(LibErrorKind.ValidationUnavailable, \`Runtime validator could not compile operation input: \${operation}\`);
    }
    const responses = new Map<string, RuntimeValidator>();
    for (const item of sources.responseReferences) {
      const validator = engine.getSchema(item.reference);
      if (!validator) {
        throw new LibError(LibErrorKind.ValidationUnavailable, \`Runtime validator could not compile operation response: \${operation} \${item.status} \${item.contentType}\`);
      }
      responses.set(\`\${item.status}:\${item.contentType}\`, validator);
    }
    const resolved = { input, responses };
    this.operationValidatorCache.set(operation, resolved);
    return resolved;
  }
`;
}

export interface GeneratedClientModules {
  readonly client: string;
  readonly runtime: string;
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
  const route = routeExpression(operation, 'runtime');
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
      return `    if (input.query?.[${JSON.stringify(parameter.name)}] !== undefined) runtime.appendQuery(query, ${JSON.stringify(parameter.name)}, runtime.serializeContentParameter(input.query[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'query', contentType: ${JSON.stringify(contentType)} }), ${parameter.allowReserved === true});`;
    }
    return `    runtime.addQueryParameter(query, ${JSON.stringify(parameter.name)}, input.query?.[${JSON.stringify(parameter.name)}], ${JSON.stringify(parameter.style || 'form')}, ${parameter.explode === undefined ? true : parameter.explode}, ${parameter.allowReserved === true});`;
  });
  const headerLines = headerParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return `    if (input.header?.[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, runtime.serializeContentParameter(input.header[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'header', contentType: ${JSON.stringify(contentType)} }));`;
    }
    return `    if (input.header?.[${JSON.stringify(parameter.name)}] !== undefined) headers.set(${JSON.stringify(parameter.name)}, runtime.serializeHeaderSimple(input.header[${JSON.stringify(parameter.name)}], ${parameter.explode === true}));`;
  });
  const cookieLines = cookieParameters.map((parameter) => {
    if (parameter.content) {
      const contentType = Object.keys(parameter.content)[0] || 'text/plain';
      return `    if (input.cookie?.[${JSON.stringify(parameter.name)}] !== undefined) cookies.push(${JSON.stringify(parameter.name)} + '=' + encodeURIComponent(runtime.serializeContentParameter(input.cookie[${JSON.stringify(parameter.name)}], { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(parameter.name)}, in: 'cookie', contentType: ${JSON.stringify(contentType)} })));`;
    }
    if (parameter.style === 'cookie') {
      return `    runtime.addCookieStyleParameter(cookies, ${JSON.stringify(parameter.name)}, input.cookie?.[${JSON.stringify(parameter.name)}], ${parameter.explode === true});`;
    }
    return `    runtime.addCookieParameter(cookies, ${JSON.stringify(parameter.name)}, input.cookie?.[${JSON.stringify(parameter.name)}], ${parameter.explode === undefined ? true : parameter.explode});`;
  });
  const queryStringLine = queryStringParameter
    ? `    runtime.setQueryString(query, input.querystring, { operation: ${JSON.stringify(operation.name)}, name: ${JSON.stringify(queryStringParameter.name)}, in: 'querystring', contentType: ${JSON.stringify(Object.keys(queryStringParameter.content || {})[0] || 'application/x-www-form-urlencoded')} });`
    : '';
  const inputName = profile.validation || operation.parameters.length || requestBody ? 'input' : '_input';
  const factoryName = operationFactoryName(operation);
  const importedNames: Array<readonly [string, string]> = [
    ['ClientRuntime', 'client runtime import'],
    ['ClientOptions', 'client options import'],
    ['RequestOptions', 'request options import'],
    ['Types', 'generated types import'],
    ['createApiOperation', 'API operation factory import'],
    ['ApiOperation', 'API operation type import'],
    ['responseContracts', 'response metadata'],
  ];
  if (surfaces.auth || surfaces.mutualTls) importedNames.push(['__runicSecuritySchemes', 'security metadata']);
  if (profile.ajvStandalone && profile.validation) importedNames.push(['createValidatorSet', 'standalone validator import']);
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
  const validatorSetup = profile.validation && validationBundle
    ? `  const validators = runtime.getOperationValidators(${JSON.stringify(operation.name)}, ${validationSourcesName});`
    : '  const validators = undefined;';
  const standaloneResponseValidation = validationBundle?.responseReferences.length
    ? `      for (const item of ${JSON.stringify(validationBundle.responseReferences)}) {
        const validator = validatorSet.all[item.reference];
        if (!validator) throw new LibError(LibErrorKind.ValidationUnavailable, \`Runtime validator could not compile operation response: ${JSON.stringify(operation.name)} \${item.status} \${item.contentType}\`);
        responses.set(\`\${item.status}:\${item.contentType}\`, validator);
      }`
    : '';
  const validationSources = profile.validation && validationBundle
    ? `const ${validationSourcesName} = (): OperationValidationSources => ({
    inputReference: ${JSON.stringify(validationBundle.inputReference)},
    responseReferences: ${JSON.stringify(validationBundle.responseReferences)},
    schemas: new Map([
${profile.ajvStandalone ? '' : `      [${JSON.stringify(validationBundle.operationRootId)}, JSON.parse(${JSON.stringify(JSON.stringify(validationBundle.operationSchema))}) as object | boolean],
${sharedSchemaAliases.map(({ id, alias }) => `      [${JSON.stringify(id)}, ${alias}],`).join('\n')}`}
    ]),
${profile.ajvStandalone ? `    standaloneValidators: () => {
      const validatorSet = createValidatorSet();
      const input = validatorSet.all[${JSON.stringify(validationBundle.inputReference)}];
      if (!input) throw new LibError(LibErrorKind.ValidationUnavailable, ${JSON.stringify(`Runtime validator could not compile operation input: ${operation.name}`)});
      const responses = new Map<string, RuntimeValidator>();
${standaloneResponseValidation}
      return { input, responses };
    },` : ''}
  });`
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
    `import { ClientRuntime${surfaces.auth || surfaces.mutualTls ? ', type RuntimeSecuritySchemes' : ''}${profile.validation ? ', type OperationValidationSources' : ''}${profile.validation && profile.ajvStandalone ? ', type RuntimeValidator' : ''}, type ${clientName}ClientOptions as ClientOptions, type ${clientName}RequestOptions as RequestOptions, type RuntimeResponseContract } from '../client-runtime.js';`,
    `import type * as Types from '../types.js';`,
    profile.mobx
      ? `import { createObservableApiOperation as createApiOperation, type ObservableApiOperation as ApiOperation } from '@exprtlabs/codegen/mobx';`
      : `import { createApiOperation, type ApiOperation } from '@exprtlabs/codegen/client';`,
    profile.ajvStandalone && profile.validation
      ? `import { createValidatorSet } from './${operation.name}.validators.generated.js';`
      : '',
    profile.validation && profile.ajvStandalone
      ? `import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';`
      : '',
    operationSchemaImports,
  ].filter(Boolean).join('\n');
  const securityDeclaration = surfaces.auth || surfaces.mutualTls
    ? `export const __runicSecuritySchemes = ${JSON.stringify(securitySchemes, null, 2)} as const;\nconst securitySchemes: RuntimeSecuritySchemes = __runicSecuritySchemes;`
    : '';
  const securityCall = plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls
    ? `    await runtime.applySecurity(${security}, query, headers, cookies, securitySchemes);\n    if (cookies.length) headers.set('Cookie', cookies.join('; '));`
    : '';
  const body = `    return createApiOperation(${JSON.stringify(operation.name)}, async (${inputName}: ${inputType}, options: RequestOptions = {}): Promise<${responseType}> => {
${profile.validation ? `    await runtime.validateOperationInput(${JSON.stringify(operation.name)}, input, validators);` : ''}
    const query: string[] = [];
${queryLines.join('\n')}
${queryStringLine}
    const headers = new Headers(runtime.defaultHeaders);
${headerLines.join('\n')}
    const cookies: string[] = [];
${cookieLines.join('\n')}
    if (cookies.length) headers.set('Cookie', cookies.join('; '));
${securityCall}
${requestBody ? `    const encodedBody = runtime.encodeBody(${JSON.stringify(operation.name)}, ${bodyValue}, ${bodyContentType}, ${bodyEncodings});\n    if (encodedBody.contentType) headers.set('Content-Type', encodedBody.contentType);` : ''}
${route.declarations}
    const request: RequestInit = {
      method: ${JSON.stringify(operation.method)},
      headers,
    };
    if (options.signal !== undefined) request.signal = options.signal;
${requestBody ? '    if (encodedBody.body !== undefined) request.body = encodedBody.body;' : ''}
    const response = await runtime.fetchImpl(runtime.url(${route.expression}, query), request);
    return runtime.readResponse<${responseType}>(
      ${JSON.stringify(operation.name)},
      response,
      responseContracts,
      validators,
    );
    });`;

  return `${generatedBanner()}
${runtimeImports}

${securityDeclaration}
const responseContracts: readonly RuntimeResponseContract[] = ${JSON.stringify(responseContracts)};
${validationSources}

export function ${operation.name}(options: ClientOptions): ApiOperation<${inputType}, ${responseType}, RequestOptions> {
  return ${factoryName}(new ClientRuntime(options));
}

export function ${factoryName}(runtime: ClientRuntime): ApiOperation<${inputType}, ${responseType}, RequestOptions> {
${validatorSetup}
${body}
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

  return `export interface ${clientName}AuthContext {
  readonly scheme: string;
  readonly type: string;
  readonly scopes: readonly string[];
  readonly flows?: Readonly<Record<string, unknown>>;
  readonly openIdConnectUrl?: string;
}

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
> =
  | string
  | ((context: Context) => string | Promise<string>);

export type ${clientName}BasicCredentials = { username: string; password: string };
export type ${clientName}BasicAuthValue<
  Context extends ${clientName}AuthContext = ${clientName}AuthContext,
> =
  | ${clientName}BasicCredentials
  | ((context: Context) => ${clientName}BasicCredentials | Promise<${clientName}BasicCredentials>);

export interface ${clientName}Auth {
${properties.join('\n')}
}

type ${clientName}ResolvedAuthValue = string | ${clientName}BasicCredentials;
`;
}

function emitRuntimeModule(
  clientName: string,
  rawSecuritySchemes: Readonly<Record<string, unknown>>,
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
): string {
  const surfaces = plan.clientSurfaces;
  const optionLines = [
    '  /** Runtime-owned API endpoint. No specification server URL is assumed. */',
    '  baseUrl: string;',
    '  fetchImpl?: typeof fetch;',
    '  headers?: HeadersInit;',
    ...(surfaces.auth ? [
      '  /** Values or lazy providers keyed by OpenAPI security-scheme name. */',
      `  auth?: ${clientName}Auth;`,
    ] : []),
    ...(surfaces.mutualTls ? [
      '  /**',
      '   * Explicit transport used when a mutualTLS security requirement is selected.',
      '   * The application owns certificate/agent configuration; the generated client',
      '   * guarantees requests use this fetch implementation.',
      '   */',
      `  mutualTls?: ${clientName}MutualTlsTransport;`,
    ] : []),
    ...(surfaces.bodyEncoders ? [
      '  /** Request codecs; configured codecs override built-in encoders. */',
      `  bodyEncoders?: Record<string, ${clientName}BodyEncoder>;`,
    ] : []),
    ...(surfaces.responseDecoders ? [
      '  /** Response codecs; configured codecs override built-in readers. */',
      `  responseDecoders?: Record<string, (response: Response) => unknown | Promise<unknown>>;`,
    ] : []),
    ...(surfaces.parameterSerializers ? [
      '  /** Parameter content serializers; configured serializers override built-ins. */',
      `  parameterSerializers?: Record<string, ${clientName}ParameterSerializer>;`,
    ] : []),
    ...(surfaces.responseHeaderDecoders ? [
      '  /** Response header content decoders; configured decoders override built-ins. */',
      `  responseHeaderDecoders?: Record<string, ${clientName}ResponseHeaderDecoder>;`,
    ] : []),
    ...(surfaces.streamDecoders ? [
      '  /**',
      '   * Framing decoders for itemSchema streams other than built-in NDJSON,',
      '   * JSON-seq, and SSE. The global validation profile controls item schema checks.',
      '   */',
      `  streamDecoders?: Record<string, ${clientName}StreamDecoder>;`,
    ] : []),
    ...(profile.validation ? [
      '  /** Overrides generated validators for individual operations. */',
      '  operationValidators?: ReadonlyMap<OperationName, OperationRuntimeValidators>;',
      '  /** Shared schema engine for generated operation and model validation. */',
      '  validationEngine?: RuntimeValidationEngine;',
    ] : []),
  ];
  const securityTypes = surfaces.auth || surfaces.mutualTls
    ? emitSecurityTypes(clientName, rawSecuritySchemes)
    : '';
  const responseTypeDeclarations = `export interface RuntimeResponseContract {
  status: string;
  content: readonly {
    contentType: string;
    framing: 'ndjson' | 'json-seq' | 'sse' | 'custom-stream' | 'binary' | 'body';
    requiredCodec?: string;
    schemaType?: string;
  }[];
  headers: readonly {
    name: string;
    style: string;
    explode: boolean;
    contentType: string | null;
    kind: string | null;
    itemKind: string | null;
    propertyKinds: Readonly<Record<string, string | null>>;
  }[];
}

export interface RuntimeSecurityScheme {
  type?: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Readonly<Record<string, unknown>>;
  openIdConnectUrl?: string;
}
export type RuntimeSecuritySchemes = Readonly<Record<string, RuntimeSecurityScheme>>;
`;
  const validationTypes = profile.validation
    ? `export interface RuntimeValidator {
  (value: unknown): boolean | Promise<boolean>;
  readonly errors?: readonly unknown[] | null;
}

export interface OperationRuntimeValidators {
  readonly input: RuntimeValidator;
  readonly responses: ReadonlyMap<string, RuntimeValidator>;
}

export interface RuntimeValidationEngine {
  addSchema(schema: object | boolean, id: string): void;
  getSchema(reference: string): RuntimeValidator | undefined;
}

export interface OperationValidationSources {
  readonly inputReference: string;
  readonly responseReferences: readonly { readonly status: string; readonly contentType: string; readonly reference: string }[];
  readonly schemas: ReadonlyMap<string, object | boolean>;
  readonly standaloneValidators?: () => OperationRuntimeValidators;
}
`
    : `export interface RuntimeValidator {
  (value: unknown): boolean | Promise<boolean>;
  readonly errors?: readonly unknown[] | null;
}
export interface OperationRuntimeValidators {
  readonly input: RuntimeValidator;
  readonly responses: ReadonlyMap<string, RuntimeValidator>;
}
`;
  const operationNameImport = `import type { OperationName } from './schemas.js';`;
  const undeclaredResponse = plan.helpers.has('selectResponse');
  const errorImports = [
    ...(profile.validation || undeclaredResponse ? ['LibError', 'LibErrorKind'] : []),
    ...(profile.validation ? ['IssueSource', 'IssueRepresentation'] : []),
  ];
  const errorsImport = errorImports.length ? `import { ${errorImports.join(', ')} } from '@exprtlabs/codegen/errors';` : '';
  // A factory, not a subclass: the ttsc plugin currently rejects classes extending a non-generated base.
  const undeclaredResponseClass = undeclaredResponse ? `
/** A response whose status or media type the operation does not declare. Its body was cancelled. */
export interface ${clientName}UndeclaredResponseError extends LibError {
  readonly kind: LibErrorKind.Response;
  readonly operation: OperationName;
  readonly status: number;
  readonly headers: Headers;
  readonly contentType: string;
}

const undeclaredResponseBrand = Symbol('${clientName}UndeclaredResponseError');

export function is${clientName}UndeclaredResponseError(error: unknown): error is ${clientName}UndeclaredResponseError {
  return error instanceof LibError && Object.hasOwn(error, undeclaredResponseBrand);
}

function undeclaredResponseError(
  operation: OperationName,
  response: Response,
  contentType: string,
): ${clientName}UndeclaredResponseError {
  const error = new LibError(
    LibErrorKind.Response,
    \`Undeclared OpenAPI response for \${operation}: HTTP \${response.status} \${contentType || '(no content type)'}\`,
    [],
    { causedByInput: true },
  );
  Object.defineProperty(error, undeclaredResponseBrand, { value: true });
  const undeclared = Object.assign(error, { operation, status: response.status, headers: response.headers, contentType });
  if (!is${clientName}UndeclaredResponseError(undeclared)) throw new TypeError('undeclared response brand missing');
  return undeclared;
}
` : '';
  const validationImports = profile.validation
    ? `import { runValidation, issuesFromErrors } from '@exprtlabs/codegen/validation';
${profile.ajvStandalone ? '' : `import { createOpenApiAjvEngine } from '@exprtlabs/codegen/ajv';

let sharedValidationEngine: RuntimeValidationEngine | undefined;

/** Every client and operation factory of this SDK validates through one engine unless the caller supplies one. */
function defaultValidationEngine(): RuntimeValidationEngine {
  sharedValidationEngine ??= createOpenApiAjvEngine();
  return sharedValidationEngine;
}`}`
    : '';
  const runtimeClass = `export class ClientRuntime {
  public readonly baseUrl: string;
  public readonly fetchImpl: typeof fetch;
  public readonly defaultHeaders: Headers;
${surfaces.auth || surfaces.mutualTls ? `  private readonly auth: ${clientName}Auth | undefined;` : ''}
${surfaces.mutualTls ? '  private readonly mutualTls: boolean;' : ''}
${surfaces.bodyEncoders ? `  private readonly bodyEncoders: Record<string, ${clientName}BodyEncoder>;` : ''}
${surfaces.responseDecoders ? `  private readonly responseDecoders: Record<string, (response: Response) => unknown | Promise<unknown>>;` : ''}
${surfaces.parameterSerializers ? `  private readonly parameterSerializers: Record<string, ${clientName}ParameterSerializer>;` : ''}
${surfaces.responseHeaderDecoders ? `  private readonly responseHeaderDecoders: Record<string, ${clientName}ResponseHeaderDecoder>;` : ''}
${surfaces.streamDecoders ? `  private readonly streamDecoders: Record<string, ${clientName}StreamDecoder>;` : ''}
${profile.validation ? `  private readonly operationValidatorOverrides: ReadonlyMap<OperationName, OperationRuntimeValidators> | undefined;
  private readonly operationValidatorCache = new Map<OperationName, OperationRuntimeValidators>();
  public readonly validationEngine: RuntimeValidationEngine | undefined;` : ''}

  constructor(options: ${clientName}ClientOptions) {
    const baseUrl = options.baseUrl.trim();
    if (!baseUrl) throw new Error('${clientName}Client requires a non-empty baseUrl');
    this.baseUrl = baseUrl.replace(/\\/$/, '');
    const configuredFetch = ${surfaces.mutualTls ? 'options.mutualTls?.fetchImpl ?? options.fetchImpl' : 'options.fetchImpl'};
    // Call a configured fetch without a receiver: browsers reject a native
    // fetch invoked with any receiver other than the global object.
    this.fetchImpl = configuredFetch
      ? (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => configuredFetch(input, init)
      : fetch.bind(globalThis);
    this.defaultHeaders = new Headers(options.headers);
${surfaces.auth || surfaces.mutualTls ? `    this.auth = ${surfaces.auth ? 'options.auth' : 'undefined'};` : ''}
${surfaces.mutualTls ? '    this.mutualTls = options.mutualTls !== undefined;' : ''}
${surfaces.bodyEncoders ? '    this.bodyEncoders = options.bodyEncoders ?? {};' : ''}
${surfaces.responseDecoders ? '    this.responseDecoders = options.responseDecoders ?? {};' : ''}
${surfaces.parameterSerializers ? '    this.parameterSerializers = options.parameterSerializers ?? {};' : ''}
${surfaces.responseHeaderDecoders ? '    this.responseHeaderDecoders = options.responseHeaderDecoders ?? {};' : ''}
${surfaces.streamDecoders ? '    this.streamDecoders = options.streamDecoders ?? {};' : ''}
${profile.validation ? `    this.operationValidatorOverrides = options.operationValidators;
    this.validationEngine = options.validationEngine ?? ${profile.ajvStandalone ? 'undefined' : 'defaultValidationEngine()'};` : ''}
  }
${emitTransportMethods(clientName, plan)}
${emitCodecMethods(clientName, profile, plan)}
${profile.validation ? emitValidationHelpers() : ''}
${emitStreamMethods(clientName, profile, plan)}
${surfaces.auth || surfaces.mutualTls ? emitAuthMethods(clientName, plan) : ''}
}
`;

  return `${generatedBanner()}
${operationNameImport}
${errorsImport}
${validationImports}

export interface ${clientName}ClientOptions {
${optionLines.join('\n')}
}

export interface ${clientName}RequestOptions {
  signal?: AbortSignal;
}

${surfaces.mutualTls ? `export interface ${clientName}MutualTlsTransport {
  readonly fetchImpl: typeof fetch;
}

` : ''}
${surfaces.streamDecoders ? `export interface ${clientName}StreamDecoderContext {
  readonly operation: OperationName;
  readonly contentType: string;
}
export type ${clientName}StreamDecoder = (
  response: Response,
  context: ${clientName}StreamDecoderContext,
) => AsyncIterable<unknown>;

` : ''}
${surfaces.parameterSerializers ? `export interface ${clientName}ParameterSerializerContext {
  readonly operation: OperationName;
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie' | 'querystring';
  readonly contentType: string;
}
export type ${clientName}ParameterSerializer = (value: unknown, context: ${clientName}ParameterSerializerContext) => string;

` : ''}
${surfaces.responseHeaderDecoders ? `export interface ${clientName}ResponseHeaderDecoderContext {
  readonly operation: OperationName;
  readonly name: string;
  readonly contentType: string;
}
export type ${clientName}ResponseHeaderDecoder = (value: string, context: ${clientName}ResponseHeaderDecoderContext) => unknown;

` : ''}
${surfaces.bodyEncoders ? `export interface ${clientName}EncodedBody {
  body: BodyInit;
  /** Omit for FormData so the runtime supplies its multipart boundary. */
  contentType?: string;
}
export interface ${clientName}EncodingMetadata {
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly style?: string;
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly encoding?: Readonly<Record<string, unknown>>;
  readonly prefixEncoding?: readonly unknown[];
  readonly itemEncoding?: unknown;
}
export interface ${clientName}BodyEncoderContext {
  readonly contentType: string;
  readonly encoding: Readonly<Record<string, ${clientName}EncodingMetadata>>;
  readonly prefixEncoding: readonly unknown[];
  readonly itemEncoding: unknown;
}
export type ${clientName}BodyEncoder = (
  value: unknown,
  context: ${clientName}BodyEncoderContext,
) => BodyInit | ${clientName}EncodedBody;

` : ''}
${securityTypes}
${responseTypeDeclarations}
${validationTypes}
${undeclaredResponseClass}
${runtimeClass}`;
}

function emitClient(
  clientName: string,
  operations: readonly NormalizedOperation[],
  profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
  rawSecuritySchemes: Readonly<Record<string, unknown>>,
): string {
  const scope = new NameScope(`${clientName}Client`);
  const helperNames = plan.helpers;
  for (const helper of helperNames) scope.claim(helper, `generated client runtime helper ${helper}`);
  scope.claim('ClientRuntime', 'shared client runtime');
  scope.claim('ClientOptions', 'client options import');
  scope.claim('RequestOptions', 'request options import');
  scope.claim('Types', 'generated types import');
  scope.claim('ApiOperation', 'API operation type import');
  scope.claim(`${clientName}Client`, 'client class');
  scope.claim(`${clientName}ClientPort`, 'client interface');
  if (plan.helpers.has('selectResponse')) scope.claim(`${clientName}UndeclaredResponseError`, 'undeclared response error export');
  if (plan.helpers.has('selectResponse')) scope.claim(`is${clientName}UndeclaredResponseError`, 'undeclared response error guard');
  const metadataName = `${clientName[0]?.toLowerCase() ?? 'c'}${clientName.slice(1)}SecuritySchemeMetadata`;
  if (plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls) scope.claim(metadataName, 'security metadata export');
  const reservedClientNames = new Set<string>([
    ...helperNames,
    'ClientRuntime',
    'createApiOperation',
    'ApiOperation',
  ]);
  const aliases = new Map<string, string>();
  const securityAliases = new Map<string, string>();
  operations.forEach((operation, index) => {
    scope.rejectReserved(
      operation.name,
      `operation ${JSON.stringify(operation.name)}`,
      reservedClientNames,
      'generated client helper',
    );
    scope.claim(operation.name, `operation ${JSON.stringify(operation.name)}`);
    let alias = `__runicOperationFactory${index}`;
    while (scope.has(alias)) alias += '_';
    scope.claim(alias, `operation factory ${JSON.stringify(operation.name)}`);
    aliases.set(operation.name, alias);
    if (plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls) {
      let securityAlias = `__runicSecuritySchemes${index}`;
      while (scope.has(securityAlias)) securityAlias += '_';
      scope.claim(securityAlias, `security metadata ${JSON.stringify(operation.name)}`);
      securityAliases.set(operation.name, securityAlias);
    }
  });
  const imports = operations.map((operation) => {
    const names = [`${operationFactoryName(operation)} as ${aliases.get(operation.name)}`];
    const securityAlias = securityAliases.get(operation.name);
    if (securityAlias) names.push(`__runicSecuritySchemes as ${securityAlias}`);
    return `import { ${names.join(', ')} } from ${JSON.stringify(`./operations/${operation.name}.js`)};`;
  }).join('\n');
  const metadata = plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls
    ? `export const ${metadataName} = {
${[...securityAliases.values()].map((alias) => `  ...${alias},`).join('\n')}
} as const;`
    : '';
  const methods = operations.map((operation) =>
    `  ${operation.name}(): ApiOperation<Types.${operation.typeName}OperationInput, Types.${operation.typeName}OperationHttpResponse, RequestOptions>;`,
  ).join('\n');
  const implementations = operations.map((operation) =>
    `  ${operation.name}(): ApiOperation<Types.${operation.typeName}OperationInput, Types.${operation.typeName}OperationHttpResponse, RequestOptions> {
    return ${aliases.get(operation.name)}(this.runtime);
  }`,
  ).join('\n\n');
  return `${generatedBanner()}
import type * as Types from './types.js';
import { ClientRuntime } from './client-runtime.js';
import type { ${clientName}ClientOptions as ClientOptions, ${clientName}RequestOptions as RequestOptions } from './client-runtime.js';
${profile.mobx
    ? "import type { ObservableApiOperation as ApiOperation } from '@exprtlabs/codegen/mobx';"
    : "import type { ApiOperation } from '@exprtlabs/codegen/client';"}
${imports}

export interface ${clientName}ClientPort {
${methods}
}

export class ${clientName}Client implements ${clientName}ClientPort {
  private readonly runtime: ClientRuntime;

  constructor(options: ClientOptions) {
    this.runtime = new ClientRuntime(options);
  }

${implementations}
}
${plan.helpers.has('selectResponse') ? `\nexport { is${clientName}UndeclaredResponseError } from './client-runtime.js';\n` : ''}
export type {
${plan.helpers.has('selectResponse') ? `  ${clientName}UndeclaredResponseError,\n` : ''}  ${clientName}ClientOptions,
  ${clientName}RequestOptions,
${plan.clientSurfaces.mutualTls ? `  ${clientName}MutualTlsTransport,\n` : ''}${plan.clientSurfaces.streamDecoders ? `  ${clientName}StreamDecoderContext,\n  ${clientName}StreamDecoder,\n` : ''}${plan.clientSurfaces.parameterSerializers ? `  ${clientName}ParameterSerializerContext,\n  ${clientName}ParameterSerializer,\n` : ''}${plan.clientSurfaces.responseHeaderDecoders ? `  ${clientName}ResponseHeaderDecoderContext,\n  ${clientName}ResponseHeaderDecoder,\n` : ''}${plan.clientSurfaces.bodyEncoders ? `  ${clientName}EncodedBody,\n  ${clientName}EncodingMetadata,\n  ${clientName}BodyEncoderContext,\n  ${clientName}BodyEncoder,\n` : ''}${plan.clientSurfaces.auth || plan.clientSurfaces.mutualTls ? `  ${clientName}AuthContext,\n  ${clientName}SecuritySchemeName,\n  ${clientName}SecuritySchemeFlows,\n  ${clientName}SecuritySchemeOpenIdConnectUrl,\n${objectEntries(rawSecuritySchemes).filter(([, scheme]) => isJsonObject(scheme) && !scheme.$ref && scheme.type !== 'mutualTLS').map(([name]) => `  ${clientName}${identifier(name)}Context,\n`).join('')}  ${clientName}TokenAuthValue,\n  ${clientName}BasicCredentials,\n  ${clientName}BasicAuthValue,\n  ${clientName}Auth,\n` : ''}} from './client-runtime.js';
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
        owner: '@exprtlabs/openapi-to-ts',
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
      alias: `__runicSchema${index}`,
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
  const runtime = emitRuntimeModule(clientName, rawSecuritySchemes, profile, plan);
  const client = emitClient(clientName, operations, profile, plan, rawSecuritySchemes);
  return { client, runtime, operations: emittedOperations, standaloneValidators, sharedSchemas };
}


