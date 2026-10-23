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

/** The compiler's own resolution of an import: a program opens `main.ts` with an import of each specifier, and the answer is what the checker's `resolveImport` reads from it. */
function importResolver(t: TestContext, root: string, specifiers: readonly string[], compilerOptions: object = {}): (specifier: string) => string | undefined {
  const main = path.join(root, 'main.ts');
  fs.writeFileSync(main, specifiers.map((specifier) => `import ${JSON.stringify(specifier)};\n`).join(''));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true, ...compilerOptions }, include: ['main.ts'] }));
  const program = ts.createProgramFromSources({ root, sources: [main] });
  t.after(() => program.close());
  const checker = program.getTypeChecker();
  const imports = program.getSourceFile(main)!.statements.filter(ts.isImportDeclaration).map((statement) => statement.moduleSpecifier).filter(ts.isStringLiteralLike);
  return (specifier) => checker.resolveImport(imports.find((node) => node.text === specifier)!)?.resolvedFileName;
}

test('a relative specifier with a dot in its name resolves to the source that bears the name', t => {
  const root = createFixtureProject(t, 'golem-dotted-specifier-');
  fs.writeFileSync(path.join(root, 'user.model.ts'), 'export class User {}\n');
  const resolve = importResolver(t, root, ['./user.model', './user.model.js', './user.other']);
  assert.equal(resolve('./user.model'), path.join(root, 'user.model.ts'));
  assert.equal(resolve('./user.model.js'), path.join(root, 'user.model.ts'));
  assert.equal(resolve('./user.other'), undefined);
});

test('a folder is no module file: a folder named like a source is skipped, and a paths alias to a folder resolves to its index', t => {
  // protects: F-267 a folder named like a module file never resolves, and a paths alias to a folder resolves to its index
  const root = createFixtureProject(t, 'golem-folder-not-file-');
  fs.mkdirSync(path.join(root, 'src/models'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/util.ts'));
  fs.writeFileSync(path.join(root, 'src/models/index.ts'), 'export const value = 1;\n');
  const resolve = importResolver(t, root, ['./src/util', '@app/models'], { paths: { '@app/*': ['./src/*'] } });
  assert.equal(ts.sys.fileExists(path.join(root, 'src/models')), false);
  assert.equal(resolve('./src/util'), undefined);
  assert.equal(resolve('@app/models'), path.join(root, 'src/models/index.ts'));
});

test('a paths alias without an extension resolves to the source file or the index of the folder it names', t => {
  // protects: T-224 a paths alias probes extensions and index files on both TypeScript lanes
  const root = createFixtureProject(t, 'golem-paths-extensionless-');
  fs.mkdirSync(path.join(root, 'src/models'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/models/index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'src/plain.ts'), 'export const value = 1;\n');
  const resolve = importResolver(t, root, ['@app/plain', '@app/models'], { paths: { '@app/*': ['./src/*'] } });
  assert.equal(resolve('@app/plain'), path.join(root, 'src/plain.ts'));
  assert.equal(resolve('@app/models'), path.join(root, 'src/models/index.ts'));
});

test('a package subpath that the exports map hides does not resolve, and a package without an exports map resolves any file', t => {
  // protects: T-259 on TypeScript 7 the exports map decides alone, as on TypeScript 6; a hidden file is not found by a node_modules walk
  const root = createFixtureProject(t, 'golem-hidden-subpath-');
  fs.mkdirSync(path.join(root, 'node_modules/guarded'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/open'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/guarded/package.json'), JSON.stringify({ name: 'guarded', version: '1.0.0', exports: { './shown': { types: './shown.d.ts' } } }));
  fs.writeFileSync(path.join(root, 'node_modules/guarded/shown.d.ts'), 'export declare const value: number;\n');
  fs.writeFileSync(path.join(root, 'node_modules/guarded/hidden.d.ts'), 'export declare const value: number;\n');
  fs.writeFileSync(path.join(root, 'node_modules/open/package.json'), JSON.stringify({ name: 'open', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'node_modules/open/deep.d.ts'), 'export declare const value: number;\n');
  const resolve = importResolver(t, root, ['guarded/shown', 'guarded/hidden', 'open/deep']);
  const real = (file: string): string => fs.realpathSync(path.join(root, file));
  assert.equal(resolve('guarded/shown'), real('node_modules/guarded/shown.d.ts'));
  assert.equal(resolve('guarded/hidden'), undefined);
  assert.equal(resolve('open/deep'), real('node_modules/open/deep.d.ts'));
});

/** A project and its session, with the compiler options its tsconfig parses to; `lookup` resolves a name for a file of `sdk/`, as a manifest lookup does. */
function manifestLookup(t: TestContext, root: string): { readonly session: InstanceType<typeof ts.ProgramSession>; readonly lookup: (name: string, virtualFiles?: ReadonlySet<string>) => string | undefined } {
  fs.mkdirSync(path.join(root, 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true }, include: ['*.ts'] }));
  const session = new ts.ProgramSession({ cwd: root });
  t.after(() => session[Symbol.dispose]());
  const { options } = session.parseConfigFile(path.join(root, 'tsconfig.json'));
  return { session, lookup: (name, virtualFiles) => session.resolveModuleName(name, path.join(root, 'sdk/model-manifest.json'), options, undefined, virtualFiles).resolvedModule?.resolvedFileName };
}

test('a module that an SDK manifest names resolves to the require target of an exports map under NodeNext', t => {
  // protects: F-260 an SDK manifest JSON importer resolves with the require condition under Node16 and NodeNext, on both TypeScript lanes
  const root = createFixtureProject(t, 'golem-manifest-require-');
  fs.mkdirSync(path.join(root, 'node_modules/sdk-dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/sdk-dep/package.json'), JSON.stringify({ name: 'sdk-dep', version: '1.0.0', exports: { '.': { import: './esm.js', require: './cjs.js' } } }));
  fs.writeFileSync(path.join(root, 'node_modules/sdk-dep/esm.js'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'node_modules/sdk-dep/cjs.js'), 'exports.value = 1;\n');
  const { lookup } = manifestLookup(t, root);

  assert.equal(lookup('sdk-dep'), fs.realpathSync(path.join(root, 'node_modules/sdk-dep/cjs.js')));
});

test('a manifest lookup sees the disk and the files it is given, not the overlay of an open program', t => {
  // protects: T-345 the manifest lookup of both TypeScript lanes sees the same files
  const root = createFixtureProject(t, 'golem-manifest-files-');
  const { session, lookup } = manifestLookup(t, root);
  fs.writeFileSync(path.join(root, 'main.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'sdk/on-disk.ts'), 'export {};\n');
  const overlay = path.join(root, 'overlay.ts');
  const virtual = path.join(root, 'sdk/virtual.ts');
  using program = session.openProgram({ root, sources: [path.join(root, 'main.ts'), overlay], overlays: new Map([[overlay, 'export {};\n']]) });

  assert.equal(lookup('./on-disk.js'), path.join(root, 'sdk/on-disk.ts'));
  assert.equal(lookup('../overlay.js'), undefined);
  assert.equal(lookup('./virtual.js'), undefined);
  assert.equal(lookup('./virtual.js', new Set([virtual])), virtual);
  assert.equal(lookup('./virtual.js'), undefined);
  assert.ok(program.getSourceFile(overlay));

  // The lookups left the overlay of the open program as it was: another program with it still holds the file.
  using second = session.openProgram({ root, sources: [path.join(root, 'main.ts'), overlay], overlays: new Map([[overlay, 'export {};\n']]) });
  assert.ok(second.getSourceFile(overlay));
  // A lookup that stops on a package.json that is not JSON leaves the session usable.
  fs.mkdirSync(path.join(root, 'node_modules/broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/broken/package.json'), '{"name": "broken", ');
  assert.throws(() => lookup('broken'), /^Error: Cannot read .*package\.json to resolve a package import: /);
  using third = session.openProgram({ root, sources: [path.join(root, 'main.ts'), overlay], overlays: new Map([[overlay, 'export {};\n']]) });
  assert.ok(third.getSourceFile(overlay));
});

test('a manifest lookup follows an edit of a package exports map made between two lookups of one session', t => {
  // protects: T-345 the manifest lookup of both TypeScript lanes does not keep a package.json it read before an edit
  const root = createFixtureProject(t, 'golem-manifest-edit-');
  const dependency = path.join(root, 'node_modules/edited');
  fs.mkdirSync(dependency, { recursive: true });
  for (const name of ['first', 'second']) fs.writeFileSync(path.join(dependency, `${name}.d.ts`), 'export declare const value: number;\n');
  const exportsOf = (target: string): string => JSON.stringify({ name: 'edited', version: '1.0.0', exports: { '.': { types: target } } });
  fs.writeFileSync(path.join(dependency, 'package.json'), exportsOf('./first.d.ts'));
  const { lookup } = manifestLookup(t, root);
  assert.equal(lookup('edited'), fs.realpathSync(path.join(dependency, 'first.d.ts')));

  fs.writeFileSync(path.join(dependency, 'package.json'), exportsOf('./second.d.ts'));

  assert.equal(lookup('edited'), fs.realpathSync(path.join(dependency, 'second.d.ts')));
});

test('an import that resolves to no file resolves to a file the caller names as about to exist, through any import form and in the mode of the importer', t => {
  // protects: T-345 the lookup that counts companions a job is about to write follows #imports and the importer's module format
  const root = createFixtureProject(t, 'golem-virtual-files-');
  fs.mkdirSync(path.join(root, 'node_modules/dual'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, imports: { '#gen/*': './gen/*' } }));
  fs.writeFileSync(path.join(root, 'node_modules/dual/package.json'), JSON.stringify({ name: 'dual', version: '1.0.0', exports: { '.': { types: { import: './esm.d.ts', require: './cjs.d.ts' } } } }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true }, include: ['*.mts', '*.cts'] }));
  fs.writeFileSync(path.join(root, 'esm.mts'), "import 'dual';\nimport '#gen/order.js';\n");
  fs.writeFileSync(path.join(root, 'cjs.cts'), "import 'dual';\n");
  const program = ts.createProgramFromSources({ root, sources: [path.join(root, 'esm.mts'), path.join(root, 'cjs.cts')] });
  t.after(() => program.close());
  const checker = program.getTypeChecker();
  const specifiers = (file: string): readonly ts.StringLiteralLike[] => program.getSourceFile(path.join(root, file))!.statements.filter(ts.isImportDeclaration).map((statement) => statement.moduleSpecifier).filter(ts.isStringLiteralLike);
  const [dualOfEsm, generated] = specifiers('esm.mts');
  const [dualOfCjs] = specifiers('cjs.cts');
  const virtual = new Set(['gen/order.ts', 'node_modules/dual/esm.d.ts', 'node_modules/dual/cjs.d.ts'].map((file) => path.join(root, file)));

  assert.equal(checker.resolveImport(generated!), undefined);
  assert.equal(checker.resolveImport(generated!, virtual)?.resolvedFileName, path.join(root, 'gen/order.ts'));
  assert.equal(checker.resolveImport(dualOfEsm!, virtual)?.resolvedFileName, path.join(root, 'node_modules/dual/esm.d.ts'));
  assert.equal(checker.resolveImport(dualOfCjs!, virtual)?.resolvedFileName, path.join(root, 'node_modules/dual/cjs.d.ts'));
});

for (const [place, specifier, manifest] of [
  ['a # import reads the package.json above the importer', '#helper', 'package.json'],
  ['a package name reads the package.json of the installed package', 'dep/helper', 'node_modules/dep/package.json'],
] as const) {
  test(`${place}, and a text that is not JSON throws an error that names the file and keeps the parse error`, t => {
    // protects: T-7 a package.json that golem cannot parse is reported with its path and the parse error on both TypeScript lanes, not read as {}
    const root = createFixtureProject(t, 'golem-malformed-manifest-');
    fs.mkdirSync(path.join(root, 'node_modules/dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name": "app", "imports": { "#helper": "./helper.ts" }}');
    fs.writeFileSync(path.join(root, 'helper.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'node_modules/dep/package.json'), '{"name": "dep", "version": "1.0.0"}');
    fs.writeFileSync(path.join(root, 'node_modules/dep/helper.d.ts'), 'export declare const value: number;\n');

    fs.writeFileSync(path.join(root, manifest), '{"name": "broken", ');
    const resolve = importResolver(t, root, [specifier]);

    assert.throws(() => resolve(specifier), (error: unknown) => error instanceof Error
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
