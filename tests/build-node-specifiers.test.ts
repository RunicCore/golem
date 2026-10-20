// golem build writes the import paths Node loads: a Bundler project (no `.js` on its relative imports, an alias with no `baseUrl`,
// deep paths into packages with no `exports` map) builds to JavaScript that Node runs as ESM. The unit text of each specifier is
// tests/node-specifiers.test.ts; this file proves the build applies it, in the emitted code and in its source maps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decodeMappings } from '#golem/source-map';
import { copyFixture, fileFixtureScope, linkProjectPackages, onceShared } from './fixture-project.js';
import { MINIMAL_GOLEM_YAML, writeModelSources } from './model-project.js';
import { build } from './support/build-project.js';
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

/** The fixture project with a golem build over it. The fixture holds the user sources; the tests read what the build wrote. */
const built = onceShared(async () => {
  const root = createNodeSpecifierProject(scope, { prefix: 'golem-build-node-specifiers-', compilerOptions: { sourceMap: true } });
  copyFixture(path.join(root, 'src'), 'node-specifiers/src');
  writeModelSources(path.join(root, 'src'), { 'item.model.ts': ITEM_MODEL, 'construct.ts': CONSTRUCT_SITE });
  fs.writeFileSync(path.join(root, 'golem.yaml'), MINIMAL_GOLEM_YAML);
  linkProjectPackages(root, { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  const result = await build(root);
  return { root, result, main };
});

async function runBuilt(file: string): Promise<string> {
  const { root } = await built();
  return (await command(root, process.execPath, [path.join('build', file)])).stdout.trim();
}

test('golem build emits JavaScript that Node runs as ESM from extensionless, folder, alias and package deep-path imports', async () => {
  assert.equal((await built()).result.exitCode, 0);
  assert.equal(
    await runBuilt('main.js'),
    'x,dir,sibling+root+id,ts-named,id,already,legacy,inner,plain,thing,folder,kit,feature,nested,lazy,1,declared,3,dir,id,debounce',
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
