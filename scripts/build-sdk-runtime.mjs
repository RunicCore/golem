// Bundles the SDK runtime entry of @exprtlabs/golem into the files that @exprtlabs/golem-openapi ships in `sdk-runtime/`.
// A standalone SDK copies them, so its runtime needs no installed golem. The files are:
//   runtime.impl.ts   the minified bundle behind `// @ts-nocheck`; tsc copies a .ts value file to the SDK's outDir, but not a .js and .d.ts pair
//   runtime.ts        the facade: it casts each name of the bundle to its declared type in the entry, one statement per name so that a bundler keeps only the names an SDK imports
//   runtime.types.ts  the types barrel over the copied declaration files in types/
// The output depends on the compiled entry only, so two builds of one source give the same bytes.
// `--check` builds the files in memory and fails when the files on disk differ, which a `tsc` run on the entry alone leaves stale.
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
  ['client', [
    'ApiOperation', 'AuthContext', 'BasicAuthValue', 'BasicCredentials', 'BodyEncoder', 'BodyEncoderContext', 'ClientOptions', 'EncodedBody',
    'EncodingMetadata', 'InboundRequest', 'InboundResponse', 'MutualTlsTransport', 'OperationCodecs', 'ParameterSerializer',
    'ParameterSerializerContext', 'RequestOptions', 'ResponseHeaderDecoder', 'ResponseHeaderDecoderContext', 'RuntimeResponseContract',
    'RuntimeSecuritySchemes', 'StreamDecoder', 'StreamDecoderContext', 'TokenAuthValue', 'UndeclaredResponseError',
  ]],
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
    for (const [, , specifier] of text.matchAll(/(?:from|import)\s*\(?\s*(['"])(\.[^'"]*)\.js\1/g)) {
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

const closure = declarationClosure();
const files = new Map(closure.map((relative) => [path.join('types', relative), fs.readFileSync(path.join(dist, relative))]));
files.set('runtime.impl.ts', `// @ts-nocheck\n${bundle.outputFiles[0].text}`);
// A class or an enum is a value and a type at once, so the facade also exports its type: generated code names `ClientRuntime` as both.
const declared = new Set(closure.flatMap((relative) => [...fs.readFileSync(path.join(dist, relative), 'utf8').matchAll(/export declare (?:abstract )?(?:class|enum) (\w+)/g)].map(([, name]) => name)));
// One statement per name, so a bundler drops each name that the importing module does not use; a destructuring of the whole namespace keeps all of them in esbuild.
files.set('runtime.ts', [
  "import * as impl from './runtime.impl.js';",
  `import type * as Types from './types/${entry}.js';`,
  ...exportNames.flatMap((name) => [
    `export const ${name} = impl.${name} as unknown as typeof Types.${name};`,
    ...(declared.has(name) ? [`export type ${name} = Types.${name};`] : []),
  ]),
  '',
].join('\n'));
files.set('runtime.types.ts', [
  `export type * from './types/${entry}.js';`,
  ...barrelTypes.map(([module, names]) => `export type { ${names.join(', ')} } from './types/${module}.js';`),
  '',
].join('\n'));

if (process.argv.includes('--check')) {
  const onDisk = fs.existsSync(output) ? fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).filter((name) => fs.statSync(path.join(output, name)).isFile()) : [];
  const stale = [...files].filter(([name, content]) => !onDisk.includes(name) || !fs.readFileSync(path.join(output, name)).equals(Buffer.from(content)));
  const extra = onDisk.filter((name) => !files.has(name));
  if (stale.length > 0 || extra.length > 0) {
    console.error(`The SDK runtime in ${path.relative(root, output)} is stale against packages/golem/dist. Run: npm run build -w @exprtlabs/golem\n${[...stale.map(([name]) => `  differs: ${name}`), ...extra.map((name) => `  extra: ${name}`)].join('\n')}`);
    process.exit(1);
  }
} else {
  fs.rmSync(output, { recursive: true, force: true });
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true });
    fs.writeFileSync(path.join(output, name), content);
  }
}
