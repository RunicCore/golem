import { escapePointerToken } from '@exprtlabs/golem/internal/schema';
import { schemaIssueMessage } from '@exprtlabs/golem/internal/generator-support';
import type { SchemaIssue, Validator } from '@exprtlabs/golem/validation';
import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import { compile } from '@exprtlabs/golem/internal/validator-compiler';
import { openApiLine, type OpenApiLine } from './json.js';
import { checkNonFiniteNumbers, checkOpenApiRules } from './openapi-rules.js';
import { JSON_SCHEMA_2020_12_ID, JSON_SCHEMA_2020_12_META_SCHEMAS } from './openapi-schemas/json-schema-2020-12.js';
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

const MAX_REPORTED_PROBLEMS = 20;

interface OpenApiValidators {
  readonly documents: Readonly<Record<OpenApiLine, Validator>>;
  readonly schemaObject: Validator;
}

/**
 * Compiles the OAS and JSON Schema 2020-12 meta-schemas with golem's own validator compiler and loads the module
 * from a `data:` URL; it imports the validation runtime by its absolute URL. A diagnostic, including a format
 * the runtime does not check, is a defect of the vendored schemas and stops the process.
 */
async function compileOpenApiValidators(): Promise<OpenApiValidators> {
  const roots = new Map<string, unknown>([
    ['3.1', OAS_3_1_DOCUMENT_SCHEMA],
    ['3.2', OAS_3_2_DOCUMENT_SCHEMA],
    ['schemaObject', JSON_SCHEMA_2020_12_META_SCHEMAS[JSON_SCHEMA_2020_12_ID]],
  ]);
  const resources = new Map(Object.entries(JSON_SCHEMA_2020_12_META_SCHEMAS).filter(([id]) => id !== JSON_SCHEMA_2020_12_ID));
  const { source, exports, diagnostics } = compile(
    { roots, resources },
    { unknownFormats: 'error', specifiers: { values: { 'validation-runtime': import.meta.resolve('@exprtlabs/golem/internal/validation-runtime') } }, documentName: 'the OpenAPI meta-schemas' },
  );
  const errors = diagnostics.filter((entry) => entry.severity === GolemDiagnosticSeverity.Error);
  if (errors.length) throw new Error(`the OpenAPI meta-schemas do not compile: ${errors.map((entry) => entry.message).join('; ')}`);
  const loaded = await import(`data:text/javascript,${encodeURIComponent(source)}`) as Readonly<Record<string, Validator>>;
  const validator = (root: string): Validator => {
    const exported = exports.get(root);
    const found = exported === undefined ? undefined : loaded[exported];
    if (found === undefined) throw new Error(`the OpenAPI meta-schemas module has no validator for ${JSON.stringify(root)}`);
    return found;
  };
  return {
    documents: { '3.1': validator('3.1'), '3.2': validator('3.2') },
    schemaObject: validator('schemaObject'),
  };
}

// Compiled when the module loads, once per process: watch mode validates on every regeneration, and the check
// functions below stay synchronous.
const validators = await compileOpenApiValidators();

/**
 * The pointer of the object that holds the problem: a missing or unknown key is reported at its object, as the
 * issue path ends at the key.
 */
function issueProblem(ruleId: string, issue: SchemaIssue, basePointer: string): OpenApiProblem {
  const keyed = issue.code === 'required' || issue.code === 'unknownKey';
  const path = keyed ? issue.path.slice(0, -1) : issue.path;
  const message = issue.code === 'unknownKey'
    ? `property ${JSON.stringify(issue.key)} is not allowed`
    : schemaIssueMessage(issue);
  return { ruleId, message, pointer: `${basePointer}${path.map((token) => `/${escapePointerToken(String(token))}`).join('')}` };
}

function uniqueProblems(problems: readonly OpenApiProblem[]): OpenApiProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.ruleId}\u0000${problem.pointer}\u0000${problem.message}\u0000${problem.relatedPointer ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The validators report wrapper issues (a `union` over its alternatives, a parent's `unknownKey`
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

/** Document shape against the official OAS schema. */
export function checkOpenApiStructure(document: unknown): OpenApiProblem[] {
  const issues = validators.documents[openApiLine(document)](document, true);
  return mostSpecificProblems(issues.map((issue) => issueProblem('struct', issue, '')));
}

/** Each outermost Schema Object against the JSON Schema 2020-12 meta-schema. */
export function checkSchemaObjects(document: unknown): OpenApiProblem[] {
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
      for (const issue of validators.schemaObject(schema, true)) problems.push(issueProblem('schema', issue, pointer));
    },
  });
  return mostSpecificProblems(problems);
}

/**
 * Runs the non-finite number, structure, Schema Object and hand-written rule checks and returns
 * the found problems.
 */
export function validateOpenApiDocument(document: unknown): OpenApiProblem[] {
  // A number that JSON cannot write has no meaning for the later checks; they report it as a type error or not at all.
  const nonFinite = checkNonFiniteNumbers(document);
  if (nonFinite.length) return nonFinite;
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
