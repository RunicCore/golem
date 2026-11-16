import assert from 'node:assert/strict';
import type { generate } from '#ts-openapi/generator';

export type OpenApiSchemaValue = boolean | OpenApiSchema;

export interface OpenApiSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly format?: string;
  readonly description?: string;
  readonly example?: unknown;
  readonly default?: unknown;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, OpenApiSchemaValue>>;
  readonly items?: OpenApiSchema;
  readonly allOf?: readonly OpenApiSchemaValue[];
  readonly anyOf?: readonly OpenApiSchemaValue[];
  readonly additionalProperties?: OpenApiSchemaValue;
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly [keyword: string]: unknown;
}

interface OpenApiMediaType {
  readonly schema?: OpenApiSchema;
}

export interface OpenApiParameter {
  readonly in?: string;
  readonly name?: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly style?: string;
  readonly explode?: boolean;
  readonly schema?: OpenApiSchemaValue;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiResponse {
  readonly description?: string;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiRequestBody {
  readonly required?: boolean;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiOperation {
  readonly summary?: string;
  readonly operationId?: string;
  readonly tags?: readonly string[];
  readonly security?: readonly Readonly<Record<string, unknown>>[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

export interface OpenApiPathItem {
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly put?: OpenApiOperation;
  readonly patch?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
  readonly options?: OpenApiOperation;
  readonly head?: OpenApiOperation;
}

export interface OpenApiDocument {
  readonly openapi?: string;
  readonly servers?: readonly Readonly<Record<string, unknown>>[];
  readonly components?: {
    readonly schemas?: Readonly<Record<string, OpenApiSchemaValue>>;
  };
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
}

export interface DiagnosticLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

export function expectValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}.`);
  return value;
}

export function expectSchema(value: OpenApiSchemaValue | undefined, label: string): OpenApiSchema {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object schema for ${label}.`);
  }
  return value;
}

export function schemaOf(document: OpenApiDocument, name: string): OpenApiSchema {
  const components = expectValue(document.components, 'OpenAPI components');
  const schemas = expectValue(components.schemas, 'OpenAPI component schemas');
  return expectSchema(schemas[name], `component schema ${name}`);
}

export function propertySchema(schema: OpenApiSchema, name: string): OpenApiSchema {
  const properties = expectValue(schema.properties, `${name} properties`);
  return expectSchema(properties[name], `property ${name}`);
}

export function operationOf(
  document: OpenApiDocument,
  route: string,
  method: keyof OpenApiPathItem,
): OpenApiOperation {
  return expectValue(expectValue(document.paths[route], `OpenAPI path ${route}`)[method], `${String(method).toUpperCase()} ${route}`);
}

export function requestBodyOf(
  document: OpenApiDocument,
  route: string,
  method: keyof OpenApiPathItem,
): OpenApiRequestBody {
  return expectValue(operationOf(document, route, method).requestBody, `request body of ${String(method).toUpperCase()} ${route}`);
}

export function responseOf(
  document: OpenApiDocument,
  route: string,
  method: keyof OpenApiPathItem,
  status: string,
): OpenApiResponse {
  return expectValue(operationOf(document, route, method).responses[status], `response ${status} for ${String(method).toUpperCase()} ${route}`);
}

export function parameterOf(
  document: OpenApiDocument,
  route: string,
  method: keyof OpenApiPathItem,
  index = 0,
): OpenApiParameter {
  return expectValue(expectValue(operationOf(document, route, method).parameters, `parameters for ${String(method).toUpperCase()} ${route}`)[index], `parameter ${index} for ${String(method).toUpperCase()} ${route}`);
}

export function contentSchema(
  value: OpenApiResponse | OpenApiParameter | OpenApiRequestBody,
  mediaType: string,
  label: string,
): OpenApiSchema {
  const content = expectValue(value.content, `${label}.content`);
  return expectSchema(expectValue(content[mediaType], `${label}.content.${mediaType}`).schema, `${label}.content.${mediaType}.schema`);
}

export function responseSchema(
  document: OpenApiDocument,
  route: string,
  method: keyof OpenApiPathItem,
  status: string,
  mediaType = 'application/json',
): OpenApiSchema {
  return contentSchema(responseOf(document, route, method, status), mediaType, `response ${status} for ${String(method).toUpperCase()} ${route}`);
}

/** The text of the first generated artifact. */
export function firstArtifact(result: Awaited<ReturnType<typeof generate>>): string {
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  return artifact.content;
}

/** The first generated artifact as an OpenAPI document. A test with its own document type names it as `Document`. */
export function documentOf<Document extends { readonly paths: object } = OpenApiDocument>(result: Awaited<ReturnType<typeof generate>>): Document {
  return documentFrom<Document>(JSON.parse(firstArtifact(result)));
}

/** A parsed OpenAPI document (JSON or YAML), checked to be an object with object paths. */
export function documentFrom<Document extends { readonly paths: object } = OpenApiDocument>(parsed: unknown): Document {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Generated OpenAPI document is not an object.');
  }
  const { paths } = parsed as { readonly paths?: unknown };
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new Error('Generated OpenAPI document has no object paths.');
  }
  return parsed as Document;
}

/** The diagnostics of a generator error, or of the error that a pipeline run wraps (its `cause`). */
export function diagnosticsOf(error: unknown): readonly DiagnosticLike[] {
  if (error === null || typeof error !== 'object') return [];
  if (!('diagnostics' in error)) return 'cause' in error ? diagnosticsOf(error.cause) : [];
  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter((item): item is DiagnosticLike => (
    item !== null && typeof item === 'object'
  ));
}

/** The check of `assert.rejects`: the error holds a diagnostic of this code, whose message matches when one is given. */
export function refusedWith(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error) => diagnosticsOf(error).some(item => item.code === code && (message === undefined || message.test(String(item.message))));
}
