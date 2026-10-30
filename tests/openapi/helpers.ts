import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import { isRecord } from '@exprtlabs/golem/internal/generator-support';
import { findGeneratedModelDefinitionForConstructor } from '@exprtlabs/golem/internal/model-runtime';
import { generate, type OpenApiGenerationContext, writeSdk as WriteSdk } from '#openapi/generator';
import type { OpenApiGenerationProfile } from '#openapi/profile';

export type { OpenApiGenerationProfile };

export function repoRoot(): string {
  const golemDist = dirname(fileURLToPath(import.meta.resolve('@exprtlabs/golem/model')));
  return dirname(dirname(dirname(golemDist)));
}

export function openApiFixture(...parts: string[]): string {
  return join(repoRoot(), 'tests', 'openapi', ...parts);
}

export function tscBin(): string {
  return join(repoRoot(), 'tests/tsc-cli.mjs');
}

export const defaultTestProfile: OpenApiGenerationProfile = Object.freeze({
  mobx: true,
  validation: true,
});

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function writeGeneratedSdk(
  writeSdk: typeof WriteSdk,
  document: unknown,
  options: { output: string; name?: string; profile?: OpenApiGenerationProfile },
): ReturnType<typeof WriteSdk> {
  const output = resolve(options.output);
  const profile = options.profile ?? defaultTestProfile;
  const result = writeSdk(document, { output, name: options.name, profile });
  writeGeneratedArtifacts(result.artifacts);
  prepareSdkProject(output);
  for (const name of ['typescript', '@types/node'] as const) {
    const source = join(repoRoot(), 'node_modules', name);
    if (existsSync(source)) linkProjectPackages(output, { [name]: source });
  }
  return result;
}

export function compileGeneratedSdk(
  output: string,
  extraFiles: string[] = [],
  compiler: {
    module?: string;
    moduleResolution?: string;
    skipLibCheck?: boolean;
    outDir?: string;
    noEmit?: boolean;
    strict?: boolean;
    noUnusedLocals?: boolean;
    noUnusedParameters?: boolean;
    exactOptionalPropertyTypes?: boolean;
    noUncheckedIndexedAccess?: boolean;
    lib?: readonly string[];
  } = {},
): void {
  const generatedJavascript: string[] = [];
  const outDir = resolve(output, compiler.outDir ?? 'dist');
  const collectJavascript = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && resolve(filename) !== outDir) {
        collectJavascript(filename);
      } else if (entry.isFile() && entry.name.endsWith('.generated.js')) {
        generatedJavascript.push(filename);
      }
    }
  };
  collectJavascript(output);
  const files = [
    join(output, 'index.ts'),
    ...generatedJavascript,
    ...extraFiles,
  ];
  const tsconfigPath = join(output, 'tsconfig.compile.json');
  writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: compiler.module ?? 'NodeNext',
      moduleResolution: compiler.moduleResolution ?? 'NodeNext',
      lib: compiler.lib ?? ['ES2023', 'ESNext.Collection', 'DOM', 'DOM.Iterable'],
      allowJs: true,
      skipLibCheck: compiler.skipLibCheck ?? true,
      typeRoots: [join(repoRoot(), 'node_modules/@types')],
      types: ['node'],
      strict: compiler.strict ?? false,
      noUnusedLocals: compiler.noUnusedLocals,
      noUnusedParameters: compiler.noUnusedParameters,
      exactOptionalPropertyTypes: compiler.exactOptionalPropertyTypes,
      noUncheckedIndexedAccess: compiler.noUncheckedIndexedAccess,
      ...(compiler.noEmit ? { noEmit: true } : { outDir: compiler.outDir ?? join(output, 'dist') }),
    },
    files: files.map((filename) => relative(output, filename) || filename),
  }, null, 2));
  const compiled = spawnSync(process.execPath, [tscBin(), '-p', tsconfigPath], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: join(repoRoot(), 'node_modules') },
  });
  if (compiled.status !== 0) {
    throw new Error(compiled.stderr || compiled.stdout || 'tsc failed');
  }
}

export function compileStrictUnusedSdk(output: string, extraFiles: string[] = []): void {
  compileGeneratedSdk(output, extraFiles, {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
  });
}

export const ALL_GENERATION_PROFILES: readonly OpenApiGenerationProfile[] = [
  { mobx: false, validation: false },
  { mobx: false, validation: true },
  { mobx: true, validation: false },
  { mobx: true, validation: true },
];

/** A minimal document of the given OpenAPI version titled `Regression`, extended with top-level fields. */
export function documentBase(openapi: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi,
    info: { title: 'Regression', version: '1' },
    ...extra,
  };
}

export function writeOpenApiDocument(directory: string, document: unknown, name = 'openapi.json'): string {
  const filename = join(directory, name);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`);
  return filename;
}

/**
 * Asserts that generating the document at `input` rejects with an Error whose message is `expected`:
 * a string must equal it, a RegExp must match it. `output` defaults to `sdk` beside the input and `profile`
 * to no MobX and no validation. `errorClass` also asserts the exact class of the error.
 */
export async function assertGenerationRejected(
  input: string,
  expected: string | RegExp,
  options: { profile?: OpenApiGenerationProfile; output?: string; errorClass?: ErrorConstructor } = {},
): Promise<void> {
  await assert.rejects(
    () => generate({
      input,
      output: options.output ?? join(dirname(input), 'sdk'),
      profile: options.profile ?? { mobx: false, validation: false },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      if (options.errorClass) assert.equal(error.constructor, options.errorClass);
      if (typeof expected === 'string') assert.equal(error.message, expected);
      else assert.match(error.message, expected);
      return true;
    },
  );
}

export function materializeGeneratedSdk(
  artifacts: readonly { path: string; content: string }[],
  output: string,
): void {
  writeGeneratedArtifacts(artifacts);
  prepareSdkProject(output);
}

function prepareSdkProject(output: string): void {
  const packageManifest = join(output, 'package.json');
  if (!existsSync(packageManifest)) writeFileSync(packageManifest, '{"type":"module"}\n');
  linkProjectPackages(output, { '@exprtlabs/golem': join(repoRoot(), 'packages/golem') });
}

export function artifactBasenames(artifacts: readonly { path: string }[]): string[] {
  return artifacts.map(({ path: filename }) => basename(filename)).sort();
}

export function generatedClientSource(artifacts: readonly { path: string; content: string }[]): string {
  return artifacts.filter(({ path: filename }) => basename(filename) === 'client.ts'
    || (basename(dirname(filename)) === 'operations' && filename.endsWith('.ts') && !filename.endsWith('.d.ts')))
    .map(artifact => artifact.content).join('\n');
}

export function readGeneratedClientSource(output: string): string {
  const files = [join(output, 'client.ts')];
  const operations = join(output, 'operations');
  if (existsSync(operations)) {
    files.push(...readdirSync(operations).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map(name => join(operations, name)));
  }
  return files.filter(existsSync).map(filename => readFileSync(filename, 'utf8')).join('\n');
}

function isModelImplementation(filename: string): boolean {
  return basename(dirname(filename)) === 'models' && /^_group-.*\.ts$/.test(basename(filename))
    && !filename.endsWith('.d.ts');
}

/** Inspect all canonical model implementations while keeping facade tests separate. */
export function generatedModelSource(artifacts: readonly { path: string; content: string }[]): string {
  return artifacts.filter(artifact => isModelImplementation(artifact.path))
    .map(artifact => artifact.content).join('\n');
}

export function readGeneratedModelSource(output: string): string {
  const files: string[] = [];
  const directory = join(output, 'models');
  if (existsSync(directory)) {
    files.push(...readdirSync(directory).map(name => join(directory, name)).filter(isModelImplementation));
  }
  return files.filter(existsSync).map(filename => readFileSync(filename, 'utf8')).join('\n');
}

export async function generateMaterializedSdk(
  document: unknown,
  options: {
    output: string;
    name?: string;
    profile?: OpenApiGenerationProfile;
    allowRemoteRefs?: boolean;
    remoteHosts?: readonly string[];
    maxRefBytes?: number;
    maxRefDocuments?: number;
    refTimeoutMs?: number;
    dates?: 'date' | 'temporal';
  },
): Promise<Awaited<ReturnType<typeof generate>>> {
  const directory = dirname(options.output);
  const input = writeOpenApiDocument(directory, document);
  const context: OpenApiGenerationContext = {
    input,
    output: resolve(options.output),
    name: options.name,
    profile: options.profile ?? defaultTestProfile,
    allowRemoteRefs: options.allowRemoteRefs,
    remoteHosts: options.remoteHosts,
    maxRefBytes: options.maxRefBytes,
    maxRefDocuments: options.maxRefDocuments,
    refTimeoutMs: options.refTimeoutMs,
    ...(options.dates === undefined ? {} : { dates: options.dates }),
  };
  const result = await generate(context);
  materializeGeneratedSdk(result.artifacts, options.output);
  return result;
}

export interface CapturedRequest {
  url: string;
  init: {
    method?: string;
    headers: Headers;
    body?: BodyInit | null;
    signal?: AbortSignal | null;
  };
}

export interface GeneratedModelClass {
  new (...args: never[]): object;
}

export function isGeneratedModelClass(value: unknown): value is GeneratedModelClass {
  return typeof value === 'function' && Boolean(findGeneratedModelDefinitionForConstructor(value));
}

interface GeneratedClientInstance {
  [name: string]: () => { execute: (
    input?: unknown,
    options?: unknown,
  ) => Promise<{
    status: number;
    body: unknown;
    headers?: Record<string, unknown>;
    contentType?: string | null;
  }>; readonly loading?: boolean };
}

export interface GeneratedClientClass {
  new (options: Record<string, unknown>): GeneratedClientInstance;
}

export function isGeneratedClientClass(value: unknown): value is GeneratedClientClass {
  return typeof value === 'function';
}

/** Imports a compiled module of a generated SDK (`dist/index.js` unless `file` names another) as a record. */
export async function importGeneratedModule(output: string, label: string, file = 'dist/index.js'): Promise<Record<string, unknown>> {
  return requireRecord(await import(pathToFileURL(join(output, file)).href), label);
}

/** Loads `<name>Client` from the compiled `dist/client.js` of a generated SDK. */
export async function loadGeneratedClient(output: string, name: string): Promise<GeneratedClientClass> {
  const module = await importGeneratedModule(output, `${name} client`, 'dist/client.js');
  const Client = module[`${name}Client`];
  assert.equal(isGeneratedClientClass(Client), true);
  if (!isGeneratedClientClass(Client)) throw new TypeError(`${name}Client`);
  return Client;
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export function captureRequest(url: string | URL | Request, init?: RequestInit): CapturedRequest {
  return {
    url: String(url),
    init: {
      method: typeof init?.method === 'string' ? init.method : undefined,
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    },
  };
}

/** The function `<prefix><Name>` that an SDK exports for its schema `Name` (`validate`, `fromWireFormat`, `toWireFormat`, `parse`, `stringify`, `assert`). */
export function sdkFunction<Result = unknown>(models: Record<string, unknown>, prefix: string, name: string): (...input: unknown[]) => Result {
  const found = models[`${prefix}${name}`];
  if (typeof found !== 'function') throw new TypeError(`The SDK exports no function ${prefix}${name}`);
  return found as (...input: unknown[]) => Result;
}
