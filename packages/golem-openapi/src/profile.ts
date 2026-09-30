import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { resolveProfile } from '@exprtlabs/golem/generator-api';

export interface OpenApiGenerationProfile extends GolemProfile {}

export function requireProfile(profile: GolemProfile | undefined): OpenApiGenerationProfile {
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
