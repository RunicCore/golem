import assert from 'node:assert/strict';
import path from 'node:path';
import { createFixtureProject, type FixtureScope } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, importGeneratedModule, isGeneratedClientClass } from './helpers.js';

/** What a test of a generated client says about its SDK: the document, the client name, and how dates and checks are generated. */
interface SdkSetup {
  readonly document: unknown;
  readonly name: string;
  readonly dates: 'date' | 'temporal';
  readonly validation: boolean | 'sanity';
}

/** An SDK generated from a document and compiled once; `createClient` makes a client of it, with `baseUrl` set to a test address. */
export interface LoadedSdk<Client> {
  readonly output: string;
  createClient(options: Record<string, unknown>): Client;
}

export async function loadSdk<Client>(scope: FixtureScope, prefix: string, setup: SdkSetup): Promise<LoadedSdk<Client>> {
  const output = path.join(createFixtureProject(scope, prefix), 'sdk');
  await generateMaterializedSdk(setup.document, { output, name: setup.name, profile: { mobx: false, validation: setup.validation, allowAny: false }, dates: setup.dates });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const Constructor = (await importGeneratedModule(output, 'generated SDK'))[`${setup.name}Client`];
  assert.ok(isGeneratedClientClass(Constructor), 'generated client');
  return { output, createClient: (options) => new Constructor({ baseUrl: 'https://api.test', ...options }) as Client };
}
