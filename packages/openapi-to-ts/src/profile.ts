import type { CodegenProfile } from '@exprtlabs/codegen/generator-api';
import { resolveProfile } from '@exprtlabs/codegen/generator-api';

export interface OpenApiGenerationProfile extends CodegenProfile {}

export function requireProfile(profile: CodegenProfile | undefined): OpenApiGenerationProfile {
  if (profile === undefined || profile === null) {
    throw new TypeError('profile is required');
  }
  if (typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('profile must be an object');
  }
  if (typeof profile.mobx !== 'boolean' || typeof profile.validation !== 'boolean') {
    throw new TypeError('profile.mobx and profile.validation must be booleans');
  }
  return resolveProfile(profile);
}
