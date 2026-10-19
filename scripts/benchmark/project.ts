import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '@exprtlabs/golem-model/generator';
import type { ProjectKind } from './cases.js';
import { generateFeatureMoneySdk } from './generate-sdk.js';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const upstreamDirectory = path.join(root, 'scripts/benchmark/fixtures/upstream');
const featureDirectory = path.join(root, 'scripts/benchmark/fixtures/features');
const featureSources = [
  'payloads.ts', 'feature-tags.ts', 'features.model.ts', 'features.iobject.model.ts',
  'features-class-transformer.models.ts', 'features-class-validator.models.ts',
  'comparison-features-golem.ts', 'comparison-features-golem-object.ts',
  'comparison-features-class-transformer.ts', 'comparison-features-class-validator.ts', 'access-rules.ts',
];

/**
 * `extraFixtures` are directories copied into the project beside the upstream fixtures; the other benchmarks pass none.
 * `mobx` is the generation profile's `mobx` flag: the MobX twins of the typia comparison need a project of their own.
 */
export function prepare(directory: string, kind: ProjectKind, extraFixtures: readonly string[] = [], mobx = false): string {
  const project = path.join(directory, kind);
  const src = path.join(project, 'src');
  cpSync(upstreamDirectory, src, { recursive: true });
  for (const extra of extraFixtures) cpSync(extra, src, { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  copyFileSync(path.join(root, 'scripts/benchmark/fixture-contract.ts'), path.join(src, 'fixture-contract.ts'));
  for (const name of featureSources) copyFileSync(path.join(featureDirectory, name), path.join(src, name));
  writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
      experimentalDecorators: true, emitDecoratorMetadata: true, rootDir: 'src', outDir: 'build', types: ['node'],
      plugins: [{ transform: 'typia/lib/transform' }],
    },
    include: ['src/**/*.ts'],
  }));
  const profile = { mobx, validation: kind !== 'plain' };
  const manifest = generateFeatureMoneySdk(project, src, { validation: profile.validation, mobx });
  const { artifacts } = generate({ root: project, profile, manifestInputs: [manifest] });
  for (const artifact of artifacts) {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content);
  }
  // The root keeps `ttsc` as a devDependency only for this call: typia's transform is a ttsc plugin. golem's own builds never use it.
  execFileSync(process.execPath, [path.join(root, 'node_modules/ttsc/lib/launcher/ttsc.js'), '-p', path.join(project, 'tsconfig.json')],
    { cwd: project, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return path.join(project, 'build/cases.js');
}

export function prepareProjects(directory: string): Record<ProjectKind, string> {
  return { plain: prepare(directory, 'plain'), validating: prepare(directory, 'validating') };
}
