import path from 'node:path';
import type {
  GolemResult,
  OpenApiContext,
} from '@exprtlabs/golem/generator-api';
import { findRemoteRefs, validate } from './document.js';
import { writeSdk } from './emit.js';
import { generateModels } from './models.js';
import { identifier } from '@exprtlabs/golem/generator-api';
import { collectOperations, normalizeDocument } from './normalize.js';
import { API_VERSION } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  collectLocalReferenceInputs,
  loadOpenApiInput,
  loadValidatedDocument,
  type ReferenceResolutionOptions,
  readLimitedBody,
} from './resolver.js';
import { schemaType } from './types.js';

export type { InputObserver, OpenApiContext } from '@exprtlabs/golem/generator-api';
export type { OpenApiGenerationProfile } from './profile.js';
export type { OpenApiArtifact } from './emit.js';

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
  const result = writeSdk(loaded.document, { output, name: context.name, profile, locate: loaded.locate, ...(context.dates === undefined ? {} : { dates: context.dates }) });
  return {
    apiVersion: API_VERSION,
    artifacts: result.artifacts,
    manifestPaths: [path.resolve(output, 'model-manifest.json')],
    watchInputs: [...loaded.localInputs],
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

export type { ReferenceResolutionOptions };

export {
  collectOperations,
  collectLocalReferenceInputs,
  findRemoteRefs,
  generateModels,
  identifier,
  loadValidatedDocument,
  normalizeDocument,
  schemaType,
  validate,
  writeSdk,
  readLimitedBody,
};
