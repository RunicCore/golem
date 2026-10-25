import { compareText } from '@exprtlabs/golem/generator-api';
import * as ts from '@exprtlabs/golem/internal/ts';
import { TsToOpenApiDiagnosticCode, TsToOpenApiError, diagnostic } from './diagnostics.js';
import { mergeSchemaMetadata } from './nest/json-schema-merge.js';
import type { ControllerParameter, ControllerRoute, ResponseDescription, TypeReference } from './nest/types.js';
import { parameterOverrideKey } from './nest/parameters.js';

export type OpenApiSchema = Record<string, unknown> | boolean;

export interface SchemaResolutionContext {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly reference: TypeReference;
  readonly sourceNode?: ts.Node;
  readonly location?: string;
}

export type SchemaResolver = (
  context: SchemaResolutionContext,
) => OpenApiSchema | Promise<OpenApiSchema>;

export interface OperationBuildContext {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly openapiVersion?: '3.2.0' | '3.1.2';
  readonly schemaResolver?: SchemaResolver;
  /** Resolve shared component descriptors while checking explicit Swagger overlays. */
  readonly resolveSchemaReference?: (reference: string) => OpenApiSchema | undefined;
}

interface OperationBuildResult {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function schemaFor(
  context: OperationBuildContext,
  reference: TypeReference,
  direction: 'request' | 'response' | 'parameter',
  location?: string,
  override?: OpenApiSchema,
): Promise<OpenApiSchema> {
  if (!context.schemaResolver) {
    throw new TsToOpenApiError(diagnostic(
      reference.sourceFile,
      reference.node ?? reference.declaration,
      TsToOpenApiDiagnosticCode.MissingSchemaResolver,
      `No canonical schema resolver was supplied for ${direction} type ${context.checker.typeToString(reference.type)}. The Nest adapter does not infer schemas independently; connect the shared type-analysis assembler.`,
    ));
  }
  const canonical = await context.schemaResolver({
    checker: context.checker,
    program: context.program,
    reference,
    ...(reference.sourceNode ? { sourceNode: reference.sourceNode } : {}),
    ...(location ? { location } : {}),
  });
  if (override === undefined) return canonical;
  return mergeSchemaMetadata(canonical, override, {
    authoritative: reference.modelContractName !== undefined,
    hint: contractHint(direction),
    resolveReference: context.resolveSchemaReference,
    sourceFile: reference.sourceFile,
    node: reference.sourceNode ?? reference.node ?? reference.declaration,
    ...(location ? { location } : {}),
  });
}

/** What a user changes when Swagger metadata contradicts the TypeScript type at a site. */
function contractHint(direction: 'request' | 'response' | 'parameter'): string {
  const declaration = direction === 'response' ? 'the method return type' : 'the parameter type';
  return `If the Swagger metadata describes the intended contract, declare ${declaration} explicitly with that type; otherwise correct the Swagger metadata.`;
}

/**
 * An explicit Swagger schema that composes components (`$ref`, `oneOf`,
 * `anyOf`, `allOf`) is the documented contract of an ordinary, non-IModel
 * type. Merging it into the inline TypeScript schema would emit both shapes,
 * so it replaces the inline schema; IModel contracts stay authoritative.
 */
function explicitCompositionSchema(reference: TypeReference, schema: unknown): OpenApiSchema | undefined {
  const value = record(schema);
  if (!value || reference.modelContractName !== undefined) return undefined;
  return ['$ref', 'oneOf', 'anyOf', 'allOf'].some(key => key in value) ? value : undefined;
}

function arraySchema(schema: OpenApiSchema): OpenApiSchema {
  return { type: 'array', items: schema };
}

function primitiveResponseType(checker: ts.TypeChecker, type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): boolean {
  // A recursive alias (`type Json = ... | Json[]`) meets its own type again; a repeat adds no non-primitive member.
  if (seen.has(type)) return true;
  const inside = new Set(seen).add(type);
  if (type.isUnion()) {
    const members = type.types.filter(item => (item.flags & ts.TypeFlags.Undefined) === 0);
    return members.length > 0 && members.every(item => primitiveResponseType(checker, item, inside));
  }
  if (checker.isArrayType(type)) {
    const item = checker.getTypeArguments(type as ts.TypeReference)[0];
    return item !== undefined && primitiveResponseType(checker, item, inside);
  }
  return (type.flags & (
    ts.TypeFlags.StringLike
    | ts.TypeFlags.NumberLike
    | ts.TypeFlags.BooleanLike
    | ts.TypeFlags.BigIntLike
    | ts.TypeFlags.Null
  )) !== 0;
}

function primitiveResponseSchema(checker: ts.TypeChecker, type: ts.Type): OpenApiSchema | undefined {
  if (type.isUnion()) {
    const members = type.types.filter(item => (item.flags & ts.TypeFlags.Undefined) === 0);
    const schemas = members.map(member => primitiveResponseSchema(checker, member));
    if (!schemas.every((item): item is OpenApiSchema => item !== undefined)) return undefined;
    // `true | false` is one boolean schema, not two.
    const distinct = [...new Map(schemas.map(item => [JSON.stringify(item), item])).values()];
    return distinct.length === 1 ? distinct[0] : { anyOf: distinct };
  }
  if (checker.isArrayType(type)) {
    const item = checker.getTypeArguments(type as ts.TypeReference)[0];
    const itemSchema = item ? primitiveResponseSchema(checker, item) : undefined;
    return itemSchema === undefined ? undefined : { type: 'array', items: itemSchema };
  }
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { type: 'string' };
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { type: 'number' };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { type: 'boolean' };
  if ((type.flags & ts.TypeFlags.BigIntLike) !== 0) return { type: 'integer', format: 'int64' };
  if ((type.flags & ts.TypeFlags.Null) !== 0) return { type: 'null' };
  return undefined;
}

function requiresExplicitResponseMetadata(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(member => requiresExplicitResponseMetadata(checker, member));
  const symbol = type.aliasSymbol ?? type.getSymbol?.();
  const name = symbol?.getName() ?? checker.typeToString(type);
  return new Set([
    'StreamableFile',
    'Readable',
    'ReadableStream',
    'ReadableStreamDefaultReader',
    'Buffer',
    'Uint8Array',
    'Subject',
    'AsyncIterable',
  ]).has(name)
    || /(?:^|\.)ReadableStream$/.test(checker.typeToString(type));
}

function pathParameterNames(pathname: string): readonly string[] {
  return [...pathname.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
}

function parameterOverride(
  route: ControllerRoute,
  parameter: ControllerParameter,
): Readonly<Record<string, unknown>> | undefined {
  return parameter.name && parameter.location
    ? route.parameterOverrides?.[parameterOverrideKey(parameter.location, parameter.name)]
    : undefined;
}

/** Schema keywords an `@ApiQuery` override may set on a parameter or query DTO field. */
const PARAMETER_SCHEMA_KEYS = ['enum', 'default', 'example', 'examples', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern'] as const;

/**
 * Apply `@ApiQuery({ name })` metadata for fields of an OAS 3.2 querystring
 * DTO to that field's schema, as OpenAPI 3.1 applies it to the flattened
 * parameter. An implicit `required: true` default does not override an
 * authoritative IModel field; an explicit conflicting one is an error.
 */
function querystringPropertyOverrides(
  context: OperationBuildContext,
  route: ControllerRoute,
  parameter: ControllerParameter,
  schema: OpenApiSchema,
): OpenApiSchema {
  const target = record(schema);
  const properties = record(target?.properties);
  if (!target || !properties) return schema;
  const authoritative = parameter.type.modelContractName !== undefined;
  let result: Record<string, unknown> = target;
  for (const name of Object.keys(properties)) {
    const override = name === parameter.name ? undefined : route.parameterOverrides?.[parameterOverrideKey('query', name)];
    if (!override) continue;
    const propertySchema: Record<string, unknown> = { ...record(override.schema) };
    for (const key of ['description', 'deprecated', ...PARAMETER_SCHEMA_KEYS] as const) {
      if (override[key] !== undefined) propertySchema[key] = override[key];
    }
    const merged = mergeSchemaMetadata(result, { properties: { [name]: propertySchema } }, {
      authoritative,
      resolveReference: context.resolveSchemaReference,
      sourceFile: route.sourceFile,
      node: parameter.node,
      location: `querystring.${name}`,
    });
    result = record(merged) ?? result;
    if (typeof override.required !== 'boolean' || (override.requiredDefaulted === true && authoritative)) continue;
    const required = new Set(Array.isArray(result.required) ? result.required.map(String) : []);
    if (authoritative && required.has(name) !== override.required) {
      throw new TsToOpenApiError(diagnostic(
        route.sourceFile,
        parameter.node,
        TsToOpenApiDiagnosticCode.ConflictingSchemaMetadata,
        `Swagger query field ${name} required:${String(override.required)} conflicts with the IModel querystring contract.`,
      ));
    }
    if (override.required) required.add(name);
    else required.delete(name);
    const { required: _previous, ...rest } = result;
    result = required.size > 0 ? { ...rest, required: [...required].sort() } : rest;
  }
  return result;
}

async function openApiParameter(
  context: OperationBuildContext,
  route: ControllerRoute,
  parameter: ControllerParameter,
): Promise<Record<string, unknown>> {
  const location = parameter.location;
  const override = parameterOverride(route, parameter);
  const overrideSchema = record(override?.schema) as OpenApiSchema | undefined;
  const hasAuthoritativeRequiredContract = parameter.required && parameter.type.modelContractName !== undefined;
  if (override?.required === false && (location === 'path' || hasAuthoritativeRequiredContract)) {
    throw new TsToOpenApiError(diagnostic(
      route.sourceFile,
      parameter.node,
      TsToOpenApiDiagnosticCode.ConflictingSchemaMetadata,
      `Swagger parameter ${parameter.name} required:false conflicts with the required IModel parameter contract. Path parameters are always required.`,
    ));
  }
  if (location === 'querystring') {
    if ((context.openapiVersion ?? '3.2.0') !== '3.2.0') {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, parameter.node, TsToOpenApiDiagnosticCode.NonPortableParameter, 'The OpenAPI querystring parameter is available only in OpenAPI 3.2.0. Use named scalar query parameters for OpenAPI 3.1.2.'));
    }
    const schema = querystringPropertyOverrides(
      context,
      route,
      parameter,
      await schemaFor(context, parameter.type, 'parameter', 'querystring', overrideSchema),
    );
    return {
      name: parameter.name ?? 'query',
      in: 'querystring',
      required: parameter.required,
      content: {
        'application/x-www-form-urlencoded': { schema },
      },
    };
  }
  if (location !== 'path' && location !== 'query' && location !== 'header' && location !== 'cookie') {
    throw new TsToOpenApiError(diagnostic(route.sourceFile, parameter.node, TsToOpenApiDiagnosticCode.UnsupportedParameterLocation, 'Only path, query, header, and cookie parameters can be emitted as OpenAPI parameters.'));
  }
  if (!parameter.name) {
    throw new TsToOpenApiError(diagnostic(route.sourceFile, parameter.node, TsToOpenApiDiagnosticCode.MissingParameterName, `An OpenAPI ${location} parameter requires a name.`));
  }
  const overrideType = override?.type;
  const overrideReference = overrideType && typeof overrideType === 'object' && 'type' in (overrideType as object)
    ? overrideType as TypeReference
    : parameter.type;
  const overrideRecord = record(overrideSchema);
  const schemaOverride: Record<string, unknown> = { ...(overrideRecord ?? {}) };
  for (const key of PARAMETER_SCHEMA_KEYS) {
    if (override?.[key] !== undefined) schemaOverride[key] = override[key];
  }
  let schema: OpenApiSchema;
  if (overrideType && overrideReference !== parameter.type) {
    const declaredSchema = await schemaFor(context, parameter.type, 'parameter', `${location}.${parameter.name}.declared`);
    let overrideTypeSchema = await schemaFor(context, overrideReference, 'parameter', `${location}.${parameter.name}.override`);
    if (override?.isArray === true) overrideTypeSchema = arraySchema(overrideTypeSchema);
    // The method parameter remains the runtime authority. A Swagger `type`
    // annotation may document it, but cannot replace its wire shape.
    mergeSchemaMetadata(declaredSchema, overrideTypeSchema, {
      authoritative: parameter.type.modelContractName !== undefined,
      resolveReference: context.resolveSchemaReference,
      sourceFile: route.sourceFile,
      node: parameter.node,
      location: `${location}.${parameter.name}`,
      hint: contractHint('parameter'),
    });
  }
  schema = await schemaFor(
    context,
    parameter.type,
    'parameter',
    `${location}.${parameter.name}`,
    Object.keys(schemaOverride).length > 0 ? schemaOverride : undefined,
  );
  const schemaValue = record(schema);
  const schemaRecord = schemaValue ? { ...schemaValue } : undefined;
  if (schemaRecord) schema = schemaRecord;
  const style = typeof override?.style === 'string'
    ? override.style
    // A model is an object: a query object is `name[field]=value`, which is what the interceptor reads.
    : location === 'query' && parameter.type.modelContractName !== undefined ? 'deepObject'
    : location === 'query' || location === 'cookie' ? 'form' : 'simple';
  const explode = typeof override?.explode === 'boolean'
    ? override.explode
    : location === 'query' || location === 'cookie';
  return {
    name: parameter.name,
    in: location,
    required: location === 'path'
      ? true
      : override?.required !== undefined ? override.required === true : parameter.required,
    schema,
    style,
    explode,
    ...(typeof override?.description === 'string' ? { description: override.description } : {}),
    ...(override?.deprecated === true ? { deprecated: true } : {}),
  };
}

function explicitContent(value: unknown): Record<string, unknown> | undefined {
  return record(value);
}

async function bodyFieldsSchema(
  context: OperationBuildContext,
  fields: readonly ControllerParameter[],
): Promise<OpenApiSchema> {
  const properties = Object.fromEntries(await Promise.all(fields.map(async (field) => [
    field.name!,
    await schemaFor(context, field.type, 'request', `body.${field.name}`),
  ] as const)));
  const required = fields.filter(field => field.required).map(field => field.name!);
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

async function requestBody(
  context: OperationBuildContext,
  route: ControllerRoute,
): Promise<Record<string, unknown> | undefined> {
  const fields = route.parameters.filter(parameter => parameter.location === 'body');
  if (!route.body && !route.requestBody && fields.length === 0) return undefined;
  const override = route.requestBody;
  const declaredType = override?.declaredType ?? route.body?.type;
  const bodyType = declaredType ?? override?.type;
  // The body of one-field parameters: an object that holds each field under its name.
  const fieldsSchema = bodyType || fields.length === 0 ? undefined : await bodyFieldsSchema(context, fields);
  if (declaredType && override?.type && override.type !== declaredType) {
    const declaredSchema = await schemaFor(context, declaredType, 'request', 'body.declared');
    let overrideSchema = await schemaFor(context, override.type, 'request', 'body.override');
    if (override.isArray === true) overrideSchema = arraySchema(overrideSchema);
    mergeSchemaMetadata(declaredSchema, overrideSchema, {
      authoritative: declaredType.modelContractName !== undefined,
      resolveReference: context.resolveSchemaReference,
      sourceFile: route.sourceFile,
      node: route.body?.node ?? route.method,
      location: 'body',
      hint: contractHint('request'),
    });
  }
  const mediaTypes = override?.content
    ? explicitContent(override.content)
    : Object.fromEntries((route.consumes?.length ? route.consumes : ['application/json']).map(media => [media, {}]));
  const content = override?.content
    ? override.content
    : (() => {
      if (!bodyType) return mediaTypes;
      return Object.fromEntries(Object.keys(mediaTypes ?? { 'application/json': {} }).map(media => [media, {
        schema: undefined,
      }]));
    })();
  const generatedContent: Record<string, unknown> = {};
  if (content) {
    for (const [media, mediaValue] of Object.entries(content)) {
      const mediaRecord = record(mediaValue) ?? {};
      if (mediaRecord.schema !== undefined) {
        if (!bodyType) {
          generatedContent[media] = mediaRecord;
          continue;
        }
        const schema = explicitCompositionSchema(declaredType ?? bodyType, mediaRecord.schema)
          ?? await schemaFor(context, declaredType ?? bodyType, 'request', `body.${media}`, mediaRecord.schema as OpenApiSchema);
        generatedContent[media] = { ...mediaRecord, schema: override?.isArray ? arraySchema(schema) : schema };
        continue;
      }
      if (!bodyType) {
        generatedContent[media] = fieldsSchema ? { ...mediaRecord, schema: fieldsSchema } : mediaRecord;
        continue;
      }
      const schema = await schemaFor(context, declaredType ?? bodyType, 'request', `body.${media}`);
      generatedContent[media] = {
        ...mediaRecord,
        schema: override?.isArray ? arraySchema(schema) : schema,
      };
    }
  }
  const requiredBody = override?.required ?? route.body?.required ?? (fields.length > 0 ? fields.some(field => field.required) : undefined);
  return {
    ...(override?.description ? { description: override.description } : {}),
    ...(requiredBody === undefined ? {} : { required: requiredBody }),
    content: generatedContent,
  };
}

async function responseObject(
  context: OperationBuildContext,
  route: ControllerRoute,
  response: ResponseDescription,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { description: response.description ?? '' };
  if (response.headers) result.headers = response.headers;
  const specialResponseType = response.type ?? response.declaredType;
  const specialResponse = specialResponseType
    ? requiresExplicitResponseMetadata(context.checker, specialResponseType.type)
    : false;
  if (!specialResponse && response.declaredType && response.type && response.declaredType !== response.type) {
    const declaredSchema = await schemaFor(context, response.declaredType, 'response', `response.${response.status}.declared`);
    let overrideSchema = await schemaFor(context, response.type, 'response', `response.${response.status}.override`);
    if (response.isArray === true) overrideSchema = arraySchema(overrideSchema);
    mergeSchemaMetadata(declaredSchema, overrideSchema, {
      authoritative: response.declaredType.modelContractName !== undefined,
      resolveReference: context.resolveSchemaReference,
      sourceFile: route.sourceFile,
      node: response.type.sourceNode ?? response.type.node ?? response.type.declaration ?? route.method,
      location: `response.${response.status}`,
      hint: contractHint('response'),
    });
  }
  if (response.content) {
    const contractType = specialResponse ? undefined : response.declaredType ?? response.type;
    if (contractType) {
      const content: Record<string, unknown> = {};
      for (const [media, mediaValue] of Object.entries(response.content)) {
        const mediaRecord = record(mediaValue) ?? {};
        if (mediaRecord.schema === undefined) {
          const schema = await schemaFor(
            context,
            contractType,
            'response',
            `response.${response.status}.${media}`,
          );
          content[media] = {
            ...mediaRecord,
            schema: response.isArray && !response.declaredType ? arraySchema(schema) : schema,
          };
          continue;
        }
        const schema = explicitCompositionSchema(contractType, mediaRecord.schema)
          ?? await schemaFor(context, contractType, 'response', `response.${response.status}.${media}`, mediaRecord.schema as OpenApiSchema);
        content[media] = { ...mediaRecord, schema: response.isArray && !response.declaredType ? arraySchema(schema) : schema };
      }
      result.content = content;
    } else result.content = response.content;
    return result;
  }
  if (!response.type || response.status === '204' || response.status === '304') return result;
  if (requiresExplicitResponseMetadata(context.checker, response.type.type)) {
    throw new TsToOpenApiError(diagnostic(
      route.sourceFile,
      response.type.sourceNode ?? response.type.node ?? response.type.declaration,
      TsToOpenApiDiagnosticCode.PrimitiveResponseMetadata,
      `File, stream, and Observable responses require explicit Swagger content and schema metadata.`,
    ));
  }
  if (primitiveResponseType(context.checker, response.type.type)) {
    if (!response.explicit) {
      throw new TsToOpenApiError(diagnostic(
        route.sourceFile,
        response.type.sourceNode ?? response.type.node ?? response.type.declaration,
        TsToOpenApiDiagnosticCode.PrimitiveResponseMetadata,
        `Primitive response ${context.checker.typeToString(response.type.type)} requires explicit Swagger content and schema metadata.`,
      ));
    }
    const schema = primitiveResponseSchema(context.checker, response.type.type);
    if (!schema) {
      throw new TsToOpenApiError(diagnostic(
        route.sourceFile,
        response.type.sourceNode ?? response.type.node ?? response.type.declaration,
        TsToOpenApiDiagnosticCode.PrimitiveResponseMetadata,
        `Primitive response ${context.checker.typeToString(response.type.type)} requires an explicit supported Swagger schema.`,
      ));
    }
    const mediaTypes = response.mediaTypes ?? (route.produces?.length ? route.produces : ['application/json']);
    result.content = Object.fromEntries(mediaTypes.map(media => [media, { schema: response.isArray ? arraySchema(schema) : schema }]));
    return result;
  }
  const schema = await schemaFor(context, response.declaredType ?? response.type, 'response', `response.${response.status}`);
  // A declared return type already describes the complete array shape.
  const responseSchema = response.isArray && !response.declaredType ? arraySchema(schema) : schema;
  const mediaTypes = response.mediaTypes ?? (route.produces?.length ? route.produces : ['application/json']);
  result.content = Object.fromEntries(mediaTypes.map(media => [media, { schema: responseSchema }]));
  return result;
}

async function operationObject(
  context: OperationBuildContext,
  route: ControllerRoute,
): Promise<Record<string, unknown>> {
  // A one-field body parameter is a property of the request body, not an OpenAPI parameter.
  const parameters = await Promise.all(route.parameters.filter(parameter => parameter.location !== 'body')
    .map(parameter => openApiParameter(context, route, parameter)));
  const placeholders = pathParameterNames(route.path);
  for (const placeholder of placeholders) {
    if (!parameters.some(parameter => parameter.in === 'path' && parameter.name === placeholder)) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, route.method, TsToOpenApiDiagnosticCode.MissingPathParameter, `Path parameter {${placeholder}} has no matching @Param("${placeholder}") declaration.`));
    }
  }
  for (const parameter of route.parameters.filter(item => item.location === 'path')) {
    if (!placeholders.includes(String(parameter.name))) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, parameter.node, TsToOpenApiDiagnosticCode.ExtraPathParameter, `@Param("${parameter.name}") is not present in route path ${route.path}.`));
    }
  }
  const responseEntries: [string, Record<string, unknown>][] = [];
  const responseStatuses = new Set<string>();
  for (const response of route.responses) {
    if (response.status !== 'default' && !/^[1-5]XX$/.test(response.status) && !/^[1-5][0-9]{2}$/.test(response.status)) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, route.method, TsToOpenApiDiagnosticCode.InvalidResponseStatus, `Invalid OpenAPI response status ${response.status} for ${route.operationId}.`));
    }
    if (responseStatuses.has(response.status)) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, route.method, TsToOpenApiDiagnosticCode.DuplicateResponseStatus, `Response status ${response.status} is declared more than once for ${route.operationId}.`));
    }
    responseStatuses.add(response.status);
    responseEntries.push([response.status, await responseObject(context, route, response)]);
  }
  const responses = Object.fromEntries(responseEntries);
  const body = await requestBody(context, route);
  const result: Record<string, unknown> = {
    operationId: route.operationId,
    ...(route.tags.length > 0 ? { tags: route.tags } : {}),
    ...(route.summary ? { summary: route.summary } : {}),
    ...(route.description ? { description: route.description } : {}),
    ...(route.deprecated ? { deprecated: true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(route.security ? { security: route.security } : {}),
  };
  return result;
}

export async function collectOperations(
  routes: readonly ControllerRoute[],
  context: OperationBuildContext,
): Promise<OperationBuildResult> {
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Map<string, ControllerRoute>();
  for (const route of routes) {
    if (!HTTP_METHODS.has(route.httpMethod)) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, route.method, TsToOpenApiDiagnosticCode.UnsupportedHttpMethod, `Unsupported HTTP method ${route.httpMethod}.`));
    }
    const previous = operationIds.get(route.operationId);
    if (previous) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, route.method, TsToOpenApiDiagnosticCode.DuplicateOperationId, `OperationId "${route.operationId}" is emitted by both ${previous.controller}.${previous.methodName} and ${route.controller}.${route.methodName}. Set distinct @ApiOperation({ operationId }) values or change the route expansion.`));
    }
    operationIds.set(route.operationId, route);
    const pathItem = paths[route.path] ?? {};
    if (pathItem[route.httpMethod]) {
      throw new TsToOpenApiError(diagnostic(route.sourceFile, route.method, TsToOpenApiDiagnosticCode.DuplicateRoute, `Route ${route.httpMethod.toUpperCase()} ${route.path} is declared more than once.`));
    }
    pathItem[route.httpMethod] = await operationObject(context, route);
    paths[route.path] = pathItem;
  }
  return {
    paths: Object.fromEntries(Object.entries(paths).sort(([left], [right]) => compareText(left, right))),
  };
}
