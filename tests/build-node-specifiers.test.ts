// golem build writes the import paths Node loads: a Bundler project (no `.js` on its relative imports, an alias with no `baseUrl`,
// deep paths into packages with no `exports` map) builds to JavaScript that Node runs as ESM and to declarations that a NodeNext consumer resolves. The unit text of each specifier is
// tests/node-specifiers.test.ts; this file proves the build applies it, in the emitted code and in its source maps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decodeMappings } from '#golem/source-map';
import { copyFixture, fileFixtureScope, linkProjectPackages, onceShared } from './fixture-project.js';
import { MINIMAL_GOLEM_YAML, writeModelSources } from './model-project.js';
import { build, editTsconfig, TSC } from './support/build-project.js';
import { createNodeSpecifierProject } from './support/node-specifiers-project.js';
import { command, workspace } from './support/process.js';

const scope = fileFixtureScope();

// A class model that a call site imports with `import type`: the build adds the value import of the class for `construct`, and it copies the specifier of the type-only import.
const ITEM_MODEL = `import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated';

export type TItem = IModel<{ title: string }>;
export class Item extends TItemBaseModel {}
`;
const CONSTRUCT_SITE = `import { parse } from '@exprtlabs/golem/serde';
import type { Item } from './item.model';

const item = parse<Item>('{"title":"built"}');
console.log(\`\${item.constructor.name}:\${item.title}\`);
`;

// The declarations of a Bundler project. `thing` is inferred from `make`, so declaration emit writes the specifier of `./widget` itself.
const DECLARED_SOURCES = {
  'widget.ts': 'export interface Widget { readonly size: number }\n',
  'factory.ts': "import type { Widget } from './widget';\nexport function make(): Widget { return { size: 3 }; }\n",
  'api.ts': `import { id } from '@lib/ids';
import { debounce } from 'lodashy/debounce';
import { make } from './factory';
export { chain } from './reexport';
export * from './dir';
export const identifier: typeof id = id;
export const debounced: typeof debounce = debounce;
export const thing = make();
export const loadLazy = () => import('./lazy');
`,
};
// A NodeNext consumer of the built package: every import of its declarations needs the extension Node loads, and a package deep path needs its file.
const consumerSource = (declarations: string): string => `import { chain, debounced, dirValue, identifier, loadLazy, thing } from '../${declarations}/api.js';

export const size: number = thing.size;
// @ts-expect-error The size of a widget is a number.
export const wrongSize: string = thing.size;
export const values: [string, string, string, string] = [chain, debounced, dirValue, identifier];
export const lazy: Promise<{ readonly lazyValue: string }> = loadLazy();
`;

/** The fixture project with a golem build over it. The fixture holds the user sources; the tests read what the build wrote. */
function fixtureProject(compilerOptions: Readonly<Record<string, unknown>>): string {
  const root = createNodeSpecifierProject(scope, { prefix: 'golem-build-node-specifiers-', compilerOptions });
  copyFixture(path.join(root, 'src'), 'node-specifiers/src');
  writeModelSources(path.join(root, 'src'), { 'item.model.ts': ITEM_MODEL, 'construct.ts': CONSTRUCT_SITE, ...DECLARED_SOURCES });
  fs.writeFileSync(path.join(root, 'golem.yaml'), MINIMAL_GOLEM_YAML);
  linkProjectPackages(root, { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  return root;
}

async function buildFixture(compilerOptions: Readonly<Record<string, unknown>>) {
  const root = fixtureProject(compilerOptions);
  const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  const result = await build(root);
  return { root, result, main };
}

const built = onceShared(() => buildFixture({ sourceMap: true, declaration: true }));
const declarationsOnly = onceShared(() => buildFixture({ emitDeclarationOnly: true, declaration: true, declarationDir: 'types' }));

/** Type-check a NodeNext consumer of the declarations in `declarations` under the root, with `skipLibCheck` off so the declarations themselves are checked. */
async function checkConsumer(root: string, declarations: string): Promise<{ readonly code: number | null; readonly output: string }> {
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(path.join(consumer, 'index.mts'), consumerSource(declarations));
  fs.writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: false, types: [] },
    files: ['index.mts'],
  }));
  const checked = await command(consumer, process.execPath, [TSC, '-p', 'tsconfig.json'], { allowFailure: true });
  return { code: checked.code, output: `${checked.stdout}${checked.stderr}` };
}

async function runBuilt(file: string): Promise<string> {
  const { root } = await built();
  return (await command(root, process.execPath, [path.join('build', file)])).stdout.trim();
}

test('golem build emits JavaScript that Node runs as ESM from extensionless, folder, alias and package deep-path imports', async () => {
  assert.equal((await built()).result.exitCode, 0);
  assert.equal(
    await runBuilt('main.js'),
    'x,dir,sibling+root+id,ts-named,id,already,legacy,inner,plain,thing,folder,kit,feature,nested,lazy,1,declared,3,dir,id,debounce,true,lazy2,true',
  );
});

test('the import that the build adds for a type-only class import loads in Node', async () => {
  assert.equal(await runBuilt('construct.js'), 'Item:built');
});

test('the source map of a line with an edited specifier points at the original line', async () => {
  const { root, main } = await built();
  const mapFile = path.join(root, 'build/main.js.map');
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { sources: string[]; mappings: string };
  assert.deepEqual(map.sources.map(entry => path.resolve(path.dirname(mapFile), entry)), [path.join(root, 'src/main.ts')]);
  const generated = fs.readFileSync(path.join(root, 'build/main.js'), 'utf8').split('\n');
  const line = generated.findIndex(text => text.includes("import('./lazy.js')"));
  assert.notEqual(line, -1);
  const column = generated[line]!.indexOf('./lazy.js');
  const segment = [...decodeMappings(map.mappings)[line]!].reverse().find(candidate => candidate[0]! <= column);
  assert.ok(segment, 'a segment covers the edited specifier');
  assert.equal(segment[2], main.split('\n').findIndex(text => text.includes("import('./lazy')")));
});

test('a second golem build keeps the codec key of the class model that imports its generated base without .js', async () => {
  const { root } = await built();
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(await runBuilt('construct.js'), 'Item:built');
});

test('a NodeNext consumer type-checks against the declarations that golem build writes for a Bundler project', async () => {
  // protects: T-144 the declarations carry the specifiers Node resolves, as the JavaScript does
  const { root } = await built();
  assert.deepEqual(await checkConsumer(root, 'build'), { code: 0, output: '' });
});

test('a declarations-only build writes the same Node-resolvable declarations into its declarationDir', async () => {
  // protects: T-144 the emitDeclarationOnly branch changes the import paths too
  const { root, result } = await declarationsOnly();
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'no JavaScript and no declaration lands in the outDir');
  assert.deepEqual(await checkConsumer(root, 'types'), { code: 0, output: '' });
});

test('a build with no rootDir rewrites the declarations where the compiler wrote them, below the tsconfig directory', async () => {
  // protects: T-144 the declaration path follows tsc's rule: below the tsconfig directory when the sources share no deeper folder
  const root = fixtureProject({ declaration: true, rootDir: undefined });
  // With sources in two folders the compiler's output root is the tsconfig directory, so the declarations land in build/src/ and build/tools/.
  writeModelSources(root, { 'tools/probe.ts': "export { thing } from '../src/api';\n" });
  editTsconfig(root, tsconfig => { tsconfig.include = ['src/**/*.ts', 'src/**/*.js', 'tools/**/*.ts']; });
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/tools/probe.d.ts')));
  assert.deepEqual(await checkConsumer(root, 'build/src'), { code: 0, output: '' });
});
