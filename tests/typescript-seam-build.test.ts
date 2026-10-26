// lane: typescript6 parse with flags, tsc-form diagnostics, in-memory emit and option overrides of the compiler seam
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import { createFixtureProject } from './fixture-project.js';
import { TSC } from './support/build-project.js';

const COMPILER = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, types: [] };

function project(t: TestContext, files: Readonly<Record<string, string>>, compilerOptions: object = {}): { root: string; config: string } {
  const root = createFixtureProject(t, 'golem-seam-build-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'seam-build', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...COMPILER, ...compilerOptions }, include: ['src'] }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return { root, config: path.join(root, 'tsconfig.json') };
}

function tsc(root: string, args: readonly string[]): string {
  return spawnSync(process.execPath, [TSC, '-p', root, ...args], { cwd: root, encoding: 'utf8' }).stdout;
}

const host = (root: string) => ({ getCanonicalFileName: (name: string) => name, getCurrentDirectory: () => root, getNewLine: () => '\n' });

test('a configuration parsed under flags takes the flags over its options and lists the files they match', t => {
  // protects: T-460 the seam parses a tsconfig with forwarded command-line options
  const { root, config } = project(t, { 'src/a.ts': 'export const a = 1;\n', 'src/b.js': 'export const b = 1;\n' });
  using session = new ts.ProgramSession({ cwd: root });
  const plain = session.parseConfigFile(config);
  const flagged = session.parseConfigFileWithFlags(config, ['--strict', 'false', '--allowJs']);
  assert.deepEqual(plain.fileNames, [path.join(root, 'src/a.ts')]);
  assert.deepEqual(flagged.fileNames.toSorted(), [path.join(root, 'src/a.ts'), path.join(root, 'src/b.js')]);
  assert.equal(plain.options.strict, true);
  assert.equal(flagged.options.strict, false);
  assert.equal(flagged.options.allowJs, true);
  assert.equal(flagged.options.target, plain.options.target);
  assert.throws(() => session.parseConfigFileWithFlags(config, ['--noSuchFlag']), /TS5023/);
});

const PRINTED: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['no error', { 'src/a.ts': 'export const a: string = "x";\n' }],
  ['one error', { 'src/a.ts': 'export const a: string = 1;\n' }],
  ['two errors in one file', { 'src/a.ts': 'export const a: string = 1;\nexport const b: string = 2;\n' }],
  ['errors in two files', { 'src/a.ts': 'export const a: string = 1;\nexport const b: string = 2;\n', 'src/b.ts': 'export const c: string = 3;\n' }],
];
for (const [name, files] of PRINTED) {
  test(`diagnostics print as tsc prints them: ${name}`, t => {
    // protects: T-460 the seam's diagnostics, formatters and Found N errors summary equal tsc's plain and pretty output
    const { root, config } = project(t, files, { noEmit: true });
    using session = new ts.ProgramSession({ cwd: root });
    using program = session.openProgram({ root, sources: session.parseConfigFile(config).fileNames, configFile: config });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(ts.formatDiagnostics(diagnostics, host(root)), tsc(root, ['--pretty', 'false']));
    const pretty = diagnostics.length === 0 ? '' : `${ts.formatDiagnosticsWithColorAndContext(diagnostics, host(root))}\n${ts.formatErrorSummary(diagnostics, host(root))}`;
    assert.equal(pretty, tsc(root, ['--pretty', 'true']));
  });
}

test('a program emits JavaScript and declarations to memory, equal to what tsc writes, and writes no file', t => {
  // protects: T-460 the seam emits JavaScript with maps, or declarations, to memory on both lanes
  const { root, config } = project(t, {
    'src/a.ts': 'export const a: number = 1;\nexport function twice(n: number): number { return n * 2; }\n',
    'src/b.ts': "import { twice } from './a.js';\nexport const b = twice(2);\n",
  }, { declaration: true, declarationMap: true, sourceMap: true, outDir: 'build', rootDir: 'src' });
  using session = new ts.ProgramSession({ cwd: root });
  using program = session.openProgram({ root, sources: session.parseConfigFile(config).fileNames, configFile: config });
  const out = (name: string): string => path.join(root, 'build', name);
  const javascript = program.emitToMemory('javascript');
  const declarations = program.emitToMemory('declarations');
  assert.deepEqual([...javascript.files.keys()].toSorted(), ['a.js', 'a.js.map', 'b.js', 'b.js.map'].map(out));
  assert.deepEqual([...declarations.files.keys()].toSorted(), ['a.d.ts', 'a.d.ts.map', 'b.d.ts', 'b.d.ts.map'].map(out));
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
  tsc(root, []);
  const written = fs.readdirSync(path.join(root, 'build')).toSorted();
  assert.equal(written.length, javascript.files.size + declarations.files.size);
  for (const [file, text] of [...javascript.files, ...declarations.files]) assert.equal(fs.readFileSync(file, 'utf8'), text, file);
});

test('compiler option overrides apply to one program through a virtual configuration that is no file', t => {
  // protects: T-460 the emit program takes noCheck and declaration false through a virtual tsconfig that extends the original
  const { root, config } = project(t, { 'src/a.ts': "export const a: number = 'x';\n" }, { declaration: true, outDir: 'build', rootDir: 'src' });
  using session = new ts.ProgramSession({ cwd: root });
  const sources = session.parseConfigFile(config).fileNames;
  const inputs: string[] = [];
  using emit = session.openProgram({ root, sources, configFile: config, compilerOptionOverrides: { noCheck: true, declaration: false }, onInput: (file) => inputs.push(file) });
  using check = session.openProgram({ root, sources, configFile: config });
  assert.deepEqual(ts.getPreEmitDiagnostics(emit), []);
  assert.deepEqual([...emit.emitToMemory('javascript').files.keys()], [path.join(root, 'build/a.js')]);
  assert.equal(emit.emitToMemory('declarations').emitSkipped, true);
  assert.equal(ts.getPreEmitDiagnostics(check).length, 1);
  assert.deepEqual([...check.emitToMemory('declarations').files.keys()], [path.join(root, 'build/a.d.ts')]);
  assert.equal(fs.existsSync(path.join(root, 'tsconfig.options.json')), false);
  assert.equal(inputs.some((file) => file.endsWith('tsconfig.options.json')), false);
  assert.equal(inputs.includes(config), true);
});
