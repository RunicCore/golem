import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const moneyYaml = path.join(root, 'scripts/benchmark/fixtures/features/money.yaml');

export function generateFeatureMoneySdk(
  project: string,
  source: string,
  options: { readonly validation: boolean },
  generatorModule?: string,
): string {
  copyFileSync(moneyYaml, path.join(project, 'money.yaml'));
  const output = path.join(source, 'sdk');
  const script = `
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from ${JSON.stringify(generatorModule ? pathToFileURL(generatorModule).href : '@exprtlabs/golem-openapi/generator')};
const result = await generate({
  input: ${JSON.stringify(path.join(project, 'money.yaml'))},
  output: ${JSON.stringify(output)},
  name: 'Payments',
  profile: { mobx: false, validation: ${options.validation} },
});
for (const artifact of result.artifacts) {
  mkdirSync(path.dirname(artifact.path), { recursive: true });
  writeFileSync(artifact.path, artifact.content);
}
process.stdout.write(JSON.stringify(result.manifestPaths ?? []));
`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const manifests = JSON.parse(stdout.trim() || '[]') as string[];
  return manifests[0] ?? path.join(output, 'model-manifest.json');
}
