import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProjectKind } from './cases.js';
import { generateFeatureMoneySdk } from './generate-sdk.js';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const upstreamDirectory = path.join(root, 'scripts/benchmark/fixtures/upstream');
const featureDirectory = path.join(root, 'scripts/benchmark/fixtures/features');
/** The feature models and rules the benchmark shares with tests/serde-features.acceptance.ts; both read them as data. */
const sharedFeatureDirectory = path.join(root, 'tests/fixtures/models/serde-features/src');
const featureSources = [
  'payloads.ts',
  'features-class-transformer.models.ts', 'features-class-validator.models.ts',
  'comparison-features-golem.ts', 'comparison-features-golem-object.ts', 'union-dispatch.model.ts', 'union-dispatch.ts',
  'comparison-features-class-transformer.ts', 'comparison-features-class-validator.ts',
];
const sharedFeatureSources = ['feature-tags.ts', 'features.model.ts', 'features.iobject.model.ts', 'access-rules.ts'];

/** Runs the model generator that `golemRoot` built, in a process of its own: the generator is an ES module with top-level await, so a synchronous caller cannot load it. */
function generateModels(golemRoot: string, project: string, profile: { readonly mobx: boolean; readonly validation: boolean }, manifest: string): void {
  const script = `
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from ${JSON.stringify(pathToFileURL(path.join(golemRoot, 'packages/golem-model/dist/generator.js')).href)};
const { artifacts } = generate({ root: ${JSON.stringify(project)}, profile: ${JSON.stringify(profile)}, manifestInputs: [${JSON.stringify(manifest)}] });
for (const artifact of artifacts) {
  mkdirSync(path.dirname(artifact.path), { recursive: true });
  writeFileSync(artifact.path, artifact.content);
}
`;
  // golem selects the TypeScript of its working directory, and that must be the install the checkout's own golem loads.
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: golemRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * `extraFixtures` are directories copied into the project beside the upstream fixtures; the other benchmarks pass none.
 * `mobx` is the generation profile's `mobx` flag: the MobX twins of the typia comparison need a project of their own.
 * `golemRoot` is the checkout whose built golem packages the project generates with and runs against: this checkout by
 * default, the base ref's export for the release check. The fixtures and the harness are always this checkout's.
 */
export function prepare(directory: string, kind: ProjectKind, extraFixtures: readonly string[] = [], mobx = false, golemRoot = root): string {
  const project = path.join(directory, kind);
  const src = path.join(project, 'src');
  cpSync(upstreamDirectory, src, { recursive: true });
  for (const extra of extraFixtures) cpSync(extra, src, { recursive: true });
  symlinkSync(path.join(golemRoot, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  copyFileSync(path.join(root, 'scripts/benchmark/fixture-contract.ts'), path.join(src, 'fixture-contract.ts'));
  for (const name of featureSources) copyFileSync(path.join(featureDirectory, name), path.join(src, name));
  for (const name of sharedFeatureSources) copyFileSync(path.join(sharedFeatureDirectory, name), path.join(src, name));
  writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
      experimentalDecorators: true, emitDecoratorMetadata: true, rootDir: 'src', outDir: 'build', types: ['node'],
      plugins: [{ transform: 'typia/lib/transform' }],
    },
    include: ['src/**/*.ts'],
  }));
  const profile = { mobx, validation: kind !== 'plain' };
  const manifest = generateFeatureMoneySdk(project, src, { validation: profile.validation, mobx }, path.join(golemRoot, 'packages/golem-openapi/dist/generator.js'));
  generateModels(golemRoot, project, profile, manifest);
  // The root keeps `ttsc` as a devDependency only for this call: typia's transform is a ttsc plugin. golem's own builds never use it.
  execFileSync(process.execPath, [path.join(root, 'node_modules/ttsc/lib/launcher/ttsc.js'), '-p', path.join(project, 'tsconfig.json')],
    { cwd: project, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return path.join(project, 'build/cases.js');
}

export function prepareProjects(directory: string, golemRoot = root): Record<ProjectKind, string> {
  return { plain: prepare(directory, 'plain', [], false, golemRoot), validating: prepare(directory, 'validating', [], false, golemRoot) };
}
