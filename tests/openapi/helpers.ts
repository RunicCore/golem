import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import { isRecord } from '@exprtlabs/golem/generator-api';
import { findGeneratedModelDefinitionForConstructor } from '@exprtlabs/golem/model';
import { generate, type OpenApiGenerationContext, type OpenApiGenerationProfile, writeSdk as WriteSdk } from '#openapi/generator';

export type { OpenApiGenerationProfile };

export function repoRoot(): string {
  const golemDist = dirname(fileURLToPath(import.meta.resolve('@exprtlabs/golem/model')));
  return dirname(dirname(dirname(golemDist)));
}

export function openApiFixture(...parts: string[]): string {
  return join(repoRoot(), 'tests', 'openapi', ...parts);
}

export function tscBin(): string {
  return join(repoRoot(), 'tests/ttsc-cli.mjs');
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
  options: { output: string; name?: string; profile?: OpenApiGenerationProfile; check?: boolean },
): ReturnType<typeof WriteSdk> {
  const output = resolve(options.output);
  const profile = options.profile ?? defaultTestProfile;
  const result = writeSdk(document, { output, name: options.name, profile });
  if (options.check) {
    const changed = result.artifacts.filter(({ path: filename, content }) =>
      !existsSync(filename) || readFileSync(filename, 'utf8') !== content,
    ).map(({ path: filename }) => basename(filename));
    if (changed.length) throw new Error(`generated SDK is stale: ${changed.join(', ')}`);
  } else {
    writeGeneratedArtifacts(result.artifacts);
  }
  prepareSdkProject(output);
  for (const name of ['typescript', 'ttsc', '@types/node'] as const) {
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
      lib: ['ES2023', 'ESNext.Collection', 'DOM', 'DOM.Iterable'],
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
    throw new Error(compiled.stderr || compiled.stdout || 'ttsc failed');
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

export interface GeneratedClientInstance {
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
