import { objectEntries } from './json.js';
import { GolemDiagnosticSeverity, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { parameterSchema, resolveLocal, type NormalizedOperation } from './normalize.js';
import { type OpenApiModelAnalysis, modelEnv, type CompositionSite, checkComposition } from './model-resolution.js';
import { checkModelFromJSON, checkModelToJSON } from './model-emission.js';

/** Whether the schema or a schema inside it has an allOf; a `$ref` target is a component and is read as one. */
function containsAllOf(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && 'allOf' in value) return true;
  return Object.values(value).some((child) => containsAllOf(child, seen));
}

/**
 * An inline schema of an operation (a parameter, a request body, a response or one of its headers) reads its allOf as
 * a component does: the same resolver stops generation with the same code, and warns about each name no value can hold.
 */
export function checkOperationCompositions(
  operations: readonly NormalizedOperation[],
  analysis: Pick<OpenApiModelAnalysis, 'definitions' | 'resources'>,
  document: unknown,
): GolemDiagnostic[] {
  const diagnostics: GolemDiagnostic[] = [];
  const warn = (code: string, message: string): void => {
    diagnostics.push({ code, severity: GolemDiagnosticSeverity.Warning, message });
  };
  const env = modelEnv(document, undefined, undefined, analysis.resources);
  const check = (schema: unknown, place: string, direction: 'from' | 'to'): void => {
    const site: CompositionSite = { where: (pointer) => `${place} at #${pointer}`, origins: () => [] };
    checkComposition(site, schema, undefined, analysis.definitions, document, analysis.resources, warn);
    // Members that are not objects convert in the model path; no component reads an inline schema there, so convert it once.
    if (!containsAllOf(schema)) return;
    const convert = direction === 'from' ? checkModelFromJSON : checkModelToJSON;
    convert(schema, 'value', analysis.definitions, env, site);
  };
  for (const operation of operations) {
    const owner = `of operation ${JSON.stringify(operation.name)}`;
    for (const parameter of operation.parameters) {
      check(parameterSchema(parameter), `schema of ${parameter.in} parameter ${JSON.stringify(parameter.name)} ${owner}`, 'to');
    }
    for (const media of operation.requestContent) {
      check(media.schema, `schema of request body ${media.contentType} ${owner}`, 'to');
      check(media.itemSchema, `item schema of request body ${media.contentType} ${owner}`, 'to');
    }
    for (const response of operation.responses) {
      for (const media of response.content) {
        check(media.schema, `schema of ${response.status} response ${media.contentType} ${owner}`, 'from');
        check(media.itemSchema, `item schema of ${response.status} response ${media.contentType} ${owner}`, 'from');
      }
      for (const [name, header] of objectEntries(response.headers)) {
        check(parameterSchema(resolveLocal(document, header)), `schema of ${response.status} response header ${JSON.stringify(name)} ${owner}`, 'from');
      }
    }
  }
  return diagnostics;
}

export { collectOpenApiModelDefinitions } from './model-definitions.js';
export { analyzeOpenApiModels } from './model-schema-graph.js';
export { generateModels, generateOpenApiModelArtifacts } from './model-emission.js';
export { generateModelManifest } from './model-manifest.js';
export type { OpenApiDates } from './model-resolution.js';
