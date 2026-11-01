import path from 'node:path';
import { bundleReferenceGraph } from './bundler.js';
import { expandOas32MediaTypes, parseSourceDocument, validate, validateSourceDocument } from './document.js';
import { displayLocation, type OriginLocator } from './origin.js';
import { formatOpenApiProblems, validateOpenApiDocument } from './openapi-validator.js';
import { loadReferenceGraph, type ReferenceResolutionOptions } from './reference-loader.js';

export { readLimitedBody, type ReferenceResolutionOptions } from './reference-loader.js';

interface LoadedOpenApiInput {
  readonly document: unknown;
  /** Local files the document depends on; generation watches them. */
  readonly localInputs: readonly string[];
  /** Names where a pointer into `document` came from, for generator-stage errors. */
  readonly locate: OriginLocator;
}

/**
 * Parse, load, bundle and validate one OpenAPI input. The reference loader is
 * the only place that classifies and gates remote references.
 */
export async function loadOpenApiInput(
  filename: string,
  options: ReferenceResolutionOptions = {},
): Promise<LoadedOpenApiInput> {
  const rootFile = path.resolve(filename);
  // Observe the root before parsing so watch mode sees a root that fails to parse.
  options.onInput?.(rootFile);
  const parsed = parseSourceDocument(rootFile);
  validateSourceDocument(parsed);
  const graph = await loadReferenceGraph(rootFile, parsed, options);
  const bundled = bundleReferenceGraph(graph);
  const locate: OriginLocator = (pointer) => {
    const origin = bundled.originOf(pointer);
    return displayLocation(origin.uri, origin.pointer, graph.rootDirectory);
  };
  const problems = validateOpenApiDocument(bundled.document);
  if (problems.length) throw new Error(formatOpenApiProblems(problems, locate));
  const document = expandOas32MediaTypes(bundled.document);
  validate(document, undefined, locate);
  return { document, localInputs: graph.localFiles, locate };
}

export async function loadValidatedDocument(
  filename: string,
  options: ReferenceResolutionOptions = {},
): Promise<unknown> {
  return (await loadOpenApiInput(filename, options)).document;
}

/** Every local document that can affect generation; remote references are not fetched. */
export async function collectLocalReferenceInputs(
  filename: string,
  document: unknown,
  options: ReferenceResolutionOptions = {},
): Promise<string[]> {
  const graph = await loadReferenceGraph(filename, document, { ...options, skipRemote: true });
  return [...graph.localFiles];
}
