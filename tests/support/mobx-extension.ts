import type { HookFill, HookParticipants } from '@exprtlabs/golem/generator-api';
import { extension } from '@exprtlabs/golem-openapi-ts/mobx-extension';

/** A profile of a test with the test-only switch `mobx`, which stands for `extensions: mobx: {}` in the openapi-ts block of golem.yaml. */
export type WithMobx<Profile> = Profile & { readonly mobx?: boolean };

function fill(hook: string): HookFill {
  const participant = extension.hooks?.[hook];
  return { package: '@exprtlabs/golem-openapi-ts', extension: 'mobx', options: {}, participant, use: (call) => call(participant) };
}

/** The fills that the mobx extension gives the jobs that a project with `extensions: mobx: {}` runs, built from the real extension entry. */
function mobxHooks(): HookParticipants {
  return { 'model.validatorEnhancer': [fill('model.validatorEnhancer')], 'client.operationWrapper': [fill('client.operationWrapper')] };
}

/** The profile a generator takes and the hooks of a test that calls it directly: `mobx: true` gives the fills of the extension, any other profile none. */
export function generatorSettings<Profile extends { readonly mobx?: boolean }>(profile: Profile): { readonly profile: Omit<Profile, 'mobx'>; readonly hooks?: HookParticipants } {
  const { mobx, ...rest } = profile;
  return mobx === true ? { profile: rest, hooks: mobxHooks() } : { profile: rest };
}
