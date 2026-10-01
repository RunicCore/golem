import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build, type Metafile } from 'esbuild';
import { generateFeatureMoneySdk } from './generate-sdk.js';
import { environment, gitState } from './results.js';

// Minified browser bundle sizes of golem's runtime entry points and of a one-operation SDK.
// Run after `npm run build && npm run build:scripts`:
//   node .build/scripts/benchmark/bundle-size.js

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Runtime entry points an application bundle can import; the tooling ones never reach a browser. */
export const RUNTIME_ENTRIES = [
  'model', 'conversion', 'tags', 'temporal', 'serde', 'errors', 'schema',
  'validation', 'ajv', 'mobx', 'mobx-validation', 'client',
] as const;

/** SDK profiles generated from scripts/benchmark/fixtures/features/money.yaml: one operation, one model. */
const SDK_PROFILES = [
  { id: 'sdk-no-validation', validation: false, ajvStandalone: false },
  { id: 'sdk-runtime-ajv', validation: true, ajvStandalone: false },
  { id: 'sdk-standalone-ajv', validation: true, ajvStandalone: true },
] as const;

const CLIENT_RUNTIME_CORE = /packages\/golem\/dist\/client-runtime\/core\.js$/;

interface BundleResult {
  readonly id: string;
  readonly minifiedBytes: number;
  readonly gzipBytes: number;
  /** Bytes from @exprtlabs/golem's own modules. */
  readonly golemBytes: number;
  /** Bytes from generated SDK files. */
  readonly sdkBytes: number;
  /** Bytes from third-party packages such as ajv or mobx. */
  readonly dependencyBytes: number;
  readonly clientRuntimeCoreBytes: number;
}

async function measure(id: string, entry: string): Promise<BundleResult> {
  const outfile = path.join(path.dirname(entry), `${id}.js`);
  const result = await build({
    entryPoints: [entry], outfile, bundle: true, minify: true, format: 'esm', platform: 'browser',
    target: 'es2022', write: false, metafile: true, logLevel: 'silent',
  });
  const code = result.outputFiles[0]!.contents;
  const inputs: Metafile['outputs'][string]['inputs'] = Object.values(result.metafile.outputs)[0]!.inputs;
  let golemBytes = 0;
  let sdkBytes = 0;
  let dependencyBytes = 0;
  let clientRuntimeCoreBytes = 0;
  for (const [file, { bytesInOutput }] of Object.entries(inputs)) {
    const normalized = file.split(path.sep).join('/');
    if (CLIENT_RUNTIME_CORE.test(normalized)) clientRuntimeCoreBytes += bytesInOutput;
    if (normalized.includes('packages/golem/')) golemBytes += bytesInOutput;
    else if (normalized.includes('/src/sdk/')) sdkBytes += bytesInOutput;
    else if (normalized.includes('node_modules/')) dependencyBytes += bytesInOutput;
  }
  return { id, minifiedBytes: code.byteLength, gzipBytes: gzipSync(code, { level: 9 }).byteLength, golemBytes, sdkBytes, dependencyBytes, clientRuntimeCoreBytes };
}

function createProject(directory: string, name: string): string {
  const project = path.join(directory, name);
  mkdirSync(path.join(project, 'src'), { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  return project;
}

export async function main(): Promise<void> {
  mkdirSync(path.join(root, '.cache/benchmark'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/bundle-work-'));
  try {
    const git = gitState(root);
    const results: BundleResult[] = [];
    const runtime = createProject(directory, 'runtime');
    for (const entry of RUNTIME_ENTRIES) {
      const file = path.join(runtime, 'src', `${entry}.ts`);
      writeFileSync(file, `export * from '@exprtlabs/golem/${entry}';\n`);
      results.push(await measure(`@exprtlabs/golem/${entry}`, file));
    }
    for (const profile of SDK_PROFILES) {
      const project = createProject(directory, profile.id);
      const src = path.join(project, 'src');
      generateFeatureMoneySdk(project, src, { validation: profile.validation, ajvStandalone: profile.ajvStandalone });
      // One call through the public entry, so tree shaking keeps what an application keeps.
      const file = path.join(src, 'app.ts');
      writeFileSync(file, `import { PaymentsClient } from './sdk/index.js';
const client = new PaymentsClient({ baseUrl: 'https://api.example.test' });
export const created = client.createPayment().execute({ body: { amount: 1, currency: 'EUR' } });
`);
      results.push(await measure(profile.id, file));
    }
    const output = path.join(root, '.cache/benchmark/bundle-size.json');
    writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), git, environment: environment(), bundler: 'esbuild, minified, esm, browser; gzip level 9', results }, null, 2) + '\n');
    const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
    const lines = [`${'bundle'.padEnd(34)} ${'minified'.padStart(10)} ${'gzip'.padStart(9)} ${'golem'.padStart(9)} ${'sdk'.padStart(9)} ${'deps'.padStart(9)} ${'core.js'.padStart(9)}`];
    for (const r of results) {
      lines.push(`${r.id.padEnd(34)} ${kb(r.minifiedBytes).padStart(10)} ${kb(r.gzipBytes).padStart(9)} ${kb(r.golemBytes).padStart(9)} ${kb(r.sdkBytes).padStart(9)} ${kb(r.dependencyBytes).padStart(9)} ${kb(r.clientRuntimeCoreBytes).padStart(9)}`);
    }
    process.stdout.write(`${lines.join('\n')}\n\nWrote ${path.relative(root, output)} (git ${git.sha.slice(0, 7)}${git.dirty ? ', dirty' : ''})\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
