import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import type * as Six from '#golem/typescript-ts6';
import type * as Seven from '#golem/typescript-ts7';
import type { TypeScriptBackend } from '#golem/typescript-types';
import { createFixtureProject } from './fixture-project.js';
import { pathMappedProject } from './support/path-mapped-project.js';

type MissingFrom<Backend> = Exclude<keyof TypeScriptBackend, keyof Backend>;
type MustBeNever<Names extends never> = Names;
// Each line stops compiling when its backend module lacks a name the seam declares.
export type SixProvidesTheSeam = MustBeNever<MissingFrom<typeof Six>>;
export type SevenProvidesTheSeam = MustBeNever<MissingFrom<typeof Seven>>;

test('every name the facade exports is defined on the active backend', () => {
  assert.deepEqual(Object.entries(ts).filter(([, value]) => value === undefined).map(([name]) => name), []);
  assert.match(ts.typescriptVersion, /^[67]\./);
});

test('a relative specifier with a dot in its name resolves to the source that bears the name', t => {
  const root = createFixtureProject(t, 'golem-dotted-specifier-');
  const main = path.join(root, 'main.ts');
  fs.writeFileSync(path.join(root, 'user.model.ts'), 'export class User {}\n');
  const resolve = (specifier: string): string | undefined => ts.resolveModuleName(specifier, main, {}, ts.sys).resolvedModule?.resolvedFileName;
  assert.equal(resolve('./user.model'), path.join(root, 'user.model.ts'));
  assert.equal(resolve('./user.model.js'), path.join(root, 'user.model.ts'));
  assert.equal(resolve('./user.other'), undefined);
});

test('a folder is no module file: a folder named like a source is skipped, and a paths alias to a folder resolves to its index', t => {
  // protects: T-181 the TypeScript 7 system answers fileExists as the TypeScript 6 system does, true for files only
  const root = createFixtureProject(t, 'golem-folder-not-file-');
  const main = path.join(root, 'main.ts');
  fs.mkdirSync(path.join(root, 'src/models'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/util.ts'));
  fs.writeFileSync(path.join(root, 'src/models/index.ts'), 'export const value = 1;\n');
  const options = { baseUrl: root, paths: { '@app/*': ['src/*'] } };
  const resolve = (specifier: string): string | undefined => ts.resolveModuleName(specifier, main, options, ts.sys).resolvedModule?.resolvedFileName;
  assert.equal(ts.sys.fileExists(path.join(root, 'src/models')), false);
  assert.equal(resolve('./src/util'), undefined);
  assert.equal(resolve('@app/models'), path.join(root, 'src/models/index.ts'));
});

test('a paths alias without an extension resolves to the source file or the index of the folder it names', t => {
  // protects: T-224 a paths alias probes extensions and index files on both TypeScript lanes
  const root = createFixtureProject(t, 'golem-paths-extensionless-');
  const main = path.join(root, 'main.ts');
  fs.mkdirSync(path.join(root, 'src/models'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/models/index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'src/plain.ts'), 'export const value = 1;\n');
  const options = { baseUrl: root, paths: { '@app/*': ['src/*'] } };
  const resolve = (specifier: string): string | undefined => ts.resolveModuleName(specifier, main, options, ts.sys).resolvedModule?.resolvedFileName;
  assert.equal(resolve('@app/plain'), path.join(root, 'src/plain.ts'));
  assert.equal(resolve('@app/models'), path.join(root, 'src/models/index.ts'));
});

test('a package subpath that the exports map hides does not resolve, and a package without an exports map resolves any file', t => {
  // protects: T-259 on TypeScript 7 the exports map decides alone, as on TypeScript 6; a hidden file is not found by a node_modules walk
  const root = createFixtureProject(t, 'golem-hidden-subpath-');
  const main = path.join(root, 'main.ts');
  fs.mkdirSync(path.join(root, 'node_modules/guarded'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/open'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/guarded/package.json'), JSON.stringify({ name: 'guarded', version: '1.0.0', exports: { './shown': { types: './shown.d.ts' } } }));
  fs.writeFileSync(path.join(root, 'node_modules/guarded/shown.d.ts'), 'export declare const value: number;\n');
  fs.writeFileSync(path.join(root, 'node_modules/guarded/hidden.d.ts'), 'export declare const value: number;\n');
  fs.writeFileSync(path.join(root, 'node_modules/open/package.json'), JSON.stringify({ name: 'open', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'node_modules/open/deep.d.ts'), 'export declare const value: number;\n');
  const resolve = (specifier: string): string | undefined => ts.resolveModuleName(specifier, main, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule?.resolvedFileName;
  const real = (file: string): string => fs.realpathSync(path.join(root, file));
  assert.equal(resolve('guarded/shown'), real('node_modules/guarded/shown.d.ts'));
  assert.equal(resolve('guarded/hidden'), undefined);
  assert.equal(resolve('open/deep'), real('node_modules/open/deep.d.ts'));
});

for (const [place, specifier, manifest] of [
  ['a # import reads the package.json above the importer', '#helper', 'package.json'],
  ['a package name reads the package.json of the installed package', 'dep/helper', 'node_modules/dep/package.json'],
] as const) {
  test(`${place}, and a text that is not JSON throws an error that names the file and keeps the parse error`, t => {
    // protects: T-7 a package.json that golem cannot parse is reported with its path and the parse error on both TypeScript lanes, not read as {}
    const root = createFixtureProject(t, 'golem-malformed-manifest-');
    const main = path.join(root, 'main.ts');
    fs.mkdirSync(path.join(root, 'node_modules/dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name": "app", "imports": { "#helper": "./helper.ts" }}');
    fs.writeFileSync(path.join(root, 'helper.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'node_modules/dep/package.json'), '{"name": "dep", "version": "1.0.0"}');
    fs.writeFileSync(path.join(root, 'node_modules/dep/helper.d.ts'), 'export declare const value: number;\n');
    const resolve = (): unknown => ts.resolveModuleName(specifier, main, {}, ts.sys);

    fs.writeFileSync(path.join(root, manifest), '{"name": "broken", ');

    assert.throws(resolve, (error: unknown) => error instanceof Error
      && error.message.startsWith(`Cannot read ${path.join(fs.realpathSync(root), manifest)} to resolve a package import: `)
      && error.cause instanceof SyntaxError);
  });
}

/** A project whose one source imports `dependency.ts` from disk. */
function sessionOnDiskDependency(t: TestContext): { readonly root: string; readonly main: string; readonly dependency: string } {
  const root = createFixtureProject(t, 'golem-session-disk-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'session-disk', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*.ts'],
  }));
  const main = path.join(root, 'src/main.ts');
  const dependency = path.join(root, 'src/dependency.ts');
  fs.writeFileSync(main, "import { value } from './dependency.js';\nexport const doubled = value * 2;\n");
  fs.writeFileSync(dependency, 'export const value = 1;\n');
  return { root, main, dependency };
}

test('a disk edit reported through inputsChanged gives a new SourceFile with the new text', t => {
  const { root, main, dependency } = sessionOnDiskDependency(t);
  using session = new ts.ProgramSession({ cwd: root });
  const first = session.openProgram({ root, sources: [main] });
  const before = first.getSourceFile(dependency);
  assert.ok(before);
  fs.writeFileSync(dependency, 'export const value = 22;\n');
  session.inputsChanged([dependency]);
  using second = session.openProgram({ root, sources: [main] });
  const after = second.getSourceFile(dependency);
  assert.ok(after && after !== before);
  assert.match(after.text, /value = 22/);
});

test('a disk edit that changes a file signature gives a new SourceFile without inputsChanged', t => {
  const { root, main, dependency } = sessionOnDiskDependency(t);
  using session = new ts.ProgramSession({ cwd: root });
  const first = session.openProgram({ root, sources: [main] });
  const before = first.getSourceFile(dependency);
  assert.ok(before);
  // The new text has another size, so the file's signature changes whatever the timestamp resolution.
  fs.writeFileSync(dependency, 'export const value = 22;\n');
  using second = session.openProgram({ root, sources: [main] });
  const after = second.getSourceFile(dependency);
  assert.ok(after && after !== before);
  assert.match(after.text, /value = 22/);
});

test('a source that exists only as an overlay is part of the program and its errors are reported', t => {
  const root = createFixtureProject(t, 'golem-overlay-only-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'overlay-only', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*.ts'],
  }));
  const onDisk = path.join(root, 'src/on-disk.ts');
  fs.writeFileSync(onDisk, 'export const onDisk: number = 1;\n');
  // One overlay-only source matches the configuration's include and one lies outside it.
  const inside = path.join(root, 'src/inside.generated.ts');
  const outside = path.join(root, 'generated/outside.ts');
  const overlays = new Map([[inside, 'export const inside: string = 1;\n'], [outside, 'export const outside: string = 2;\n']]);
  using session = new ts.ProgramSession({ cwd: root });
  using program = session.openProgram({ root, sources: [onDisk, inside, outside], overlays });
  const listed = new Set(program.getSourceFiles().map(file => file.fileName));
  for (const file of [onDisk, inside, outside]) assert.ok(listed.has(file), `${file} is part of the program`);
  const reported = ts.getPreEmitDiagnostics(program)
    .map(diagnostic => ts.formatDiagnosticsWithColorAndContext([diagnostic], { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  for (const file of [inside, outside]) {
    assert.ok(reported.some(text => text.includes(file) && text.includes('TS2322')), `${file} has its type error reported`);
  }
  assert.equal(reported.some(text => text.includes(onDisk)), false);
});

test('a diagnostic names the line and column of the compiler line map, also for a source that is not on disk', t => {
  // protects: F-37 both TypeScript lanes print the same line for a lone CR or a U+2028 line break
  const root = createFixtureProject(t, 'golem-diagnostic-line-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'diagnostic-line', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*.ts'],
  }));
  // TypeScript ends a line at \n, \r\n, a lone \r, U+2028 and U+2029; the error sits on line 3 or 4, never on line 1.
  const onDisk = path.join(root, 'src/breaks.ts');
  const unwritten = path.join(root, 'src/unwritten.generated.ts');
  // An astral character takes two UTF-16 units, as the compiler counts a column.
  const wide = path.join(root, 'src/wide.ts');
  fs.writeFileSync(wide, "export const s = '\u{1F600}'; export const c: string = 3;\n");
  fs.writeFileSync(onDisk, 'export const a = 1;\rexport const b = 2;\u2028export const c: string = 3;\n');
  using session = new ts.ProgramSession({ cwd: root });
  using program = session.openProgram({ root, sources: [onDisk, unwritten, wide], overlays: new Map([[unwritten, 'export const a = 1;\u2029export const b = 2;\r\nexport const c = 3;\rexport const d: string = 4;\n']]) });
  const host = { getCanonicalFileName: (name: string) => path.relative(root, name), getCurrentDirectory: () => root, getNewLine: () => '\n' };
  const printed = ts.getPreEmitDiagnostics(program).map(diagnostic => ts.formatDiagnosticsWithColorAndContext([diagnostic], host));
  assert.deepEqual(printed, [
    "src/breaks.ts:3:14 - error TS2322: Type 'number' is not assignable to type 'string'.",
    "src/unwritten.generated.ts:4:14 - error TS2322: Type 'number' is not assignable to type 'string'.",
    "src/wide.ts:1:37 - error TS2322: Type 'number' is not assignable to type 'string'.",
  ]);
});

test('an overlay-only source keeps the ambient declarations that the configuration lists in files', t => {
  const root = createFixtureProject(t, 'golem-overlay-ambient-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'types'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'overlay-ambient', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    files: ['types/ambient.d.ts'],
    include: ['src/**/*.ts'],
  }));
  const ambient = path.join(root, 'types/ambient.d.ts');
  const onDisk = path.join(root, 'src/on-disk.ts');
  const overlayOnly = path.join(root, 'src/uses-ambient.generated.ts');
  fs.writeFileSync(ambient, 'interface AmbientNote { text: string }\n');
  fs.writeFileSync(onDisk, 'export const onDisk = 1;\n');
  // The generator names the configuration's ambient files as roots, next to the sources and the artifacts.
  using session = new ts.ProgramSession({ cwd: root });
  using program = session.openProgram({
    root,
    sources: [onDisk, ambient, overlayOnly],
    overlays: new Map([[overlayOnly, 'export const note: AmbientNote = { text: "x" };\n']]),
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.text), []);
});

test('a program sees only its own overlays while another program is open', t => {
  const root = createFixtureProject(t, 'golem-overlay-scope-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'overlay-scope', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*.ts'],
  }));
  const x = path.join(root, 'src/x.ts');
  fs.writeFileSync(x, 'export const x: string = "on disk";\n');
  using session = new ts.ProgramSession({ cwd: root });
  using emit = session.openProgram({ root, sources: [x], overlays: new Map([[x, 'export const x: number = "rewritten";\n']]) });
  assert.match(emit.getSourceFile(x)?.text ?? '', /rewritten/);
  using check = session.openProgram({ root, sources: [x] });
  assert.match(check.getSourceFile(x)?.text ?? '', /on disk/, 'the program without overlays reads the file on disk');
  assert.match(emit.getSourceFile(x)?.text ?? '', /rewritten/, 'the held program keeps its overlay');
  assert.deepEqual(ts.getPreEmitDiagnostics(check).map(diagnostic => diagnostic.text), []);
  assert.match(ts.getPreEmitDiagnostics(emit).map(diagnostic => diagnostic.text).join('\n'), /'string' is not assignable to type 'number'/, 'the held program still type-checks its overlay');
});

// A tsconfig edit must reach the project however it interleaves with a manifest edit or with the reads of a program.
for (const hinted of [false, true]) {
  const how = hinted ? 'reported by the host' : 'found by the signatures';

  test(`a tsconfig edit made with a manifest edit is applied by the next program, ${how}`, t => {
    const project = pathMappedProject(t, 'golem-tsconfig-with-manifest-');
    using session = new ts.ProgramSession({ cwd: project.root });
    using first = session.openProgram({ root: project.root, sources: [project.app] });
    assert.equal(project.mappingOf(first), 'first');
    project.writeMapping('second');
    project.changeManifest();
    if (hinted) session.inputsChanged([project.tsconfig, project.manifest]);
    using second = session.openProgram({ root: project.root, sources: [project.app] });
    assert.equal(project.mappingOf(second), 'second');
  });

  test(`a tsconfig edit that lands while a program opens after a manifest edit is applied by the next program, ${how}`, t => {
    const project = pathMappedProject(t, 'golem-tsconfig-while-opening-');
    using session = new ts.ProgramSession({ cwd: project.root });
    let edits = 0;
    let armed = false;
    const open = (sources: readonly string[]): ts.Program => session.openProgram({
      root: project.root,
      sources,
      onInput: filename => {
        if (!armed || filename !== project.tsconfig) return;
        armed = false;
        edits++;
        project.writeMapping('second');
      },
    });
    open([project.app]).close();
    project.changeManifest();
    open([project.app]).close();
    armed = true;
    open([project.app, project.sdk]).close();
    assert.equal(edits, 1, 'the edit landed while the program opened');
    if (hinted) session.inputsChanged([project.tsconfig]);
    using next = open([project.app, project.sdk]);
    assert.equal(project.mappingOf(next), 'second');
  });
}
