import path from 'node:path';
import type {
  GolemResult,
  OpenApiContext,
} from '@exprtlabs/golem/generator-api';
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

export type { OpenApiContext } from '@exprtlabs/golem/generator-api';

export interface OpenApiGenerationContext extends OpenApiContext {}

export interface OpenApiGenerationResult extends GolemResult {
  readonly apiVersion: 1;
}

export const apiVersion = API_VERSION;

function validateGenerateContext(context: OpenApiGenerationContext): OpenApiGenerationProfile {
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
  if (context.mode !== undefined && context.mode !== 'standalone' && context.mode !== 'golem') {
    throw new TypeError('context.mode must be "standalone" or "golem" when provided');
  }
  if (context.mode === 'golem' && (typeof context.codecsFile !== 'string' || !path.isAbsolute(context.codecsFile))) {
    throw new TypeError('context.codecsFile must be an absolute path when mode is "golem"');
  }
  return requireProfile(context.profile);
}

/**
 * Load, validate, normalize, and emit an SDK without touching the filesystem
 * outside the input/reference reads required by validation.
 */
export async function generate(context: OpenApiGenerationContext): Promise<OpenApiGenerationResult> {
  const profile = validateGenerateContext(context);
  const input = path.resolve(context.input);
  const output = path.resolve(context.output);
  const loaded = await loadOpenApiInput(input, context);
  const result = writeSdk(loaded.document, { output, name: context.name, profile, locate: loaded.locate, ...(context.dates === undefined ? {} : { dates: context.dates }), ...(context.mode === undefined ? {} : { mode: context.mode }), ...(context.codecsFile === undefined ? {} : { codecsFile: context.codecsFile }) });
  return {
    apiVersion: API_VERSION,
    artifacts: result.artifacts,
    manifestPaths: [path.resolve(output, 'model-manifest.json')],
    watchInputs: [...loaded.localInputs],
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

export type { ReferenceResolutionOptions };

// A schema that holds both `oneOf` and `anyOf` is rewritten into an allOf of the two, once, at the public entry that reads a
// document. Everything behind it sees one union keyword at a time.

export function writeSdk(document: unknown, options: Parameters<typeof emitSdk>[1]): ReturnType<typeof emitSdk> {
  const split = normalizeSchemaUnions(document, options.locate);
  return emitSdk(split.document, split.locate ? { ...options, locate: split.locate } : options, split.moved);
}

export { loadValidatedDocument };
