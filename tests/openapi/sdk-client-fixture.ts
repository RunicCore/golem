import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPipeline } from '#golem/cli';
import { createFixtureProject, linkGolemPackages, type FixtureScope } from '../fixture-project.js';
import { command } from '../support/process.js';
import { TSC } from '../support/build-project.js';
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

/** A document of one operation, `createCharge`, that posts and returns the schema `Charge` of `schemas`. */
export function chargesDocument(schemas: Record<string, unknown>): unknown {
  const charge = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } };
  return {
    openapi: '3.1.0',
    info: { title: 'Charges', version: '1' },
    paths: { '/charges': { post: { operationId: 'createCharge', requestBody: { required: true, ...charge }, responses: { 200: { description: 'ok', ...charge } } } } },
    components: { schemas },
  };
}

/** An SDK of a golem-mode project: the document, the folder of the SDK in the project, and the client name. */
export interface GolemModeSdkSetup {
  readonly document: unknown;
  readonly folder: string;
  readonly name: string;
  readonly dates?: 'date' | 'temporal';
}

/**
 * A project with a golem.yaml of golem-mode openapi jobs and one models job, and no model file of its own: the pipeline has run, and `tsc` has built
 * the SDKs with the codecs file the models job wrote for each. `client` imports the built client of an SDK and makes a client of it.
 */
export interface GolemModeProject {
  readonly root: string;
  readonly config: string;
  client<Client>(sdk: GolemModeSdkSetup, options: Record<string, unknown>): Promise<Client>;
}

export function writeGolemModeProject(scope: FixtureScope, prefix: string, sdks: readonly GolemModeSdkSetup[], validation: boolean | 'sanity'): { readonly root: string; readonly config: string } {
  const root = createFixtureProject(scope, prefix);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"golem-mode-project","type":"module"}');
  linkGolemPackages(root, ['golem', 'golem-model', 'golem-openapi']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, rootDir: '.', outDir: 'build', lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] },
    include: ['src/**/*.ts', 'sdk/**/*.ts'],
  }));
  const jobs = sdks.map((sdk, index) => {
    fs.writeFileSync(path.join(root, `api${index}.json`), JSON.stringify(sdk.document));
    return [`    - input: api${index}.json`, `      output: ${sdk.folder}`, `      name: ${sdk.name}`, '      mode: golem', ...(sdk.dates ? [`      dates: ${sdk.dates}`] : [])];
  });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, ['version: 1', 'mobx: false', `validation: ${validation}`, 'openapi-ts:', '  sdks:', ...jobs.flat(), 'model: {}', ''].join('\n'));
  return { root, config };
}

/** `files` are written below the project before the pipeline runs, by path, so a model file can name the types of an SDK. */
export async function loadGolemModeProject(scope: FixtureScope, prefix: string, sdks: readonly GolemModeSdkSetup[], validation: boolean | 'sanity' = true, files: Readonly<Record<string, string>> = {}): Promise<GolemModeProject> {
  const { root, config } = writeGolemModeProject(scope, prefix, sdks, validation);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  await runPipeline(config);
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json']);
  return {
    root,
    config,
    client: async (sdk, options) => {
      const Constructor = (await import(pathToFileURL(path.join(root, 'build', sdk.folder, 'index.js')).href) as Record<string, unknown>)[`${sdk.name}Client`];
      assert.ok(isGeneratedClientClass(Constructor), 'generated client');
      return new Constructor({ baseUrl: 'https://api.test', ...options }) as never;
    },
  };
}

/** A golem-mode SDK made like `loadSdk` makes a standalone one, so one test can run against both modes. */
export async function loadGolemModeSdk<Client>(scope: FixtureScope, prefix: string, setup: SdkSetup): Promise<LoadedSdk<Client>> {
  const sdk: GolemModeSdkSetup = { document: setup.document, folder: 'sdk/api', name: setup.name, dates: setup.dates };
  const project = await loadGolemModeProject(scope, prefix, [sdk], setup.validation);
  const output = path.join(project.root, 'sdk/api');
  const Constructor = (await import(pathToFileURL(path.join(project.root, 'build/sdk/api/index.js')).href) as Record<string, unknown>)[`${setup.name}Client`];
  assert.ok(isGeneratedClientClass(Constructor), 'generated client');
  return { output, createClient: (options) => new Constructor({ baseUrl: 'https://api.test', ...options }) as Client };
}
