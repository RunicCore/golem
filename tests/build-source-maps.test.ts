// lane: typescript6 the output-to-source pairing of the TypeScript 6 emit, which finds the rewrite map of each emitted source map
// golem build points the source map of a rewritten file at the original, however the compiler wrote the map. The same holds for the declaration map of a declaration whose import paths it edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decodeMappings, pointInlineSourceMap } from '#golem/source-map';
import { build, editTsconfig, golemBuild, serdeProject, USE, write } from './support/build-project.js';

interface EmittedMap { readonly sourceRoot?: string; readonly sources: readonly string[]; readonly sourcesContent?: readonly string[]; readonly mappings: string }

/** The source map of a built file, from its `.map` file or from the data URL the compiler put in the JavaScript, and the URL the file names. */
function readMap(root: string, built: string): { readonly map: EmittedMap; readonly code: string; readonly url: string } {
  const file = path.join(root, built);
  const code = fs.readFileSync(file, 'utf8');
  const url = /^\/\/# sourceMappingURL=(.*)$/m.exec(code)![1]!;
  const inline = /^data:application\/json;base64,(.*)$/.exec(url);
  const text = inline ? Buffer.from(inline[1]!, 'base64').toString('utf8') : fs.readFileSync(`${file}.map`, 'utf8');
  return { map: JSON.parse(text) as EmittedMap, code, url };
}

/** Where the map says the rewritten `stringify` call of `USE` comes from. */
function originOfCall({ map, code }: { readonly map: EmittedMap; readonly code: string }): { readonly line: number; readonly column: number } {
  const generated = code.split('\n');
  const line = generated.findIndex((text) => text.includes('.stringify('));
  const column = generated[line]!.indexOf('requireObjectCodec');
  const segment = [...decodeMappings(map.mappings)[line]!].reverse().find((candidate) => candidate[0]! <= column);
  assert.ok(segment, 'a segment covers the rewritten call');
  return { line: segment[2]!, column: segment[3]! };
}

const ORIGINAL_LINES = USE.split('\n');
const ORIGINAL_LINE = ORIGINAL_LINES.findIndex((text) => text.startsWith('export const text'));
const ORIGINAL = { line: ORIGINAL_LINE, column: ORIGINAL_LINES[ORIGINAL_LINE]!.indexOf('stringify<TMoney>') };

const SETUPS = [
  { name: 'a map file', options: {}, url: /^use\.js\.map$/, sourceRoot: '', content: undefined },
  { name: 'an inline map', options: { sourceMap: false, inlineSourceMap: true }, url: /^data:application\/json;base64,/, sourceRoot: '', content: undefined },
  { name: 'sourceRoot', options: { sourceRoot: '/sources' }, url: /^use\.js\.map$/, sourceRoot: '/sources/', content: undefined },
  { name: 'mapRoot', options: { mapRoot: '/maps' }, url: /^\/maps\/use\.js\.map$/, sourceRoot: '', content: undefined },
  { name: 'inlineSources', options: { inlineSources: true }, url: /^use\.js\.map$/, sourceRoot: '', content: [USE] },
] as const;

for (const setup of SETUPS) {
  test(`a rewritten call maps back to its original line and column with ${setup.name}`, async (t) => {
    // protects: T-475 the rewrite map of an emitted map came from its sources text, which sourceRoot and mapRoot change, and an inline map was never mapped back
    const root = serdeProject(t, `build-source-map-${setup.name.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    write(root, 'src/use.ts', USE);
    write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
    editTsconfig(root, (tsconfig) => { tsconfig.include = ['**/*.ts']; Object.assign(tsconfig.compilerOptions, setup.options); });
    assert.deepEqual(await build(root), { exitCode: 0 });

    const used = readMap(root, 'build/use.js');
    assert.deepEqual(originOfCall(used), ORIGINAL);
    // A file with no call to rewrite keeps the map the compiler wrote, so it shows what the compiler wrote for this setup.
    const plain = readMap(root, 'build/plain.js');
    // TypeScript 7 leaves an empty sourceRoot out, TypeScript 6 writes it.
    assert.equal(used.map.sourceRoot ?? '', setup.sourceRoot);
    assert.equal(plain.map.sourceRoot ?? '', setup.sourceRoot);
    assert.deepEqual(used.map.sources, plain.map.sources.map((source) => source.replace(/plain\.ts$/, 'use.ts')));
    assert.match(used.url, setup.url);
    assert.deepEqual(used.map.sourcesContent, setup.content);
  });
}

test('a rewritten call maps back with an inlineSources that comes from the command line', async (t) => {
  // protects: T-475 golem build refused --inlineSources and the other source-map flags
  const root = serdeProject(t, 'build-source-map-flag');
  write(root, 'src/use.ts', USE);
  const result = await golemBuild(root, ['--inlineSources']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const used = readMap(root, 'build/use.js');
  assert.deepEqual(originOfCall(used), ORIGINAL);
  assert.deepEqual(used.map.sourcesContent, [USE]);
});

test('pointInlineSourceMap names the file of an inline source map that is missing or cannot be read', () => {
  // protects: T-475 a map that cannot be composed is never written as one that points at the rewritten text
  const inner = { version: 3, sources: [''], names: [], mappings: 'AAAA' } as const;
  const code = `export {};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from('not json').toString('base64')}\n`;
  assert.throws(() => pointInlineSourceMap('build/use.js', code, inner), (error: Error) => error.message.startsWith('golem build could not read the inline source map of build/use.js: '));
  assert.throws(() => pointInlineSourceMap('build/use.js', 'export {};\n', inner), { message: 'golem build could not find the inline source map at the end of build/use.js.' });
});

// The declaration of `f` keeps the import type as written, so the build edits `./a/b` to `./a/b.js` in front of the name `c`.
const DECLARED_B = 'export interface B { readonly size: number }\n';
const DECLARED_USE = "export function f(a: import('./a/b').B, c: string): void {}\n";

const DECLARATION_SETUPS = [
  { name: 'a .d.ts map', source: 'f.ts', declaration: 'build/f.d.ts', options: {}, sourceRoot: '' },
  { name: 'a declarationDir', source: 'f.ts', declaration: 'types/f.d.ts', options: { declarationDir: 'types' }, sourceRoot: '' },
  { name: 'a .d.mts map', source: 'f.mts', declaration: 'build/f.d.mts', options: {}, sourceRoot: '' },
  { name: 'sourceRoot', source: 'f.ts', declaration: 'build/f.d.ts', options: { sourceRoot: '/sources' }, sourceRoot: '/sources/' },
  { name: 'an inline map', source: 'f.ts', declaration: 'build/f.d.ts', options: { sourceMap: false, inlineSourceMap: true }, sourceRoot: '' },
] as const;

for (const setup of DECLARATION_SETUPS) {
  test(`a name after an edited import path maps back to its column in the source with ${setup.name}`, async (t) => {
    // protects: T-473 golem build edited the import paths of a declaration and left its map pointing at the text before the edit
    const root = serdeProject(t, `build-declaration-map-${setup.name.replace(/[^a-z]+/gi, '-').toLowerCase()}`);
    write(root, 'src/a/b.ts', DECLARED_B);
    write(root, `src/${setup.source}`, DECLARED_USE);
    editTsconfig(root, (tsconfig) => {
      tsconfig.include = ['src/**/*.ts', 'src/**/*.mts'];
      Object.assign(tsconfig.compilerOptions, { module: 'ESNext', moduleResolution: 'Bundler', declarationMap: true }, setup.options);
    });
    assert.deepEqual(await build(root), { exitCode: 0 });

    const { map, code } = readMap(root, setup.declaration);
    const declaration = code.split('\n');
    const line = declaration.findIndex((text) => text.startsWith('export declare function f('));
    assert.match(declaration[line]!, /import\('\.\/a\/b\.js'\)\.B/);
    const segment = decodeMappings(map.mappings)[line]!.find((candidate) => candidate[0] === declaration[line]!.indexOf('c: string'));
    assert.ok(segment, 'a segment starts at the name');
    assert.deepEqual({ line: segment[2], column: segment[3] }, { line: 0, column: DECLARED_USE.indexOf('c: string') });
    // The fields the compiler wrote stay as it wrote them.
    assert.equal(map.sourceRoot ?? '', setup.sourceRoot);
    assert.deepEqual(map.sources.map((source) => source.replace(/^.*\//, '')), [setup.source]);
  });
}
