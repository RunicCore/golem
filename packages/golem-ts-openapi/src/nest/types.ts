import type * as ts from '@exprtlabs/golem/internal/ts';
import type { TsToOpenApiDiagnostic } from '../diagnostics.js';
import type { ContractAnalysis } from '@exprtlabs/golem/internal/type-analysis';

export const NEST_HTTP_METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
] as const;

export type NestHttpMethod = typeof NEST_HTTP_METHODS[number];
type ParameterLocation = 'path' | 'query' | 'header' | 'cookie' | 'querystring';

export interface TypeReference {
  readonly type: ts.Type;
  readonly node?: ts.TypeNode;
  readonly sourceNode?: ts.Node;
  readonly declaration?: ts.Declaration;
  /** Name of the shared IModel contract when this reference is authoritative. */
  readonly modelContractName?: string;
  readonly sourceFile: ts.SourceFile;
}

export interface DecoratorInfo {
  readonly decorator: ts.Decorator;
  readonly expression: ts.Expression;
  readonly call?: ts.CallExpression;
  readonly name?: string;
  readonly packageName?: string;
}

export interface ControllerParameter {
  readonly node: ts.Node;
  readonly type: TypeReference;
  readonly location?: ParameterLocation | 'body';
  readonly name?: string;
  readonly required: boolean;
  /** The model id of the whole `@Query()` model that OpenAPI 3.1 flattened into this parameter. */
  readonly wholeQueryModel?: string;
  /** The model id of the items of a whole `@Body()` that is an array of models (`TPayment[]`, `readonly TPayment[]`, `ReadonlyArray<TPayment>`). */
  readonly bodyItemModel?: string;
  /** The model ids of the variants of a whole `@Body()` or `@Query()` that is a union of models. */
  readonly unionModels?: readonly string[];
}

export interface RequestBodyDescription {
  readonly description?: string;
  readonly required?: boolean;
  readonly type?: TypeReference;
  /** The controller parameter type before an explicit Swagger `type` override. */
  readonly declaredType?: TypeReference;
  readonly isArray?: boolean;
  readonly content?: Record<string, unknown>;
}

export interface ResponseDescription {
  readonly status: string;
  readonly description: string;
  readonly type?: TypeReference;
  /** The method return type before an explicit Swagger `type` override. */
  readonly declaredType?: TypeReference;
  readonly isArray?: boolean;
  readonly content?: Record<string, unknown>;
  readonly headers?: Record<string, unknown>;
  /** Media types of the response body when fixed by `@Header('Content-Type', …)`. */
  readonly mediaTypes?: readonly string[];
  readonly explicit: boolean;
}

export interface ControllerRoute {
  readonly controller: string;
  readonly methodName: string;
  readonly method: ts.MethodDeclaration;
  readonly sourceFile: ts.SourceFile;
  readonly httpMethod: NestHttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly parameters: readonly ControllerParameter[];
  readonly body?: ControllerParameter;
  readonly responses: readonly ResponseDescription[];
  readonly requestBody?: RequestBodyDescription;
  readonly parameterOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly consumes?: readonly string[];
  readonly produces?: readonly string[];
  readonly security?: readonly Record<string, string[]>[];
  readonly deprecated?: boolean;
}

export interface NestAnalysisContext {
  readonly root: string;
  readonly sources: readonly string[];
  /** File-name endings of controller sources; a controller class without a name is named by its file without one. */
  readonly suffixes?: readonly string[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly openapiVersion?: '3.2.0' | '3.1.2';
  /** The most bytes of JSON that a route path or version can fold to; omitted means 1 MiB. */
  readonly maxResultBytes?: number;
  readonly onInput?: (filename: string) => void;
  /** Shared source contract analysis used for generated model subclasses and projections. */
  readonly contractAnalysis?: ContractAnalysis;
  /** Emit a `components.schemas` entry for a class named by `getSchemaPath()`/`refs()`. */
  readonly registerSchemaComponent?: (name: string, reference: TypeReference) => void;
  /** Receives non-fatal metadata findings. */
  readonly onWarning?: (warning: TsToOpenApiDiagnostic) => void;
}

export interface ControllerAnalysisResult {
  readonly routes: readonly ControllerRoute[];
}
