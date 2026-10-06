import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '@exprtlabs/golem-model/generator';
import { MODES, type Mode } from './fixture-contract.js';
import { generateFeatureMoneySdk } from './generate-sdk.js';
import { root } from './project.js';

const featureDirectory = path.join(root, 'scripts/benchmark/fixtures/features');

export interface FeatureCheckResult { readonly modes: readonly { mode: Mode; checksum: number; cases: string[] }[]; readonly fixtures: readonly string[] }

function prepare(directory: string, mode: Mode): string {
  const project = path.join(directory, mode);
  const source = path.join(project, 'src');
  mkdirSync(source, { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
      rootDir: 'src', outDir: 'build', types: ['node'],
    },
    include: ['src/**/*.ts'],
  }));
  const profile = { mobx: false, validation: mode !== 'conversion-only' };
  writeFileSync(path.join(project, 'golem.yaml'), `version: 1\nmobx: ${profile.mobx}\nvalidation: ${profile.validation}\nmodels:\n  root: .\n`);
  for (const name of ['features.model.ts', 'features.iobject.model.ts', 'feature-tags.ts', 'cases.ts', 'access-rules.ts']) copyFileSync(path.join(featureDirectory, name), path.join(source, name));
  copyFileSync(path.join(root, 'scripts/benchmark/fixture-contract.ts'), path.join(source, 'fixture-contract.ts'));
  const manifest = generateFeatureMoneySdk(project, source, { validation: profile.validation });
  const result = generate({ root: project, profile, manifestInputs: [manifest] });
  for (const artifact of result.artifacts) {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content);
  }
  execFileSync(process.execPath, [path.join(root, 'packages/golem/dist/bin/golem.js'), 'build', '--config', path.join(project, 'golem.yaml')], { cwd: root, stdio: 'pipe', timeout: 120_000 });
  return path.join(project, 'build/cases.js');
}

export function checkFeatures(): FeatureCheckResult {
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/feature-check-'));
  const worker = fileURLToPath(new URL('./feature-check-worker.js', import.meta.url));
  try {
    let fixtures: readonly string[] = [];
    const modes = MODES.map(mode => {
      const output: { checksum: number; cases: string[]; fixtures: string[] } = JSON.parse(execFileSync(process.execPath,
        [worker, prepare(directory, mode), String(mode !== 'conversion-only')],
        { cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }));
      fixtures = output.fixtures;
      return { mode, checksum: output.checksum, cases: output.cases };
    });
    return { modes, fixtures };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
