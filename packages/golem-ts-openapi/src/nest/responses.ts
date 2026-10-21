import * as ts from '@exprtlabs/golem/internal/ts';
import {
  TsToOpenApiDiagnosticCode,
  TsToOpenApiError,
  diagnostic,
} from '../diagnostics.js';
import {
  authoritativeTypeReference,
  classHierarchyBaseToDerived,
  controllerMethodSignature,
  hasAnyDecorator,
  hasDecorator,
  typeExpressionFromApiOption,
  unwrapAsyncType,
} from './analysis-utils.js';
import { decoratorOptions, readNumber, readString, type DecoratorOptions, type MetadataReader } from './metadata.js';
import { evaluateStaticValue } from '../evaluation/static-value.js';
import { NEST_COMMON, NEST_SWAGGER, callArguments, decoratorsOf } from './symbols.js';
import type { DecoratorInfo, NestAnalysisContext, NestHttpMethod, RequestBodyDescription, ResponseDescription, TypeReference } from './types.js';
const DEFAULT_RESPONSE_STATUS: Record<NestHttpMethod, string> = {
  get: '200',
  post: '201',
  put: '200',
  delete: '200',
  patch: '200',
  options: '200',
  head: '200',
};

function validHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function validResponseStatus(value: string): boolean {
  return value === 'default'
    || /^[1-5]XX$/.test(value)
    || /^\d{3}$/.test(value) && validHttpStatus(Number(value));
}

function invalidStatus(
  method: ts.MethodDeclaration,
  node: ts.Node,
  message: string,
): never {
  throw new TsToOpenApiError(diagnostic(
    method.getSourceFile(),
    node,
    TsToOpenApiDiagnosticCode.InvalidResponseStatus,
    message,
  ));
}

/** Public `@nestjs/swagger` named helpers generated from Nest 11 `HttpStatus` keys. */
const NAMED_RESPONSE_STATUS: Readonly<Record<string, string>> = {
  ApiContinueResponse: '100',
  ApiSwitchingProtocolsResponse: '101',
  ApiProcessingResponse: '102',
  ApiEarlyhintsResponse: '103',
  ApiOkResponse: '200',
  ApiCreatedResponse: '201',
  ApiAcceptedResponse: '202',
  ApiNonAuthoritativeInformationResponse: '203',
  ApiNoContentResponse: '204',
  ApiResetContentResponse: '205',
  ApiPartialContentResponse: '206',
  ApiAmbiguousResponse: '300',
  ApiMovedPermanentlyResponse: '301',
  ApiFoundResponse: '302',
  ApiSeeOtherResponse: '303',
  ApiNotModifiedResponse: '304',
  ApiTemporaryRedirectResponse: '307',
  ApiPermanentRedirectResponse: '308',
  ApiBadRequestResponse: '400',
  ApiUnauthorizedResponse: '401',
  ApiPaymentRequiredResponse: '402',
  ApiForbiddenResponse: '403',
  ApiNotFoundResponse: '404',
  ApiMethodNotAllowedResponse: '405',
  ApiNotAcceptableResponse: '406',
  ApiProxyAuthenticationRequiredResponse: '407',
  ApiRequestTimeoutResponse: '408',
  ApiConflictResponse: '409',
  ApiGoneResponse: '410',
  ApiLengthRequiredResponse: '411',
  ApiPreconditionFailedResponse: '412',
  ApiPayloadTooLargeResponse: '413',
  ApiUriTooLongResponse: '414',
  ApiUnsupportedMediaTypeResponse: '415',
  ApiRequestedRangeNotSatisfiableResponse: '416',
  ApiExpectationFailedResponse: '417',
  ApiIAmATeapotResponse: '418',
  ApiMisdirectedResponse: '421',
  ApiUnprocessableEntityResponse: '422',
  ApiFailedDependencyResponse: '424',
  ApiPreconditionRequiredResponse: '428',
  ApiTooManyRequestsResponse: '429',
  ApiInternalServerErrorResponse: '500',
  ApiNotImplementedResponse: '501',
  ApiBadGatewayResponse: '502',
  ApiServiceUnavailableResponse: '503',
  ApiGatewayTimeoutResponse: '504',
  ApiHttpVersionNotSupportedResponse: '505',
  ApiDefaultResponse: 'default',
};

function isSwaggerResponseDecorator(decorator: DecoratorInfo): boolean {
  return decorator.packageName === NEST_SWAGGER
    && decorator.name !== undefined
    && (decorator.name === 'ApiResponse' || /^Api.+Response$/.test(decorator.name));
}

function explicitSwaggerStatus(
  method: ts.MethodDeclaration,
  options: DecoratorOptions,
  fallbackName: string,
): string | undefined {
  const status = options.value('status', TsToOpenApiDiagnosticCode.InvalidResponseStatus);
  if (status === undefined) return undefined;
  const value = typeof status === 'number' ? String(status) : typeof status === 'string' ? status : undefined;
  if (value === undefined || !validResponseStatus(value)) {
    invalidStatus(
      method,
      options.node('status') ?? method,
      `Swagger response decorator @${fallbackName} has an invalid status; use an integer HTTP status from 100 through 599, default, or 1XX through 5XX.`,
    );
  }
  return value;
}

function nestHttpCodeStatus(
  reader: MetadataReader,
  method: ts.MethodDeclaration,
  decorator: DecoratorInfo,
): string {
  const argument = callArguments(decorator)[0];
  const message = '@HttpCode() requires a static integer HTTP status from 100 through 599.';
  if (!argument) return invalidStatus(method, decorator.call ?? decorator.decorator, message);
  const value = readNumber(reader, argument, '@HttpCode()', TsToOpenApiDiagnosticCode.InvalidResponseStatus);
  if (value === undefined || !validHttpStatus(value)) invalidStatus(method, argument, message);
  return String(value);
}

function responseDefaults(
  context: NestAnalysisContext,
  method: ts.MethodDeclaration,
  controllerClass: ts.ClassDeclaration,
  httpMethod: NestHttpMethod,
  statusOverride?: string,
): ResponseDescription[] {
  const checker = context.checker;
  const declaredReturn = checker.getSignatureFromDeclaration(method)?.getReturnType();
  const instantiatedReturn = controllerMethodSignature(checker, method, controllerClass)?.getReturnType();
  // A generic base method's syntax names `T`; only the instantiated type is valid for the derived controller.
  const returned = instantiatedReturn && unwrapAsyncType(
    checker,
    instantiatedReturn,
    instantiatedReturn === declaredReturn ? method.type : undefined,
  );
  const returnType = returned?.type;
  const hasVoid = !returnType || (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0;
  const type = hasVoid ? undefined : authoritativeTypeReference(context, {
    type: returnType,
    ...(returned.node ? { node: returned.node } : {}),
    sourceNode: method,
    sourceFile: method.getSourceFile(),
    ...(returnType.aliasSymbol?.declarations?.[0] ? { declaration: returnType.aliasSymbol.declarations[0] } : {}),
  } satisfies TypeReference);
  const status = statusOverride ?? DEFAULT_RESPONSE_STATUS[httpMethod];
  return [{
    status,
    description: status === '201' ? 'Created' : status === '202' ? 'Accepted' : status === '204' ? 'No Content' : 'Success',
    ...(type ? { type } : {}),
    explicit: false,
  }];
}

function swaggerResponseDecorators(decorators: readonly DecoratorInfo[]): readonly DecoratorInfo[] {
  return decorators.filter(isSwaggerResponseDecorator);
}

/**
 * Nest `getTypeIsArrayTuple`: a missing type keeps the isArray flag; `isArray: true`
 * wins; a runtime array type unwraps to its element; a scalar type stores isArray false.
 */
function swaggerTypeIsArrayTuple(
  checker: ts.TypeChecker,
  typeValue: ts.Expression | undefined,
  isArrayFlag: boolean | undefined,
): { readonly type?: TypeReference; readonly isArray?: boolean } {
  const typed = typeExpressionFromApiOption(checker, typeValue);
  return {
    type: typed.type,
    isArray: typed.isArray === true || isArrayFlag === true ? true : typeValue ? false : isArrayFlag,
  };
}

function overrideExistingFlag(
  reader: MetadataReader,
  decorator: DecoratorInfo,
): boolean {
  if (decorator.name !== 'ApiResponse' || callArguments(decorator)[1] === undefined) return true;
  return decoratorOptions(reader, decorator, 1, TsToOpenApiDiagnosticCode.InvalidResponseStatus)
    .boolean('overrideExisting', TsToOpenApiDiagnosticCode.InvalidResponseStatus) ?? false;
}

function parseSwaggerResponse(
  context: NestAnalysisContext,
  method: ts.MethodDeclaration,
  decorator: DecoratorInfo,
  runtimeStatus: string,
  scope: 'class' | 'method',
): ResponseDescription {
  const name = decorator.name ?? 'ApiResponse';
  const options = decoratorOptions(context, decorator);
  const status = NAMED_RESPONSE_STATUS[name]
    ?? explicitSwaggerStatus(method, options, name)
    ?? (scope === 'class' ? 'default' : runtimeStatus);
  const typed = swaggerTypeIsArrayTuple(context.checker, options.expression('type'), options.boolean('isArray'));
  const type = typed.type ? authoritativeTypeReference(context, typed.type) : undefined;
  const content = options.record('content');
  const schema = options.record('schema');
  const headers = options.record('headers');
  const description = options.documentationString('description')
    ?? (name === 'ApiNoContentResponse' ? 'No Content' : '');
  return {
    status,
    description,
    // Nest writes both keys even when absent, clearing earlier same-status types.
    type,
    isArray: typed.isArray,
    ...(content ? { content } : schema ? { content: { 'application/json': { schema } } } : {}),
    ...(headers ? { headers } : {}),
    explicit: true,
  };
}

function mergeResponseEntry(
  existing: ResponseDescription,
  incoming: ResponseDescription,
): ResponseDescription {
  const existingDesc = existing.description || '';
  const incomingDesc = incoming.description || '';
  const description = existingDesc && incomingDesc
    ? `${existingDesc}\n\n${incomingDesc}`
    : existingDesc || incomingDesc;
  const assigned: ResponseDescription = {
    ...existing,
    ...incoming,
    description,
    explicit: true,
  };
  return {
    status: assigned.status,
    description,
    ...(assigned.type ? { type: assigned.type } : {}),
    ...(assigned.isArray === true ? { isArray: true } : {}),
    ...(assigned.content ? { content: assigned.content } : {}),
    ...(assigned.headers ? { headers: assigned.headers } : {}),
    explicit: true,
  };
}

function applySwaggerResponses(
  context: NestAnalysisContext,
  method: ts.MethodDeclaration,
  decorators: readonly DecoratorInfo[],
  runtimeStatus: string,
  scope: 'class' | 'method',
  inherited: ReadonlyMap<string, ResponseDescription> = new Map(),
): Map<string, ResponseDescription> {
  const result = new Map(inherited);
  // experimentalDecorators apply bottom-to-top, matching Nest Reflect.defineMetadata order.
  for (const decorator of [...swaggerResponseDecorators(decorators)].reverse()) {
    const name = decorator.name ?? 'ApiResponse';
    if (name !== 'ApiResponse' && NAMED_RESPONSE_STATUS[name] === undefined) {
      invalidStatus(
        method,
        decorator.call ?? decorator.decorator,
        `Unknown Nest Swagger response decorator @${name}; use @ApiResponse or a named helper exported by the installed @nestjs/swagger.`,
      );
    }
    if (!overrideExistingFlag(context, decorator) && result.size > 0) continue;
    const incoming = parseSwaggerResponse(context, method, decorator, runtimeStatus, scope);
    const existing = result.get(incoming.status);
    result.set(incoming.status, existing ? mergeResponseEntry(existing, incoming) : incoming);
  }
  return result;
}

function classSwaggerResponses(
  context: NestAnalysisContext,
  method: ts.MethodDeclaration,
  controllerClass: ts.ClassDeclaration,
  runtimeStatus: string,
): Map<string, ResponseDescription> {
  let responses = new Map<string, ResponseDescription>();
  for (const classDeclaration of classHierarchyBaseToDerived(context.checker, controllerClass)) {
    responses = applySwaggerResponses(
      context,
      method,
      decoratorsOf(context.checker, classDeclaration),
      runtimeStatus,
      'class',
      responses,
    );
  }
  return responses;
}

function overlayResponseMaps(
  classResponses: Map<string, ResponseDescription>,
  methodResponses: Map<string, ResponseDescription>,
): Map<string, ResponseDescription> {
  const merged = new Map(classResponses);
  for (const [status, response] of methodResponses) merged.set(status, response);
  return merged;
}

export function parseResponses(
  context: NestAnalysisContext,
  method: ts.MethodDeclaration,
  httpMethod: NestHttpMethod,
  controllerClass: ts.ClassDeclaration,
): ResponseDescription[] {
  const checker = context.checker;
  const methodDecorators = decoratorsOf(checker, method);
  const httpCode = hasDecorator(methodDecorators, 'HttpCode', NEST_COMMON);
  const statusOverride = httpCode ? nestHttpCodeStatus(context, method, httpCode) : undefined;
  const defaults = responseDefaults(context, method, controllerClass, httpMethod, statusOverride);
  const runtimeStatus = defaults[0]?.status ?? DEFAULT_RESPONSE_STATUS[httpMethod];
  const classResponses = classSwaggerResponses(context, method, controllerClass, runtimeStatus);
  const methodResponses = applySwaggerResponses(context, method, methodDecorators, runtimeStatus, 'method');
  const merged = overlayResponseMaps(classResponses, methodResponses);
  const standardSuccessStatuses = new Set(['200', '201', '202', '204', '205']);
  for (const response of merged.values()) {
    if (response.status !== runtimeStatus && standardSuccessStatuses.has(response.status)) {
      throw new TsToOpenApiError(diagnostic(
        method.getSourceFile(),
        method,
        TsToOpenApiDiagnosticCode.ConflictingResponseStatus,
        `Swagger success response status ${response.status} conflicts with Nest's runtime success status ${runtimeStatus}. Add @HttpCode(${response.status}) to change Nest's runtime status, or change the Swagger response status to ${runtimeStatus}.`,
      ));
    }
  }
  const declaredType = defaults[0]?.type;
  const annotated = [...merged.values()].map(response => response.status === runtimeStatus && declaredType
    ? { ...response, declaredType }
    : response);
  const explicitStatuses = new Set(annotated.map(response => response.status));
  const inferred = defaults.filter(response => !explicitStatuses.has(response.status));
  const { headers, mediaType } = nestResponseHeaders(context, methodDecorators);
  if (Object.keys(headers).length === 0 && mediaType === undefined) return [...inferred, ...annotated];
  // Nest sets @Header() values on the success response; explicit Swagger headers take precedence.
  return [...inferred, ...annotated].map(response => response.status === runtimeStatus
    ? {
      ...response,
      ...(Object.keys(headers).length > 0 ? { headers: { ...headers, ...response.headers } } : {}),
      ...(mediaType ? { mediaTypes: [mediaType] } : {}),
    }
    : response);
}

/**
 * Headers set by `@Header(name, value)` on the method. `Content-Type` is the
 * success response's media type rather than a documented header; any other
 * computed value keeps only the string schema.
 */
function nestResponseHeaders(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): { readonly headers: Record<string, unknown>; readonly mediaType?: string } {
  const headers: Record<string, unknown> = {};
  let mediaType: string | undefined;
  for (const decorator of hasAnyDecorator(decorators, ['Header'], NEST_COMMON)) {
    const [nameArgument, valueArgument] = callArguments(decorator);
    const name = readString(reader, nameArgument, '@Header() name', TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator);
    if (name === undefined) continue;
    const value = valueArgument && evaluateStaticValue(reader.checker, valueArgument);
    const text = value?.ok && typeof value.value === 'string' ? value.value : undefined;
    if (name.toLowerCase() === 'content-type') {
      mediaType = readString(reader, valueArgument, '@Header(\'Content-Type\') value', TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator);
      continue;
    }
    headers[name] = { schema: { type: 'string' }, ...(text === undefined ? {} : { example: text }) };
  }
  return { headers, ...(mediaType ? { mediaType } : {}) };
}

export function parseRequestBody(
  context: NestAnalysisContext,
  decorators: readonly DecoratorInfo[],
): RequestBodyDescription | undefined {
  const decorator = hasDecorator(decorators, 'ApiBody', NEST_SWAGGER);
  if (!decorator) return undefined;
  const options = decoratorOptions(context, decorator);
  const typed = typeExpressionFromApiOption(context.checker, options.expression('type'));
  const content = options.record('content');
  const schema = options.record('schema');
  const description = options.documentationString('description');
  const required = options.boolean('required');
  return {
    ...(description ? { description } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(typed.type ? { type: authoritativeTypeReference(context, typed.type) } : {}),
    ...(typed.isArray || options.boolean('isArray') === true ? { isArray: true } : {}),
    ...(content ? { content } : schema ? { content: { 'application/json': { schema } } } : {}),
  };
}

export function assertManualResponseContract(
  method: ts.MethodDeclaration,
  responses: readonly ResponseDescription[],
  manualResponse: ts.ParameterDeclaration | undefined,
): void {
  if (!manualResponse) return;
  const hasExplicitSuccess = responses.some(response => {
    if (!response.explicit) return false;
    const success = response.status === '2XX' || /^2[0-9]{2}$/.test(response.status);
    if (!success) return false;
    return response.type !== undefined || response.content !== undefined;
  });
  if (hasExplicitSuccess) return;
  throw new TsToOpenApiError(diagnostic(
    method.getSourceFile(),
    manualResponse,
    TsToOpenApiDiagnosticCode.UnsupportedNestParameter,
    '@Res() responses require an explicit supported Swagger success response type or content/schema contract.',
  ));
}
