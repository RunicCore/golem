// lane: typescript6 the output-to-source pairing of the TypeScript 6 emit, which finds the rewrite map of each emitted source map
// golem build points the source map of a rewritten file at the original, however the compiler wrote the map.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decodeMappings, pointInlineSourceMap } from '#golem/source-map';
import { build, editTsconfig, serdeProject, USE, write } from './support/build-project.js';

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

test('an inline source map that cannot be read stops the build at its file', () => {
  // protects: T-475 a map that cannot be composed is never written as one that points at the rewritten text
  const inner = { version: 3, sources: [''], names: [], mappings: 'AAAA' } as const;
  const code = `export {};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from('not json').toString('base64')}\n`;
  assert.throws(() => pointInlineSourceMap('build/use.js', code, inner), (error: Error) => error.message.startsWith('golem build could not read the inline source map of build/use.js: '));
  assert.throws(() => pointInlineSourceMap('build/use.js', 'export {};\n', inner), { message: 'golem build could not find the inline source map at the end of build/use.js.' });
});
