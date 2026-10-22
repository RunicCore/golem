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

test('a folder is no module file: a folder named like a source is skipped, and a paths alias does not resolve to a folder', t => {
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
  assert.notEqual(resolve('@app/models'), path.join(root, 'src/models'));
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
