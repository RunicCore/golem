// nodeSpecifierEdits gives the text of each import specifier that Node loads as ESM, from the compiler's own resolution of the
// specifier. The fixture (tests/fixtures/node-specifiers) is a Bundler project: no `.js` on its relative imports, an alias with no
// `baseUrl`, and fake packages with and without an `exports` map. TypeScript 6 and 7 writing the same text is the identity test's claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeSpecifierEdits } from '#golem/node-specifiers';
import { applyRewrites } from '#golem/rewrite';
import { projectSources } from '#golem/rewrite-scan';
import { createProjectProgram } from '@exprtlabs/golem/type-analysis';
import { copyFixture, fileFixtureScope, onceShared, type FixtureScope } from './fixture-project.js';
import { writeModelSources } from './model-project.js';
import { createNodeSpecifierProject } from './support/node-specifiers-project.js';

interface EditedFile {
  /** Old text to new text of each changed specifier. */
  readonly specifiers: ReadonlyMap<string, string>;
  /** The source after `applyRewrites`. */
  readonly code: string;
}

const scope = fileFixtureScope();

/** A project of the fixture's runnable sources (`src/`) and its compile-only edge cases (`src/edges/`), under the given extra options. */
function fixtureProject(t: FixtureScope, compilerOptions?: Readonly<Record<string, unknown>>): string {
  const root = createNodeSpecifierProject(t, { prefix: 'golem-node-specifiers-', ...(compilerOptions ? { compilerOptions } : {}) });
  copyFixture(path.join(root, 'src'), 'node-specifiers/src');
  copyFixture(path.join(root, 'src/edges'), 'node-specifiers/edges/src');
  return root;
}

/** `nodeSpecifierEdits` on every project source of the project, by path relative to its root. */
function editAll(root: string): ReadonlyMap<string, EditedFile> {
  using program = createProjectProgram(root, undefined, undefined, path.join(root, 'tsconfig.json')).program;
  const checker = program.getTypeChecker();
  const options = { compilerOptions: program.getCompilerOptions(), projectSources: new Set(projectSources(program).map(file => file.fileName)) };
  return new Map(projectSources(program).filter(file => !file.isDeclarationFile).map(file => {
    const { edits, specifiers } = nodeSpecifierEdits(file, checker, options);
    return [path.relative(root, file.fileName), { specifiers, code: applyRewrites(fs.readFileSync(file.fileName, 'utf8'), { edits, imports: [] }).code }];
  }));
}

const fixtureRun = onceShared(async () => editAll(fixtureProject(scope)));

async function edited(file: string): Promise<EditedFile> {
  const found = (await fixtureRun()).get(file);
  assert.ok(found, `${file} is a project source`);
  return found;
}

test('relative import without an extension gets the emitted extension', async () => {
  const { specifiers, code } = await edited('src/main.ts');
  assert.equal(specifiers.get('./x'), './x.js');
  assert.match(code, /^import \{ x \} from '\.\/x\.js';$/m);
});

test('relative folder import gets /index and the emitted extension', async () => {
  assert.equal((await edited('src/main.ts')).specifiers.get('./dir'), './dir/index.js');
});

test('a barrel import of . and .. names the index file of that folder', async () => {
  const { specifiers } = await edited('src/sub/a.ts');
  assert.equal(specifiers.get('.'), './index.js');
  assert.equal(specifiers.get('..'), '../index.js');
});

test('a relative .ts import becomes the emitted .js path', async () => {
  assert.equal((await edited('src/main.ts')).specifiers.get('./ts-named.ts'), './ts-named.js');
});

test('a relative import that already ends in .js keeps its text', async () => {
  const { specifiers, code } = await edited('src/main.ts');
  assert.equal(specifiers.has('./already.js'), false);
  assert.match(code, /^import \{ alreadyValue \} from '\.\/already\.js';$/m);
});

test('a relative import of a .js program source keeps its name and gets .js when it has no extension', async () => {
  assert.equal((await edited('src/main.ts')).specifiers.get('./legacy'), './legacy.js');
});

test('a relative import of a .d.ts program source keeps its text', async () => {
  const { specifiers, code } = await edited('src/main.ts');
  assert.equal(specifiers.has('./decl-only'), false);
  assert.match(code, /^import type \{ DeclOnly \} from '\.\/decl-only';$/m);
});

test('a paths alias to a .d.ts program source keeps its text', async () => {
  const { specifiers, code } = await edited('src/main.ts');
  assert.equal(specifiers.has('@lib/shapes'), false);
  assert.match(code, /^import type \{ Shape \} from '@lib\/shapes';$/m);
});

test('export from and a dynamic import with one string literal change like an import', async () => {
  const reexport = await edited('src/reexport.ts');
  assert.equal(reexport.code, "export * from './x.js';\nexport { dirInner as chain } from './dir/inner.js';\n");
  assert.match((await edited('src/main.ts')).code, /await import\('\.\/lazy\.js'\)/);
});

test('a type-only import changes too, so an import that the rewrite adds can copy its text', async () => {
  assert.equal((await edited('src/main.ts')).specifiers.get('./types'), './types.js');
});

test('a paths alias with no baseUrl becomes the relative path to its target', async () => {
  assert.equal((await edited('src/main.ts')).specifiers.get('@lib/ids'), './lib/ids.js');
  assert.equal((await edited('src/sub/a.ts')).specifiers.get('@lib/ids'), '../lib/ids.js');
});

test('a deep path of a package without exports gets .js, or /index.js for a folder', async () => {
  const { specifiers } = await edited('src/main.ts');
  assert.equal(specifiers.get('plain/helpers/thing'), 'plain/helpers/thing.js');
  assert.equal(specifiers.get('plain/folder'), 'plain/folder/index.js');
});

test('a deep path of a scoped package gets .js', async () => {
  assert.equal((await edited('src/main.ts')).specifiers.get('@scoped/kit/deep/util'), '@scoped/kit/deep/util.js');
});

test('a deep path of a package with exports keeps its text, also when a nested package.json has none', async () => {
  const { specifiers, code } = await edited('src/main.ts');
  assert.equal(specifiers.has('guarded/feature'), false);
  assert.equal(specifiers.has('guarded/nested/thing'), false);
  assert.match(code, /^import \{ nestedThing \} from 'guarded\/nested\/thing';$/m);
});

test('a bare package name and a deep path that already ends in .js keep their text', async () => {
  assert.match((await edited('src/main.ts')).code, /^import plain from 'plain';$/m);
  assert.match((await edited('src/edges/edges.ts')).code, /^import \{ thing as spelled \} from 'plain\/helpers\/thing\.js';$/m);
});

test('a specifier that the checker cannot resolve keeps its text, also a # import and a URL', async () => {
  const { code } = await edited('src/edges/edges.ts');
  assert.match(code, /^import '\.\/missing';$/m);
  assert.match(code, /^import '#internal';$/m);
  assert.match(code, /^import 'https:\/\/example\.com\/lib\.js';$/m);
});

test('a specifier with a # in its path keeps its text', async () => {
  assert.match((await edited('src/edges/edges.ts')).code, /^import '\.\/frag#ment';$/m);
});

test('.mts and .cts targets get .mjs and .cjs, and a .mjs import keeps its text', async () => {
  const { specifiers, code } = await edited('src/edges/edges.ts');
  assert.equal(specifiers.get('./esm.mts'), './esm.mjs');
  assert.equal(specifiers.get('./cjs.cts'), './cjs.cjs');
  assert.match(code, /^import \{ esm \} from '\.\/esm\.mjs';$/m);
});

test('a .tsx target gets .jsx when jsx is preserve, else .js', async t => {
  const preserved = editAll(fixtureProject(t, { jsx: 'preserve' })).get('src/edges/edges.ts');
  const compiled = editAll(fixtureProject(t, { jsx: 'react-jsx' })).get('src/edges/edges.ts');
  assert.equal(preserved?.specifiers.get('./view'), './view.jsx');
  assert.equal(compiled?.specifiers.get('./view'), './view.js');
});

test('an escaped specifier literal is replaced by its source position and keeps its quotes', t => {
  const root = createNodeSpecifierProject(t, { prefix: 'golem-node-specifiers-escaped-' });
  writeModelSources(path.join(root, 'src'), {
    'x.ts': 'export const x = 1;\n',
    'escaped.ts': 'import "./\\u0078";\nexport * from \'./\\x78\';\n',
  });
  assert.equal(editAll(root).get('src/escaped.ts')?.code, 'import "./x.js";\nexport * from \'./x.js\';\n');
});
