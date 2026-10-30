// Bundles the SDK runtime entry of @exprtlabs/golem into the files that @exprtlabs/golem-openapi ships in `sdk-runtime/`.
// A standalone SDK copies them, so its runtime needs no installed golem. The files are:
//   runtime.impl.ts   the minified bundle behind `// @ts-nocheck`; tsc copies a .ts value file to the SDK's outDir, but not a .js and .d.ts pair
//   runtime.ts        the facade: it casts the import of the bundle once, to the declared types of the entry
//   runtime.types.ts  the types barrel over the copied declaration files in types/
// The output depends on the compiled entry only, so two builds of one source give the same bytes.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/golem/dist');
const output = path.join(root, 'packages/golem-openapi/sdk-runtime');
const entry = 'runtime-sdk';
// The types that generated SDK code names besides the values of the entry.
const barrelTypes = [
  ['client', ['ApiOperation', 'OperationCodecs', 'RuntimeResponseContract', 'RuntimeSecuritySchemes']],
  ['object-codec', ['SerdeOptions', 'ValidateOptions']],
  ['schema-registry-validation', ['OperationRuntimeValidators']],
  ['issue-messages', ['SchemaIssue']],
];

/** The declaration files that `entry.d.ts` reaches through relative imports, as paths below `dist`. */
function declarationClosure() {
  const seen = new Set();
  const visit = (relative) => {
    if (seen.has(relative)) return;
    seen.add(relative);
    const text = fs.readFileSync(path.join(dist, relative), 'utf8');
    for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']*)\.js'/g)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${specifier}.d.ts`)));
    }
  };
  visit(`${entry}.d.ts`);
  return [...seen].sort();
}

const bundle = await build({
  entryPoints: [path.join(dist, `${entry}.js`)],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  write: false,
  metafile: true,
  outfile: 'runtime.js',
  logLevel: 'warning',
});
const exportNames = Object.values(bundle.metafile.outputs)[0].exports.slice().sort();

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'types'), { recursive: true });
for (const relative of declarationClosure()) {
  const target = path.join(output, 'types', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(dist, relative), target);
}
fs.writeFileSync(path.join(output, 'runtime.impl.ts'), `// @ts-nocheck\n${bundle.outputFiles[0].text}`);
fs.writeFileSync(path.join(output, 'runtime.ts'), [
  "import * as impl from './runtime.impl.js';",
  `import type * as Types from './types/${entry}.js';`,
  'const typed = impl as unknown as typeof Types;',
  `export const { ${exportNames.join(', ')} } = typed;`,
  '',
].join('\n'));
fs.writeFileSync(path.join(output, 'runtime.types.ts'), [
  `export type * from './types/${entry}.js';`,
  ...barrelTypes.map(([module, names]) => `export type { ${names.join(', ')} } from './types/${module}.js';`),
  '',
].join('\n'));
