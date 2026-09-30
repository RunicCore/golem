import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const moneyYaml = path.join(root, 'scripts/benchmark/fixtures/features/money.yaml');

export function generateFeatureMoneySdk(
  project: string,
  source: string,
  options: { readonly validation: boolean; readonly ajvStandalone: boolean },
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
  profile: { mobx: false, validation: ${options.validation}, ajvStandalone: ${options.ajvStandalone} },
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

export function copyGeneratedJavascript(source: string, project: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith('.js')) {
        const destination = path.join(project, 'build', path.relative(source, filename));
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(filename, destination);
      }
    }
  };
  visit(source);
}
