import * as ts from '@exprtlabs/golem/internal/ts';
import {
  TsToOpenApiDiagnosticCode,
  TsToOpenApiError,
  diagnostic,
} from '../diagnostics.js';
import {
  authoritativeTypeReference,
  classHierarchyBaseToDerived,
  containsUndefined,
  controllerMethodSignature,
  controllerParameterType,
  hasAnyDecorator,
  hasDecorator,
  hasWholeObjectContract,
  isFlatParameterType,
  isIndexSignatureType,
  isOptionalParameter,
  parameterProperties,
  parameterPropertyTypeNode,
  typeExpressionFromApiOption,
  typeReference,
} from './analysis-utils.js';
import { evaluateStaticValue, isStaticArray } from '../evaluation/static-value.js';
import { decoratorOptions, headerOptionsList, readString, type DecoratorOptions, type MetadataReader } from './metadata.js';
import { NEST_COMMON, NEST_SWAGGER, callArguments, decoratorsOf, staticObject } from './symbols.js';
import type { ControllerParameter, DecoratorInfo, NestAnalysisContext, TypeReference } from './types.js';

/** `@nestjs/swagger` parameter decorators and the location each documents. */
const SWAGGER_PARAMETER_LOCATIONS: readonly (readonly [readonly string[], 'query' | 'path' | 'header'])[] = [
  [['ApiQuery'], 'query'],
  [['ApiParam'], 'path'],
  [['ApiHeader', 'ApiHeaders'], 'header'],
];

interface ParameterOptions {
  readonly decorator: DecoratorInfo;
  readonly options: DecoratorOptions;
}

/**
 * The options of each parameter that the decorators document. `@ApiHeaders([...])`
 * is a list of `@ApiHeader` options, so each entry is one parameter.
 */
function parameterOptionsOf(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
  names: readonly string[],
): readonly ParameterOptions[] {
  return hasAnyDecorator(decorators, names, NEST_SWAGGER).flatMap((decorator): readonly ParameterOptions[] => {
    if (decorator.name !== 'ApiHeaders') return [{ decorator, options: decoratorOptions(reader, decorator) }];
    return headerOptionsList(reader, decorator).map(options => ({ decorator, options }));
  });
}

/**
 * The decorators in the order TypeScript applies them: bottom-up within one
 * declaration. `@nestjs/swagger` appends each parameter as its decorator runs, so
 * stacked `@ApiHeader(A) @ApiHeader(B)` lists B first. The declarations of a class
 * chain keep their order, base class first.
 */
function inApplicationOrder(decorators: readonly DecoratorInfo[]): readonly DecoratorInfo[] {
  const ordered: DecoratorInfo[] = [];
  let run: DecoratorInfo[] = [];
  for (const decorator of decorators) {
    if (run.length > 0 && run[0].decorator.parent !== decorator.decorator.parent) {
      ordered.push(...run.reverse());
      run = [];
    }
    run.push(decorator);
  }
  return [...ordered, ...run.reverse()];
}

/**
 * The key of a parameter override: OpenAPI identifies a parameter by name and
 * location together. `@ApiQuery` documents the query string, so it also names
 * an OAS 3.2 `querystring` parameter (a whole `@Query()` object).
 */
export function parameterOverrideKey(location: string, name: string): string {
  return `${location === 'querystring' ? 'query' : location}:${name}`;
}

/**
 * The class-level Swagger parameter decorators of a route, base class first.
 * `@nestjs/swagger` merges `@ApiHeader` from the whole constructor chain into
 * every route, and applies `@ApiQuery` and `@ApiParam` only to the methods
 * that the decorated class itself declares.
 */
export function classParameterDecorators(
  checker: ts.TypeChecker,
  method: ts.MethodDeclaration,
  controllerClass: ts.ClassLikeDeclaration,
): readonly DecoratorInfo[] {
  const headers = classHierarchyBaseToDerived(checker, controllerClass)
    .flatMap(declaration => hasAnyDecorator(decoratorsOf(checker, declaration), ['ApiHeader', 'ApiHeaders'], NEST_SWAGGER));
  const declaring = method.parent;
  const own = ts.isClassLike(declaring)
    ? hasAnyDecorator(decoratorsOf(checker, declaring), ['ApiQuery', 'ApiParam'], NEST_SWAGGER)
    : [];
  return [...headers, ...own];
}

export function parseParameterOverride(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  const declared = SWAGGER_PARAMETER_LOCATIONS.flatMap(([names, location]) => (
    parameterOptionsOf(reader, decorators, names).map(entry => [entry, location] as const)
  ));
  for (const [{ decorator, options }, location] of declared) {
    const name = options.string('name');
    if (!name) continue;
    const typed = typeExpressionFromApiOption(reader.checker, options.expression('type'));
    const enumValues = options.value('enum');
    if (enumValues !== undefined && !isStaticArray(enumValues)) {
      throw new TsToOpenApiError(diagnostic(
        decorator.decorator.getSourceFile(),
        options.node('enum'),
        TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
        `@${decorator.name}({ enum }) must be an array or an enum.`,
      ));
    }
    const required = options.boolean('required');
    const entries: Record<string, unknown> = {
      description: options.documentationString('description') || undefined,
      // @nestjs/swagger merges `required: true` defaults into @ApiQuery and @ApiParam, not @ApiHeader.
      required: required ?? (location === 'header' ? undefined : true),
      requiredDefaulted: required === undefined && location !== 'header' ? true : undefined,
      deprecated: options.boolean('deprecated'),
      explode: options.boolean('explode'),
      style: options.string('style') || undefined,
      example: options.documentation('example'),
      default: options.value('default'),
      enum: enumValues,
      schema: options.record('schema'),
    };
    result[parameterOverrideKey(location, name)] = {
      ...Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)),
      ...(typed.type ? { type: typed.type, ...(typed.isArray || options.boolean('isArray') === true ? { isArray: true } : {}) } : {}),
    };
  }
  return result;
}

/**
 * The key named by `@Query('key')`-style decorators. The first argument may
 * instead be a pipe (`@Query(ParseIntPipe)`), which names no key.
 */
function parameterKey(reader: MetadataReader, decorator: DecoratorInfo): string | undefined {
  const argument = callArguments(decorator)[0];
  if (!argument) return undefined;
  const result = evaluateStaticValue(reader.checker, argument);
  if (result.ok && typeof result.value === 'string') return result.value;
  if ((reader.checker.getTypeAtLocation(argument).flags & ts.TypeFlags.StringLike) === 0) return undefined;
  return readString(reader, argument, `@${decorator.name}() key`);
}

function parameterLocation(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): { readonly location?: ControllerParameter['location']; readonly name?: string; readonly unsupported?: string } {
  const locations: readonly [string, ControllerParameter['location']][] = [
    ['Body', 'body'],
    ['Query', 'query'],
    ['Param', 'path'],
    ['Headers', 'header'],
  ];
  for (const [name, location] of locations) {
    const decorator = hasDecorator(decorators, name, NEST_COMMON);
    if (decorator) return { location, name: parameterKey(reader, decorator) };
  }
  const unsupported = decorators.find(item => item.packageName === NEST_COMMON && [
    'Req', 'Request', 'Res', 'Response', 'Next', 'Session', 'Ip',
    'UploadedFile', 'UploadedFiles', 'RawBody', 'HostParam',
  ].includes(item.name ?? ''));
  return unsupported ? { unsupported: unsupported.name } : {};
}

/**
 * `@Res({ passthrough })`: true keeps Nest's inferred return; false or omitted
 * is a manual response. The options must be written inline because they decide
 * whether the method's return type is the response contract at all.
 */
function resPassthrough(
  reader: MetadataReader,
  decorator: DecoratorInfo,
): boolean {
  const argument = callArguments(decorator)[0];
  if (argument === undefined) return false;
  if (!staticObject(argument)) {
    throw new TsToOpenApiError(diagnostic(
      argument.getSourceFile(),
      argument,
      TsToOpenApiDiagnosticCode.UnsupportedNestParameter,
      `@${decorator.name}() options must be an inline object; set passthrough: true to keep Nest's inferred return, or omit/false and declare an explicit Swagger success response.`,
    ));
  }
  return decoratorOptions(reader, decorator, 0, TsToOpenApiDiagnosticCode.UnsupportedNestParameter)
    .boolean('passthrough', TsToOpenApiDiagnosticCode.UnsupportedNestParameter) ?? false;
}

function flattenParameter(
  context: NestAnalysisContext,
  parameter: ts.ParameterDeclaration,
  parameterType: TypeReference,
  location: Exclude<ControllerParameter['location'], 'body' | undefined>,
): readonly ControllerParameter[] {
  // Keep the declaration-site type (including an optional `| undefined`) unless an inherited generic was instantiated.
  const type = parameterType.node ? context.checker.getTypeAtLocation(parameter) : parameterType.type;
  if (isIndexSignatureType(context.checker, type)) {
    throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.UnknownParameterKeys, `Cannot flatten @${location} object ${context.checker.typeToString(type)} because its index signature admits unknown keys.`));
  }
  const properties = parameterProperties(context, parameter, type);
  if (properties.length === 0) {
    throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPrimitiveParameter, `Cannot flatten @${location} parameter ${context.checker.typeToString(type)}; use a named primitive parameter or an explicit Swagger contract.`));
  }
  const portable = properties.every(property => {
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations?.[0] ?? parameter);
    return isFlatParameterType(context.checker, propertyType);
  });
  if (!portable) {
    throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPortableParameter, `Cannot flatten @${location} parameter ${context.checker.typeToString(type)}; only primitive and primitive-array properties have portable OpenAPI parameter mappings.`));
  }
  if (location === 'query' && context.openapiVersion === '3.2.0') {
    return [{
      node: parameter,
      type: parameterType,
      location: 'querystring',
      name: ts.isIdentifier(parameter.name) ? parameter.name.text : 'query',
      required: !isOptionalParameter(parameter, type),
    } satisfies ControllerParameter];
  }
  if (location === 'query' && hasWholeObjectContract(context, parameter, type)) {
    throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.LossyQueryFlatten, 'OpenAPI 3.1 cannot preserve whole-query object constraints or codecs when flattening. Use OpenAPI 3.2 querystring or a named primitive query contract.'));
  }
  return properties.map(property => {
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations?.[0] ?? parameter);
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyNode = parameterPropertyTypeNode(property);
    return {
      node: parameter,
      type: typeReference(context.checker, declaration ?? parameter, propertyNode),
      location,
      name: property.name,
      required: !(property.flags & ts.SymbolFlags.Optional) && !containsUndefined(propertyType),
      ...(location !== 'query' || parameterType.modelContractName === undefined ? {} : { wholeQueryModel: parameterType.modelContractName }),
    } satisfies ControllerParameter;
  });
}

/** A parameter's type reference; an inherited generic parameter drops the `T` syntax for its instantiated type. */
function methodParameterReference(
  checker: ts.TypeChecker,
  signature: ts.Signature | undefined,
  parameter: ts.ParameterDeclaration,
  index: number,
  controllerClass: ts.ClassDeclaration,
): TypeReference {
  const declared = typeReference(checker, parameter, parameter.type);
  const type = controllerParameterType(checker, signature, parameter, index, controllerClass);
  return type === declared.type ? declared : typeReference(checker, parameter, undefined, type);
}

function querystringHasProperty(context: NestAnalysisContext, parameter: ControllerParameter, name: string): boolean {
  if (parameter.location !== 'querystring' || !ts.isParameter(parameter.node)) return false;
  return parameterProperties(context, parameter.node, parameter.type.type).some(property => property.name === name);
}

/**
 * OpenAPI identifies a parameter by (name, in), and OAS 3.2 forbids a
 * `querystring` parameter beside `query` parameters or a second `querystring`.
 */
function assertDistinctParameters(context: NestAnalysisContext, parameters: readonly ControllerParameter[]): void {
  const seen = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.location === 'querystring' || parameter.name === undefined) continue;
    const key = parameterOverrideKey(String(parameter.location), parameter.name);
    if (seen.has(key)) {
      throw new TsToOpenApiError(diagnostic(
        parameter.node.getSourceFile(),
        parameter.node,
        TsToOpenApiDiagnosticCode.DuplicateParameter,
        `Parameter ${parameter.name} in ${parameter.location} is declared more than once for this operation.`,
      ));
    }
    seen.add(key);
  }
  const querystrings = parameters.filter(parameter => parameter.location === 'querystring');
  if (querystrings.length === 0) return;
  const conflicting = querystrings.length > 1 ? querystrings[1] : parameters.find(parameter => parameter.location === 'query');
  if (!conflicting) return;
  throw new TsToOpenApiError(diagnostic(
    conflicting.node.getSourceFile(),
    conflicting.node,
    TsToOpenApiDiagnosticCode.NonPortableParameter,
    `OpenAPI ${context.openapiVersion ?? '3.2.0'} sends a whole @Query() object as one querystring parameter, which cannot be combined with another @Query() object or with named query parameters (@Query('name') or @ApiQuery). Move the field into the query DTO and document it with @ApiProperty.`,
  ));
}

/** The item type node of `T[]`, `Array<T>`, `ReadonlyArray<T>` or a qualified spelling such as `globalThis.Array<T>`, through parentheses and `readonly`: the array forms the rewrite stamps with a model. */
function arrayItemNode(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (node === undefined) return undefined;
  if (ts.isParenthesizedTypeNode(node)) return arrayItemNode(node.type);
  if (ts.isTypeOperatorNode(node)) return node.operator === ts.SyntaxKind.ReadonlyKeyword ? arrayItemNode(node.type) : undefined;
  let item: ts.TypeNode | undefined;
  if (ts.isArrayTypeNode(node)) item = node.elementType;
  else if (ts.isTypeReferenceNode(node) && ['Array', 'ReadonlyArray'].includes(ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text)) item = node.typeArguments?.length === 1 ? node.typeArguments[0] : undefined;
  while (item !== undefined && ts.isParenthesizedTypeNode(item)) item = item.type;
  return item;
}

interface OneFieldKind {
  /** A model, an array of models, or an optional one of them (`x?: TModel`, which NestModelInterceptor answers HTTP 400 for when the value is missing). */
  readonly kind: 'model' | 'optional model' | 'other';
  readonly array: boolean;
  /** The parameter's type; an array of models carries the model id of its items. */
  readonly type: TypeReference;
}

/** What a one-field `@Body('x')` or `@Query('x')` parameter is for NestModelInterceptor: a model, an array of models (one `T[]` level), or another type. */
function oneFieldKind(context: NestAnalysisContext, parameter: ts.ParameterDeclaration, parameterType: TypeReference): OneFieldKind {
  // `x?: TModel` has the declared type node `TModel`; `x: TModel | undefined` is a union with one member besides undefined.
  const declared = parameter.type ? typeReference(context.checker, parameter, parameter.type) : parameterType;
  const members = declared.type.isUnion() ? declared.type.types.filter(item => (item.flags & ts.TypeFlags.Undefined) === 0) : [];
  const bare = authoritativeTypeReference(context, members.length === 1 ? typeReference(context.checker, parameter, undefined, members[0]) : declared)!;
  // The model of an item comes from the item's type node: the checker's type argument has lost the alias that names the model.
  const item = bare.modelContractName === undefined ? arrayItemNode(parameter.type) : undefined;
  const itemModel = item === undefined ? undefined : authoritativeTypeReference(context, typeReference(context.checker, parameter, item))!.modelContractName;
  if (bare.modelContractName === undefined && itemModel === undefined) return { kind: 'other', array: false, type: parameterType };
  return {
    kind: isOptionalParameter(parameter, parameterType.type) ? 'optional model' : 'model',
    array: itemModel !== undefined,
    type: itemModel === undefined ? parameterType : { ...parameterType, modelContractName: itemModel },
  };
}

/** The path of the first array or tuple field at any depth of an object type, such as `tags` or `inner.tags`. */
function arrayFieldPath(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, seen: Set<ts.Type> = new Set()): string | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);
  if (type.isUnion() || type.isIntersection()) {
    for (const member of type.types) {
      const found = arrayFieldPath(checker, member, node, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) return '';
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
  for (const property of checker.getPropertiesOfType(type)) {
    const found = arrayFieldPath(checker, checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? node), node, seen);
    if (found !== undefined) return found === '' ? property.name : `${property.name}.${found}`;
  }
  return undefined;
}

export function parseParameters(
  context: NestAnalysisContext,
  method: ts.MethodDeclaration,
  controllerClass: ts.ClassDeclaration,
): {
  readonly parameters: readonly ControllerParameter[];
  readonly body?: ControllerParameter;
  readonly manualResponse?: ts.ParameterDeclaration;
} {
  const parameters: ControllerParameter[] = [];
  let body: ControllerParameter | undefined;
  let manualResponse: ts.ParameterDeclaration | undefined;
  // A whole @Query() and a one-field model @Query('x') both replace the query, and the interceptor cannot convert both.
  let wholeQuery = false;
  let namedModelQuery: ts.ParameterDeclaration | undefined;
  const mixedQuery = (parameter: ts.ParameterDeclaration, name: string | undefined): TsToOpenApiError => new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPortableParameter, `${name === undefined ? '@Query()' : `@Query("${name}")`} cannot share an operation with ${name === undefined ? 'a one-field model @Query("field")' : 'a whole @Query()'}: both read the query. Declare the whole query as one model, or use one-field parameters only.`));
  const signature = controllerMethodSignature(context.checker, method, controllerClass);
  method.parameters.forEach((parameter, index) => {
    const decorators = decoratorsOf(context.checker, parameter);
    const location = parameterLocation(context, decorators);
    if (location.unsupported) {
      if (location.unsupported === 'Res' || location.unsupported === 'Response') {
        const decorator = hasDecorator(decorators, location.unsupported, NEST_COMMON);
        if (decorator && resPassthrough(context, decorator)) return;
        manualResponse = parameter;
        return;
      }
      if (['Req', 'Request', 'Next', 'Session', 'Ip'].includes(location.unsupported)) return;
      throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.UnsupportedNestParameter, `Nest parameter decorator @${location.unsupported} injects runtime request state and has no OpenAPI parameter mapping.`));
    }
    if (!location.location) {
      if (decorators.some(item => item.packageName === NEST_COMMON)) {
        throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.UnrepresentableNestParameter, 'A Nest parameter decorator is not representable as an OpenAPI parameter.'));
      }
      return;
    }
    const parameterType = authoritativeTypeReference(
      context,
      methodParameterReference(context.checker, signature, parameter, index, controllerClass),
    )!;
    const required = !isOptionalParameter(parameter, parameterType.type);
    const name = location.name;
    if (location.location === 'body') {
      // The interceptor reads a whole body or its fields, never both, and it converts only a model field.
      if (name !== undefined ? body !== undefined : parameters.some(item => item.location === 'body')) {
        throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NamedBodyParameter, `@Body(${name === undefined ? '' : `"${name}"`}) cannot share an operation with ${name === undefined ? 'a one-field @Body("field")' : 'a whole @Body()'}: both read the request body. Declare the whole body as one model, or use one-field parameters only.`));
      }
      if (name !== undefined) {
        const field = oneFieldKind(context, parameter, parameterType);
        if (field.kind !== 'model') {
          throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NamedBodyParameter, field.kind === 'optional model'
            ? `@Body("${name}") is an optional one-field model or array of models, which NestModelInterceptor does not support: it answers HTTP 400 for a missing value. Make the parameter required.`
            : `@Body("${name}") must be an IModel or IObject, or an array of one written as a type, such as TPayment[]; any other type needs a whole @Body() or an explicit request-body contract.`));
        }
        parameters.push({ node: parameter, type: field.type, location: 'body', name, required: true });
        return;
      }
      body = {
        node: parameter,
        type: parameterType,
        location: 'body',
        required,
      };
      return;
    }
    if (name !== undefined) {
      // A model in a named query parameter is a deepObject (`name[field]=value`), which the interceptor reads and converts.
      const field = location.location === 'query' ? oneFieldKind(context, parameter, parameterType) : undefined;
      const kind = field?.kind ?? 'other';
      if (field?.array) {
        throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPortableParameter, `@Query("${name}") is an array of models, and OpenAPI does not define arrays in a deepObject query parameter. Send the array in a @Body.`));
      }
      if (kind === 'optional model') {
        throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPortableParameter, `@Query("${name}") is an optional one-field model, which NestModelInterceptor does not support: it answers HTTP 400 for a missing value. Make the parameter required.`));
      }
      if (kind === 'model') {
        if (wholeQuery) throw mixedQuery(parameter, name);
        const arrayField = arrayFieldPath(context.checker, parameterType.type, parameter);
        if (arrayField !== undefined) {
          throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPortableParameter, `@Query("${name}") has an array field (${arrayField}), and OpenAPI does not define arrays in a deepObject query parameter. Send the array in a @Body or in a whole @Query() on OpenAPI 3.2.`));
        }
        namedModelQuery = parameter;
      } else if (!isFlatParameterType(context.checker, parameterType.type)) {
        throw new TsToOpenApiError(diagnostic(parameter.getSourceFile(), parameter, TsToOpenApiDiagnosticCode.NonPortableParameter, `Named @${location.location} parameter ${name} must be primitive, a primitive array${location.location === 'query' ? ' or an IModel or IObject' : ''}; use a whole @Query() object in OpenAPI 3.2 or an explicit supported contract.`));
      }
      parameters.push({
        node: parameter,
        type: parameterType,
        location: location.location,
        name,
        required: location.location === 'path' || kind === 'model' ? true : required,
      });
      return;
    }
    if (location.location === 'query') {
      if (namedModelQuery) throw mixedQuery(parameter, undefined);
      wholeQuery = true;
    }
    parameters.push(...flattenParameter(context, parameter, parameterType, location.location));
  });
  const methodDecorators = decoratorsOf(context.checker, method);
  const classDecorators = classParameterDecorators(context.checker, method, controllerClass);
  // `@nestjs/swagger` puts class-level headers before the route's own parameters.
  const classHeaders: ControllerParameter[] = [];
  for (const [decoratorNames, location] of SWAGGER_PARAMETER_LOCATIONS) {
    const inherited = [...parameterOptionsOf(context, inApplicationOrder(classDecorators), decoratorNames)].reverse();
    // A method's declaration wins over its class's, and a derived class's over its base's.
    for (const entry of [...parameterOptionsOf(context, inApplicationOrder(methodDecorators), decoratorNames), ...inherited]) {
      const { options } = entry;
      const name = options.string('name');
      if (!name || [...parameters, ...classHeaders].some(parameter => parameter.name === name
        && parameterOverrideKey(String(parameter.location), name) === parameterOverrideKey(location, name))) continue;
      // In OpenAPI 3.2 a query DTO field is documented inside the querystring schema, as 3.1 documents its flattened parameter.
      if (location === 'query' && parameters.some(parameter => querystringHasProperty(context, parameter, name))) continue;
      const typed = typeExpressionFromApiOption(context.checker, options.expression('type'));
      const type = typed.type ?? {
        type: context.checker.getStringType(),
        sourceFile: method.getSourceFile(),
      } satisfies TypeReference;
      (location === 'header' && inherited.includes(entry) ? classHeaders : parameters).push({
        node: method,
        type,
        location,
        name,
        // @nestjs/swagger defaults @ApiQuery and @ApiParam to required; @ApiHeader passes `required` through.
        required: location === 'header' ? options.boolean('required') === true : options.boolean('required') !== false,
      });
    }
  }
  const allParameters = [...classHeaders.reverse(), ...parameters];
  assertDistinctParameters(context, allParameters);
  return { parameters: allParameters, ...(body ? { body } : {}), ...(manualResponse ? { manualResponse } : {}) };
}
