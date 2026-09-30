import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import * as FormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { openApiLine, type OpenApiLine } from './json.js';
import { checkOpenApiRules } from './openapi-rules.js';
import { OAS_3_1_DOCUMENT_SCHEMA } from './openapi-schemas/oas-3-1.js';
import { OAS_3_2_DOCUMENT_SCHEMA } from './openapi-schemas/oas-3-2.js';
import { visitOpenApiSchemaTree } from './schema-projection.js';

export interface OpenApiProblem {
  readonly ruleId: string;
  readonly message: string;
  /** JSON Pointer into the validated document; '' is the root. */
  readonly pointer: string;
  /** A second location the problem involves, such as the first use of a duplicate; same pointer form. */
  readonly relatedPointer?: string;
}

export const MAX_REPORTED_PROBLEMS = 20;

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export interface OpenApiValidators {
  readonly documents: Readonly<Record<OpenApiLine, ValidateFunction>>;
  readonly schemaObject: ValidateFunction;
}

let compiled: OpenApiValidators | undefined;

function isFormatsPlugin(value: unknown): value is FormatsPlugin {
  return typeof value === 'function';
}

/** Compiled once per process: watch mode validates on every regeneration. */
export function openApiValidators(): OpenApiValidators {
  if (compiled) return compiled;
  const addFormats: unknown = FormatsModule.default;
  if (!isFormatsPlugin(addFormats)) throw new TypeError('ajv-formats export is unavailable');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('media-range', true);
  const schemaObject = ajv.getSchema(JSON_SCHEMA_2020_12);
  if (!schemaObject) throw new Error('the JSON Schema 2020-12 meta-schema is unavailable');
  compiled = {
    documents: { '3.1': ajv.compile(OAS_3_1_DOCUMENT_SCHEMA), '3.2': ajv.compile(OAS_3_2_DOCUMENT_SCHEMA) },
    schemaObject,
  };
  return compiled;
}

function ajvProblem(ruleId: string, error: ErrorObject, basePointer: string): OpenApiProblem {
  const params: Readonly<Record<string, unknown>> = error.params;
  const property = typeof params.unevaluatedProperty === 'string'
    ? params.unevaluatedProperty
    : typeof params.additionalProperty === 'string' ? params.additionalProperty : undefined;
  const message = property === undefined
    ? error.message ?? error.keyword
    : `property ${JSON.stringify(property)} is not allowed`;
  return { ruleId, message, pointer: `${basePointer}${error.instancePath}` };
}

export function uniqueProblems(problems: readonly OpenApiProblem[]): OpenApiProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.ruleId}\u0000${problem.pointer}\u0000${problem.message}\u0000${problem.relatedPointer ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Ajv reports wrapper errors (`anyOf`, a parent's `unevaluatedProperties`
 * after a failed branch) beside the specific one. Keep the first error at
 * each pointer, and drop an error when a deeper error explains it.
 */
export function mostSpecificProblems(problems: readonly OpenApiProblem[]): OpenApiProblem[] {
  const firstAtPointer = new Map<string, OpenApiProblem>();
  for (const problem of problems) {
    if (!firstAtPointer.has(problem.pointer)) firstAtPointer.set(problem.pointer, problem);
  }
  const pointers = [...firstAtPointer.keys()];
  return [...firstAtPointer.values()]
    .filter((problem) => !pointers.some((other) => other.startsWith(`${problem.pointer}/`)));
}

/** Document shape against the official OAS schema; `if` errors only wrap the specific error. */
export function checkOpenApiStructure(document: unknown): OpenApiProblem[] {
  const validate = openApiValidators().documents[openApiLine(document)];
  if (validate(document)) return [];
  return mostSpecificProblems((validate.errors ?? [])
    .filter((error) => error.keyword !== 'if')
    .map((error) => ajvProblem('struct', error, '')));
}

/** Each outermost Schema Object against the JSON Schema 2020-12 meta-schema. */
export function checkSchemaObjects(document: unknown): OpenApiProblem[] {
  const { schemaObject } = openApiValidators();
  const checkedRoots = new Set<string>();
  const problems: OpenApiProblem[] = [];
  const insideCheckedRoot = (pointer: string): boolean => {
    for (let end = pointer.lastIndexOf('/'); end > 0; end = pointer.lastIndexOf('/', end - 1)) {
      if (checkedRoots.has(pointer.slice(0, end))) return true;
    }
    return false;
  };
  visitOpenApiSchemaTree(document, {
    onSchema(schema, _currentBase, walkerPointer) {
      const pointer = walkerPointer.slice(1);
      if (insideCheckedRoot(pointer)) return;
      checkedRoots.add(pointer);
      if (schemaObject(schema)) return;
      for (const error of schemaObject.errors ?? []) problems.push(ajvProblem('schema', error, pointer));
    },
  });
  return mostSpecificProblems(problems);
}

/**
 * Runs the structure, Schema Object and hand-written rule checks and returns
 * the found problems. The one exception: a JSON Schema `$id` declared twice
 * is not caught by the official OpenAPI schema, so the rule checks'
 * `collectCanonicalResources` throws `duplicate JSON Schema $id "…"` instead
 * of returning a problem.
 */
export function validateOpenApiDocument(document: unknown): OpenApiProblem[] {
  const structure = checkOpenApiStructure(document);
  if (structure.length) return structure;
  return uniqueProblems([...checkSchemaObjects(document), ...checkOpenApiRules(document)]);
}

/**
 * One `<rule>: <message> (<location>)` line per problem; a related location
 * is part of the message: `<message> (also at <location>)`. `locate` maps
 * every pointer to its displayed location.
 */
export function formatOpenApiProblems(
  problems: readonly OpenApiProblem[],
  locate: (pointer: string) => string,
): string {
  const lines = problems.slice(0, MAX_REPORTED_PROBLEMS).map((problem) => {
    const related = problem.relatedPointer === undefined ? '' : ` (also at ${locate(problem.relatedPointer)})`;
    return `${problem.ruleId}: ${problem.message}${related} (${locate(problem.pointer)})`;
  });
  return `OpenAPI validation failed with ${problems.length} error(s):\n${lines.join('\n')}`;
}
