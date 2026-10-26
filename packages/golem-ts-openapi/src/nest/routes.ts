import * as path from 'node:path';
import { DEFAULT_CONTROLLER_SUFFIXES, compareText, discoverSources, stripSourceSuffix, suffixPattern } from '@exprtlabs/golem/generator-api';
import * as ts from '@exprtlabs/golem/internal/ts';
import {
  GolemDiagnosticSeverity,
  TsToOpenApiError,
  TsToOpenApiDiagnosticCode,
  diagnostic,
} from '../diagnostics.js';
import { baseClassDeclarations, classHierarchyBaseToDerived, evaluateContextExpression, evaluateStringValues, hasAnyDecorator, hasDecorator } from './analysis-utils.js';
import { callStringValues, decoratorOptions, parseSecurity, parseTags, readBoolean, type MetadataReader } from './metadata.js';
import { resolveValueSymbol, unwrapExpression } from '@exprtlabs/golem/internal/static-value';
import { NEST_COMMON, NEST_SWAGGER, callArguments, decoratorsOf, propertyInitializer, staticObject } from './symbols.js';
import { classParameterDecorators, parseParameters, parseParameterOverride } from './parameters.js';
import { assertManualResponseContract, parseRequestBody, parseResponses } from './responses.js';
import type {
  ControllerAnalysisResult,
  ControllerRoute,
  DecoratorInfo,
  NestAnalysisContext,
  NestHttpMethod,
} from './types.js';
import { NEST_HTTP_METHODS } from './types.js';

const ROUTE_DECORATORS = new Map<string, NestHttpMethod>(NEST_HTTP_METHODS.map(method => [method[0].toUpperCase() + method.slice(1), method]));
/**
 * `@nestjs/common` route decorators without a lossless OpenAPI operation:
 * catch-all and non-OpenAPI HTTP methods (SEARCH, QUERY, WebDAV), server-sent
 * events, redirects, and the untyped `@RequestMapping`.
 */
const UNSUPPORTED_ROUTE_DECORATORS = new Set([
  'All', 'Sse', 'Redirect',
  'Search', 'QueryMethod', 'Propfind', 'Proppatch', 'Mkcol', 'Copy', 'Move', 'Lock', 'Unlock',
]);

/** `RequestMethod` enum values with an OpenAPI operation, by numeric value (ALL, SEARCH, QUERY and WebDAV have none). */
const REQUEST_METHODS: Readonly<Record<number, NestHttpMethod>> = {
  0: 'get', 1: 'post', 2: 'put', 3: 'delete', 4: 'patch', 6: 'options', 7: 'head',
};

/** More optional path segments than this would emit 2^n operations for one method. */
const MAX_OPTIONAL_SEGMENTS = 4;

interface UriVersioning {
  readonly enabled: boolean;
  readonly prefix: string;
  readonly defaultVersions: readonly string[];
}

export function discoverControllerSources(
  root: string,
  onInput?: (filename: string) => void,
  suffixes: readonly string[] = DEFAULT_CONTROLLER_SUFFIXES,
): string[] {
  return discoverSources(path.join(root, 'src'), { source: suffixPattern(suffixes), onInput });
}
function normalizeSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

function joinRoutePath(...parts: readonly (string | undefined)[]): string {
  const segments = parts
    .filter((part): part is string => part !== undefined && part !== '')
    .flatMap(part => part.split('/').map(normalizeSegment).filter(Boolean));
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function normalizePathParameters(value: string): string {
  return value
    .replace(/:([A-Za-z_$][\w$]*)/g, '{$1}')
    .replace(/\/+/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '') || '/';
}

/**
 * Expand path-to-regexp optional segments, v8 `{/:id}` and v6 `/:id?`, into
 * every concrete path (all segments present first). Names of path parameters
 * that only some of the paths contain are returned so the method's matching
 * `@Param()` can be omitted from the paths without them.
 */
function expandOptionalSegments(
  values: readonly string[],
  node: ts.Node,
): { readonly paths: readonly string[]; readonly optionalNames: ReadonlySet<string> } {
  const paths: string[] = [];
  const optionalNames = new Set<string>();
  for (const value of values) {
    const grouped = value.replace(/(\/?):([A-Za-z_$][\w$]*)\?/g, '{$1:$2}');
    const groups = [...grouped.matchAll(/\{([^{}]*)\}/g)];
    if (groups.length > MAX_OPTIONAL_SEGMENTS) {
      throw new TsToOpenApiError(diagnostic(
        node.getSourceFile(),
        node,
        TsToOpenApiDiagnosticCode.UnsupportedRoutePath,
        `Nest route path ${value} has more than ${MAX_OPTIONAL_SEGMENTS} optional segments.`,
      ));
    }
    for (const group of groups) {
      for (const match of group[1]!.matchAll(/:([A-Za-z_$][\w$]*)/g)) optionalNames.add(match[1]!);
    }
    for (let mask = (1 << groups.length) - 1; mask >= 0; mask -= 1) {
      let index = 0;
      const path = grouped.replace(/\{([^{}]*)\}/g, (_, content: string) => ((mask >> (groups.length - 1 - index++)) & 1 ? content : ''));
      assertPortablePath(path, node);
      paths.push(path);
    }
  }
  return { paths, optionalNames };
}

/**
 * Reject path-to-regexp syntax without an OpenAPI path form: v8 optional
 * groups `{/:id}`, wildcards `*` and `*splat`, v6 optional `:id?`, regex
 * parameters `:id(\\d+)`, quoted names `:"a-b"` and other reserved characters.
 */
function assertPortablePath(value: string, node: ts.Node): void {
  if (/[*?+(){}[\]!\\"]/.test(value)) {
    throw new TsToOpenApiError(diagnostic(
      node.getSourceFile(),
      node,
      TsToOpenApiDiagnosticCode.UnsupportedRoutePath,
      `Nest route path ${value} uses optional, wildcard, regular-expression or quoted segments that have no lossless OpenAPI path representation.`,
    ));
  }
}
function classMethods(
  checker: ts.TypeChecker,
  classDeclaration: ts.ClassLikeDeclaration,
  seen = new Set<ts.ClassLikeDeclaration>(),
): readonly ts.MethodDeclaration[] {
  if (seen.has(classDeclaration)) return [];
  const nextSeen = new Set(seen).add(classDeclaration);
  const inherited: ts.MethodDeclaration[] = [];
  const classType = checker.getTypeAtLocation(classDeclaration);
  for (const baseType of checker.getBaseTypes(classType as ts.InterfaceType) ?? []) {
    for (const declaration of baseClassDeclarations(baseType)) {
      inherited.push(...classMethods(checker, declaration, nextSeen));
    }
  }
  const own = classDeclaration.members.filter(
    (member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && !member.modifiers?.some(item => item.kind === ts.SyntaxKind.StaticKeyword),
  );
  const byName = new Map<string, ts.MethodDeclaration>();
  for (const method of inherited) if (method.name && ts.isIdentifier(method.name)) byName.set(method.name.text, method);
  for (const method of own) if (method.name && ts.isIdentifier(method.name)) byName.set(method.name.text, method);
  return [...byName.values()].sort((left, right) => {
    return compareText(left.getSourceFile().fileName, right.getSourceFile().fileName) || left.getStart() - right.getStart();
  });
}

function exportClass(classDeclaration: ts.ClassDeclaration): boolean {
  return Boolean(classDeclaration.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword));
}
function parseUriVersioning(value: unknown): UriVersioning {
  if (value === undefined || value === null) return { enabled: false, prefix: 'v', defaultVersions: [] };
  if (typeof value === 'string') {
    if (value.toUpperCase() !== 'URI') throw new TsToOpenApiError({ severity: GolemDiagnosticSeverity.Error, code: TsToOpenApiDiagnosticCode.UnsupportedVersioningType, message: `Only URI versioning is supported; received ${value}.` });
    return { enabled: true, prefix: 'v', defaultVersions: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new TsToOpenApiError({ severity: GolemDiagnosticSeverity.Error, code: TsToOpenApiDiagnosticCode.InvalidVersioningOptions, message: 'uriVersioning must be an object describing URI versioning.' });
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (!(type === undefined || type === 0 || type === 'URI' || type === 'uri')) {
    throw new TsToOpenApiError({ severity: GolemDiagnosticSeverity.Error, code: TsToOpenApiDiagnosticCode.UnsupportedVersioningMode, message: 'Only URI versioning is supported by the static Nest adapter.' });
  }
  const prefix = record.prefix === undefined
    ? 'v'
    : record.prefix === false
      ? ''
      : String(record.prefix);
  const defaultVersions = record.defaultVersion === undefined
    ? []
    : Array.isArray(record.defaultVersion)
      ? record.defaultVersion.map(item => String(item))
      : [String(record.defaultVersion)];
  return { enabled: true, prefix: normalizeSegment(prefix), defaultVersions };
}

function classControllerPath(
  checker: ts.TypeChecker,
  classDeclaration: ts.ClassDeclaration,
): { readonly path: ts.Expression | undefined; readonly version?: ts.Expression } {
  const controller = hasDecorator(decoratorsOf(checker, classDeclaration), 'Controller', NEST_COMMON);
  if (!controller) throw new Error(`Controller class ${classDeclaration.name?.text ?? '<anonymous>'} has no @Controller decorator.`);
  const argument = callArguments(controller)[0];
  const object = staticObject(argument);
  if (object && propertyInitializer(object, 'host')) {
    throw new TsToOpenApiError(diagnostic(
      classDeclaration.getSourceFile(),
      object,
      TsToOpenApiDiagnosticCode.HostBasedRouting,
      'Host-based Nest controller routing has no portable OpenAPI path mapping.',
    ));
  }
  return {
    path: object ? propertyInitializer(object, 'path') : argument,
    ...(object && propertyInitializer(object, 'version') ? { version: propertyInitializer(object, 'version') } : {}),
  };
}

interface RouteDecorator {
  readonly decorator: DecoratorInfo;
  readonly method: NestHttpMethod;
  readonly path?: ts.Expression;
}

function unsupportedRoute(decorator: DecoratorInfo, detail = ''): never {
  throw new TsToOpenApiError(diagnostic(
    decorator.decorator.getSourceFile(),
    decorator.decorator,
    TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator,
    `Nest route decorator @${decorator.name}${detail} is not representable in OpenAPI static output.`,
  ));
}

/** `@RequestMapping({ path, method })`; Nest defaults to GET on `/`. */
function requestMappingRoute(reader: MetadataReader, decorator: DecoratorInfo): RouteDecorator {
  const options = decoratorOptions(reader, decorator, 0, TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator);
  const value = options.value('method', TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator) ?? 0;
  const method = typeof value === 'number' ? REQUEST_METHODS[value] : undefined;
  if (!method) unsupportedRoute(decorator, ` with RequestMethod ${String(value)}`);
  const path = options.expression('path');
  return { decorator, method, ...(path ? { path } : {}) };
}

function routeDecorator(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): RouteDecorator | undefined {
  // Check every decorator first so the diagnostic does not depend on decorator order.
  const unsupported = decorators.find(decorator => decorator.packageName === NEST_COMMON
    && decorator.name !== undefined && UNSUPPORTED_ROUTE_DECORATORS.has(decorator.name));
  if (unsupported) unsupportedRoute(unsupported);
  for (const decorator of decorators) {
    if (decorator.packageName !== NEST_COMMON) continue;
    if (decorator.name === 'RequestMapping') return requestMappingRoute(reader, decorator);
    const method = decorator.name ? ROUTE_DECORATORS.get(decorator.name) : undefined;
    const path = callArguments(decorator)[0];
    if (method) return { decorator, method, ...(path ? { path } : {}) };
  }
  return undefined;
}

/** Nest Swagger stores `{ disable }` and skips the endpoint when `disable` is true. */
function apiExcludeEndpointDisable(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): boolean | undefined {
  const matches = [...hasAnyDecorator(decorators, ['ApiExcludeEndpoint'], NEST_SWAGGER)].reverse();
  if (matches.length === 0) return undefined;
  let disable: boolean | undefined;
  for (const decorator of matches) {
    // An omitted argument excludes the endpoint; `false` includes it.
    disable = readBoolean(reader, callArguments(decorator)[0], '@ApiExcludeEndpoint()', TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator) ?? true;
  }
  return disable;
}

/**
 * Whether Swagger omits the endpoint (`@ApiExcludeEndpoint()` or
 * `@ApiOperation({ hidden: true })`). Checked before the route itself, so an
 * excluded catch-all or SSE route never needs an OpenAPI form.
 */
function routeExcluded(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): boolean {
  // SwaggerExplorer skips excluded endpoints before ApiOperation is merged.
  if (apiExcludeEndpointDisable(reader, decorators) === true) return true;
  const operation = hasDecorator(decorators, 'ApiOperation', NEST_SWAGGER);
  return operation !== undefined
    && decoratorOptions(reader, operation).boolean('hidden', TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator) === true;
}

function parseOperation(
  reader: MetadataReader,
  method: ts.MethodDeclaration,
): {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly tags: readonly string[];
  readonly consumes?: readonly string[];
  readonly produces?: readonly string[];
  readonly security?: readonly Record<string, string[]>[];
} {
  const decorators = decoratorsOf(reader.checker, method);
  const operation = hasDecorator(decorators, 'ApiOperation', NEST_SWAGGER);
  const options = operation && decoratorOptions(reader, operation);
  const operationId = options?.string('operationId');
  const summary = options?.documentationString('summary');
  const description = options?.documentationString('description');
  const deprecated = options?.boolean('deprecated');
  const tags = parseTags(reader, decorators);
  const producesDecorator = hasDecorator(decorators, 'ApiProduces', NEST_SWAGGER);
  const consumesDecorator = hasDecorator(decorators, 'ApiConsumes', NEST_SWAGGER);
  const produces = producesDecorator ? callStringValues(reader, producesDecorator) : undefined;
  const consumes = consumesDecorator ? callStringValues(reader, consumesDecorator) : undefined;
  const security = parseSecurity(reader, decorators);
  return {
    ...(operationId ? { operationId } : {}),
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(deprecated === undefined ? {} : { deprecated }),
    tags,
    ...(consumes ? { consumes } : {}),
    ...(produces ? { produces } : {}),
    ...(security ? { security } : {}),
  };
}

function versionExpressions(
  decorators: readonly DecoratorInfo[],
): readonly ts.Expression[] {
  const decorator = hasDecorator(decorators, 'Version', NEST_COMMON);
  return decorator ? [...callArguments(decorator)] : [];
}

function isVersionNeutralExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  return resolveValueSymbol(checker, expression)?.getName() === 'VERSION_NEUTRAL';
}

function versionValues(
  expressions: readonly ts.Expression[],
  context: NestAnalysisContext,
): Promise<readonly string[]> {
  if (expressions.length === 0) return Promise.resolve([]);
  const evaluateOne = (expression: ts.Expression): Promise<readonly string[]> => {
    const unwrapped = unwrapExpression(expression);
    if (ts.isArrayLiteralExpression(unwrapped)) {
      return versionValues([...unwrapped.elements] as ts.Expression[], context);
    }
    const neutral = isVersionNeutralExpression(context.checker, unwrapped);
    if (neutral) return Promise.resolve(['']);
    return evaluateContextExpression(unwrapped, context)
      .then(value => typeof value === 'string' ? [value] : value);
  };
  return Promise.all(expressions.map(evaluateOne))
    .then(values => values.flat());
}
async function analyzeController(
  context: NestAnalysisContext,
  classDeclaration: ts.ClassDeclaration,
  globalPrefix: string | undefined,
  uriVersioning: UriVersioning,
): Promise<readonly ControllerRoute[]> {
  const classDecorators = decoratorsOf(context.checker, classDeclaration);
  const controllerPath = classControllerPath(context.checker, classDeclaration);
  const classExpansion = expandOptionalSegments(await evaluateStringValues(controllerPath.path, context, ['']), classDeclaration);
  const classPaths = classExpansion.paths;
  const classVersionValues = await versionValues(
    controllerPath.version ? [controllerPath.version] : versionExpressions(classDecorators),
    context,
  );
  // @nestjs/swagger class tags and security accumulate along the constructor chain, base first.
  const hierarchy = classHierarchyBaseToDerived(context.checker, classDeclaration).map(item => decoratorsOf(context.checker, item));
  const classTags = hierarchy.flatMap(item => parseTags(context, item));
  const classSecurity = hierarchy.flatMap(item => parseSecurity(context, item) ?? []);
  const methods = classMethods(context.checker, classDeclaration);
  const routes: ControllerRoute[] = [];
  const controllerName = classDeclaration.name?.text
    ?? stripSourceSuffix(path.basename(classDeclaration.getSourceFile().fileName), context.suffixes ?? DEFAULT_CONTROLLER_SUFFIXES);
  for (const method of methods) {
    const decorators = decoratorsOf(context.checker, method);
    if (routeExcluded(context, decorators)) continue;
    const selected = routeDecorator(context, decorators);
    if (!selected) continue;
    const routeExpansion = expandOptionalSegments(await evaluateStringValues(selected.path, context, ['']), selected.decorator.decorator);
    const routePaths = routeExpansion.paths;
    const optionalNames = new Set([...classExpansion.optionalNames, ...routeExpansion.optionalNames]);
    const operation = parseOperation(context, method);
    const parameterResult = parseParameters(context, method, classDeclaration);
    const methodVersions = await versionValues(versionExpressions(decorators), context);
    const versions = methodVersions.length > 0 ? methodVersions : classVersionValues.length > 0 ? classVersionValues : uriVersioning.defaultVersions.length > 0 ? uriVersioning.defaultVersions : [''];
    const normalizedVersions = versions.length > 0 ? versions : [''];
    const effectiveVersions = uriVersioning.enabled
      ? normalizedVersions
      : normalizedVersions.filter(version => version === '');
    if (!uriVersioning.enabled && normalizedVersions.some(version => version !== '')) {
      throw new TsToOpenApiError(diagnostic(method.getSourceFile(), method, TsToOpenApiDiagnosticCode.VersionWithoutUriRouting, 'Route versions require uriVersioning.type="URI" so each version has a distinct OpenAPI path.'));
    }
    const responses = parseResponses(context, method, selected.method, classDeclaration);
    assertManualResponseContract(method, responses, parameterResult.manualResponse);
    const parsedBody = parseRequestBody(context, decorators);
    // SwaggerExplorer.mergeValues concatenates class-level and method-level security arrays.
    const security = [...classSecurity, ...operation.security ?? []];
    const apiBody = parsedBody && parameterResult.body
      ? { ...parsedBody, declaredType: parameterResult.body.type }
      : parsedBody;
    const parameterOverrides = {
      ...parseParameterOverride(context, classParameterDecorators(context.checker, method, classDeclaration)),
      ...parseParameterOverride(context, decorators),
    };
    const pathExpansion = routePaths.length > 1 || classPaths.length > 1;
    const versionExpansion = effectiveVersions.length > 1;
    const operationBase = operation.operationId ?? `${controllerName}_${method.name.getText()}`;
    let pathExpansionIndex = 0;
    for (let classPathIndex = 0; classPathIndex < classPaths.length; classPathIndex += 1) {
      for (let pathIndex = 0; pathIndex < routePaths.length; pathIndex += 1) {
      for (let versionIndex = 0; versionIndex < effectiveVersions.length; versionIndex += 1) {
        const version = effectiveVersions[versionIndex];
        const versionPath = version && uriVersioning.enabled
          ? joinRoutePath(`${uriVersioning.prefix}${version}`)
          : undefined;
        const routePath = normalizePathParameters(joinRoutePath(
          globalPrefix,
          versionPath,
          classPaths[classPathIndex],
          routePaths[pathIndex],
        ));
        const suffix = [
          pathExpansion ? `path_${pathExpansionIndex + 1}` : '',
          versionExpansion ? `version_${versionIndex + 1}` : '',
        ].filter(Boolean).join('__');
        const operationId = suffix ? `${operationBase}__${suffix}` : operationBase;
        const placeholders = [...routePath.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
        // A parameter of an optional segment is absent from the paths without that segment.
        const parameters = parameterResult.parameters.filter(parameter => parameter.location !== 'path'
          || placeholders.includes(String(parameter.name))
          || !optionalNames.has(String(parameter.name)));
        routes.push({
          controller: controllerName,
          methodName: method.name.getText(),
          method,
          sourceFile: method.getSourceFile(),
          httpMethod: selected.method,
          path: routePath,
          operationId,
          ...(operation.summary ? { summary: operation.summary } : {}),
          ...(operation.description ? { description: operation.description } : {}),
          tags: [...new Set([...classTags, ...operation.tags])],
          parameters,
          ...(parameterResult.body ? { body: parameterResult.body } : {}),
          responses,
          ...(apiBody ? { requestBody: apiBody } : {}),
          ...(Object.keys(parameterOverrides).length > 0 ? { parameterOverrides } : {}),
          ...(operation.consumes ? { consumes: operation.consumes } : {}),
          ...(operation.produces ? { produces: operation.produces } : {}),
          ...(security.length > 0 ? { security } : {}),
          ...(operation.deprecated === undefined ? {} : { deprecated: operation.deprecated }),
        });
      }
      pathExpansionIndex += 1;
      }
    }
  }
  return routes;
}

/**
 * Nest Swagger stores the argument of `@ApiExcludeController(disable = true)`
 * and skips the controller when the first stored value (the decorator nearest
 * the class) is true.
 */
function apiExcludeController(reader: MetadataReader, decorators: readonly DecoratorInfo[]): boolean {
  const nearest = hasAnyDecorator(decorators, ['ApiExcludeController'], NEST_SWAGGER).at(-1);
  if (!nearest) return false;
  return readBoolean(reader, callArguments(nearest)[0], '@ApiExcludeController()', TsToOpenApiDiagnosticCode.UnsupportedRouteDecorator) ?? true;
}

function exportedControllerClasses(
  context: NestAnalysisContext,
  sourceFile: ts.SourceFile,
): readonly ts.ClassDeclaration[] {
  const controllers: ts.ClassDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !exportClass(statement)) continue;
    const decorators = decoratorsOf(context.checker, statement);
    if (apiExcludeController(context, decorators)) continue;
    if (hasDecorator(decorators, 'Controller', NEST_COMMON)) controllers.push(statement);
  }
  return controllers;
}

export async function analyzeControllers(
  context: NestAnalysisContext,
  options: { readonly globalPrefix?: string; readonly uriVersioning?: unknown } = {},
): Promise<ControllerAnalysisResult> {
  const uriVersioning = parseUriVersioning(options.uriVersioning);
  const routes: ControllerRoute[] = [];
  let controllerCount = 0;
  for (const filename of context.sources) {
    const sourceFile = context.program.getSourceFile(filename);
    if (!sourceFile) {
      throw new Error(`Could not load controller source: ${filename}`);
    }
    for (const declaration of exportedControllerClasses(context, sourceFile)) {
      routes.push(...await analyzeController(context, declaration, options.globalPrefix, uriVersioning));
      controllerCount += 1;
    }
  }
  if (controllerCount === 0) {
    throw new TsToOpenApiError({
      severity: GolemDiagnosticSeverity.Error,
      code: TsToOpenApiDiagnosticCode.NoExportedControllers,
      message: 'No exported @Controller classes were found in the controller files. Export at least one @Controller class, or list the files that declare it in `sources` of the controller job. In code, pass them as the `sources` option of `generate`.',
    });
  }
  return { routes };
}
