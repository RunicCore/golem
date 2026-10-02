import fs from 'node:fs';
import path from 'node:path';
import { generate as generateControllers } from '#controllers/generator';
import { generate as generateModels } from '#model/generator';
import { typescriptVersion } from '#golem/typescript-ns';

/** One project to generate; the identity test writes the list as JSON and runs this module in a child process per TypeScript version. */
export type IdentityCase =
  | { readonly name: string; readonly kind: 'model'; readonly root: string }
  | { readonly name: string; readonly kind: 'controller'; readonly root: string };

const [casesFile, outputDirectory] = process.argv.slice(2);
if (!casesFile || !outputDirectory) throw new Error('usage: identity-generate <cases.json> <output directory>');

// The seam's own version, so the test can tell which TypeScript each child ran.
process.stdout.write(`typescript ${typescriptVersion}\n`);

const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as readonly IdentityCase[];
for (const item of cases) {
  const artifacts = item.kind === 'model'
    ? generateModels({ root: item.root, profile: { mobx: false, validation: true } }).artifacts
    : (await generateControllers({
      root: item.root,
      output: path.join(item.root, 'openapi.json'),
      info: { title: 'Catalog', version: '1' },
      globalPrefix: 'api',
      uriVersioning: { type: 'URI', prefix: 'v' },
      profile: { mobx: false, validation: false },
    })).artifacts;
  for (const artifact of artifacts) {
    const destination = path.join(outputDirectory, item.name, path.relative(item.root, artifact.path));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, artifact.content);
  }
}
