import path from 'node:path';
import {
  GolemDiagnosticSeverity,
  type GolemResult,
  type HookParticipants,
} from '@exprtlabs/golem/generator-api';
import { resolveOpenApiMode, type OpenApiContext, type OpenApiMode, type OpenApiModeSetting } from './plan.js';
import { normalizeSchemaUnions } from './document.js';
import { writeSdk as emitSdk } from './emit.js';
import { API_VERSION } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  loadOpenApiInput,
  loadValidatedDocument,
  type ReferenceResolutionOptions,
} from './resolver.js';

export type { OpenApiContext } from './plan.js';

export interface OpenApiGenerationContext extends OpenApiContext {
  /** The participants of the extensions that fill the hooks this job offers (`client.operationWrapper`), as core routes them. */
  readonly hooks?: HookParticipants;
}

export interface OpenApiGenerationResult extends GolemResult {
  readonly apiVersion: 1;
}

export const apiVersion = API_VERSION;

function validateGenerateContext(context: OpenApiGenerationContext): { readonly profile: OpenApiGenerationProfile; readonly mode: OpenApiMode } {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('generate context must be an object');
  }
  for (const key of ['input', 'output'] as const) {
    if (typeof context[key] !== 'string' || !path.isAbsolute(context[key])) {
      throw new TypeError(`context.${key} must be an absolute path`);
    }
  }
  if (context.name !== undefined && (typeof context.name !== 'string' || !context.name.trim())) {
    throw new TypeError('context.name must be a non-empty string when provided');
  }
  if (context.dates !== undefined && context.dates !== 'date' && context.dates !== 'temporal') {
    throw new TypeError('context.dates must be "date" or "temporal" when provided');
  }
  const mode = resolveOpenApiMode(context);
  return { profile: requireProfile(context.profile), mode };
}

/**
 * Load, validate, normalize, and emit an SDK without touching the filesystem
 * outside the input/reference reads required by validation.
 */
export async function generate(context: OpenApiGenerationContext): Promise<OpenApiGenerationResult> {
  const { profile, mode } = validateGenerateContext(context);
  const input = path.resolve(context.input);
  const output = path.resolve(context.output);
  const loaded = await loadOpenApiInput(input, context);
  const result = writeResolvedSdk(loaded.document, { output, name: context.name, profile, mode, locate: loaded.locate, ...(context.dates === undefined ? {} : { dates: context.dates }), ...(context.hooks === undefined ? {} : { hooks: context.hooks }) });
  const failed = result.diagnostics?.some((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error) ?? false;
  return {
    apiVersion: API_VERSION,
    artifacts: result.artifacts,
    // A run that reports an error writes no artifacts, so it names no manifest either.
    manifestPaths: failed ? [] : [path.resolve(output, 'model-manifest.json')],
    watchInputs: [...loaded.localInputs],
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

export type { ReferenceResolutionOptions };

// A schema that holds both `oneOf` and `anyOf` is rewritten into an allOf of the two, once, at the public entry that reads a
// document. Everything behind it sees one union keyword at a time.

function writeResolvedSdk(document: unknown, options: Parameters<typeof emitSdk>[1]): ReturnType<typeof emitSdk> {
  const split = normalizeSchemaUnions(document, options.locate);
  return emitSdk(split.document, split.locate ? { ...options, locate: split.locate } : options, split.moved);
}

/** The entry for a caller that holds a validated document and sets the mode as `mode` and `codecsFile`; the mode is resolved here, once. */
export function writeSdk(document: unknown, { mode, codecsFile, ...options }: Omit<Parameters<typeof emitSdk>[1], 'mode'> & OpenApiModeSetting): ReturnType<typeof emitSdk> {
  return writeResolvedSdk(document, { ...options, mode: resolveOpenApiMode({ mode, codecsFile }) });
}

export { loadValidatedDocument };
