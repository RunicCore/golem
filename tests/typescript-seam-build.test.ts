// lane: typescript6 parse with flags, tsc-form diagnostics, in-memory emit and option overrides of the compiler seam
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import { declarationOutputOf, flagsAsConfigOptions } from '#golem/typescript-config';
import { createFixtureProject } from './fixture-project.js';
import { TSC } from './support/build-project.js';

const COMPILER = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, types: [] };

function project(t: TestContext, files: Readonly<Record<string, string>>, compilerOptions: object = {}, inside = ''): { root: string; config: string } {
  const root = path.join(createFixtureProject(t, 'golem-seam-build-'), inside);
  fs.mkdirSync(root, { recursive: true });
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

const PRINTED: readonly (readonly [string, Readonly<Record<string, string>>, object?])[] = [
  ['no error', { 'src/a.ts': 'export const a: string = "x";\n' }],
  ['a syntax error hides the type errors', { 'src/a.ts': 'export const a: string = 1;\n', 'src/b.ts': 'export const = ;\n' }],
  ['errors in files created out of order', { 'src/z.ts': 'export const z: string = 1;\n', 'src/a.ts': 'export const a: string = 1;\n', 'src/m.ts': 'export const m: string = 1;\n' }],
  ['no library: global errors', { 'src/a.ts': 'export const a = 1;\n' }, { noLib: true }],
  ['one error', { 'src/a.ts': 'export const a: string = 1;\n' }],
  ['two errors in one file', { 'src/a.ts': 'export const a: string = 1;\nexport const b: string = 2;\n' }],
  ['errors in two files', { 'src/a.ts': 'export const a: string = 1;\nexport const b: string = 2;\n', 'src/b.ts': 'export const c: string = 3;\n' }],
];
for (const [name, files, options] of PRINTED) {
  test(`diagnostics print as tsc prints them: ${name}`, t => {
    // protects: T-460 T-461 the seam's tsc-form diagnostics (set and order), formatters and Found N errors summary equal tsc's plain and pretty output
    const { root, config } = project(t, files, { noEmit: true, ...options });
    using session = new ts.ProgramSession({ cwd: root });
    using program = session.openProgram({ root, sources: session.parseConfigFile(config).fileNames, configFile: config });
    const diagnostics = ts.getTscDiagnostics(program);
    assert.equal(ts.formatDiagnostics(diagnostics, host(root)), tsc(root, ['--pretty', 'false']));
    const printed = diagnostics.map((diagnostic) => `${ts.formatDiagnosticsWithColorAndContext([diagnostic], host(root))}\n`).join('');
    const pretty = `${printed}${ts.formatErrorSummary(diagnostics, host(root))}`;
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

test('each emitted file names the source file the compiler made it from, maps and declarations included, on both lanes', t => {
  // protects: T-474 the seam pairs every output with its source, so the build computes no layout of its own
  const { root, config } = project(t, { 'src/a.ts': 'export const a: number = 1;\n', 'src/b.mts': 'export const b = 1;\n' }, { declaration: true, declarationMap: true, sourceMap: true, outDir: 'build' });
  using session = new ts.ProgramSession({ cwd: root });
  using program = session.openProgram({ root, sources: session.parseConfigFile(config).fileNames, configFile: config });
  const paired = (kind: 'javascript' | 'declarations'): [string, string][] => [...program.emitToMemory(kind).sources].map(([output, source]): [string, string] => [path.relative(root, output), path.relative(root, source)]).toSorted();
  assert.deepEqual(paired('javascript'), [
    ['build/src/a.js', 'src/a.ts'], ['build/src/a.js.map', 'src/a.ts'], ['build/src/b.mjs', 'src/b.mts'], ['build/src/b.mjs.map', 'src/b.mts'],
  ]);
  assert.deepEqual(paired('declarations'), [
    ['build/src/a.d.ts', 'src/a.ts'], ['build/src/a.d.ts.map', 'src/a.ts'], ['build/src/b.d.mts', 'src/b.mts'], ['build/src/b.d.mts.map', 'src/b.mts'],
  ]);
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

test('arguments reach a program as the options of a configuration parsed under them: an enum, a list, a number and a boolean', t => {
  // protects: T-461 forwarded arguments (--target es2020, --lib es2020,dom) act on the check program
  const { root, config } = project(t, { 'src/a.ts': 'export const a: string = null;\n' });
  const flags = ['--target', 'es2020', '--lib', 'es2020,dom', '--maxNodeModuleJsDepth', '2', '--strict', 'false'];
  using session = new ts.ProgramSession({ cwd: root });
  const parsed = session.parseConfigFileWithFlags(config, flags);
  const sources = parsed.fileNames;
  using flagged = session.openProgram({ root, sources, configFile: config, flags });
  using plain = session.openProgram({ root, sources, configFile: config });
  using overridden = session.openProgram({ root, sources, configFile: config, flags, compilerOptionOverrides: { strict: true } });
  const picked = (options: ts.CompilerOptions) => ({ target: options.target, lib: options.lib, maxNodeModuleJsDepth: options.maxNodeModuleJsDepth, strict: options.strict });
  assert.deepEqual(picked(flagged.getCompilerOptions()), picked(parsed.options));
  assert.notDeepEqual(picked(plain.getCompilerOptions()), picked(parsed.options));
  assert.equal(ts.getTscDiagnostics(plain).length, 1);
  assert.equal(ts.getTscDiagnostics(flagged).length, 0);
  assert.equal(ts.getTscDiagnostics(overridden).length, 1, 'an override wins over an argument');
  assert.throws(() => session.openProgram({ root, sources, configFile: config, flags: ['--noSuchFlag'] }), /TS5023/);
});

test('a list argument with spaces reaches a program as the configuration parsed under it has it', t => {
  // protects: T-461 --lib "es2020, dom" reaches a program as the configuration parsed under it has it
  const { root, config } = project(t, { 'src/a.ts': 'export const a = 1;\n' });
  using session = new ts.ProgramSession({ cwd: root });
  const picked = (options: ts.CompilerOptions) => ({ lib: options.lib, types: options.types, maxNodeModuleJsDepth: options.maxNodeModuleJsDepth });
  const flags = ['--lib', 'es2020, dom'];
  const parsed = session.parseConfigFileWithFlags(config, flags);
  using program = session.openProgram({ root, sources: parsed.fileNames, configFile: config, flags });
  assert.deepEqual(picked(program.getCompilerOptions()), picked(parsed.options), flags.join(' '));
  assert.throws(() => session.parseConfigFileWithFlags(config, ['src/a.ts']), /name source files \(.*src\/a\.ts\).*TS5042/);
});

test('a package built in place under node_modules emits its declarations', t => {
  // protects: T-461 a project below a node_modules folder emits declarations to memory on both lanes
  const { root, config } = project(t, { 'src/a.ts': 'export const a: number = 1;\n' }, { declaration: true, outDir: 'build', rootDir: 'src' }, 'node_modules/pkg');
  using session = new ts.ProgramSession({ cwd: root });
  using program = session.openProgram({ root, sources: session.parseConfigFile(config).fileNames, configFile: config });
  assert.deepEqual([...program.emitToMemory('declarations').files.keys()], [path.join(root, 'build/a.d.ts')]);
});

test('a value of a list option is trimmed and empty means no items, and a negative number after an option is its value', () => {
  // protects: T-461 --lib "es2020, dom", --lib "" and --maxNodeModuleJsDepth -1 become tsconfig values whatever the lane's parser takes
  const parse = (args: readonly string[]) => ({ options: { [args[0]!.slice(2)]: args[1] === undefined ? true : args[0] === '--lib' ? [args[1]] : Number(args[1]) }, fileNames: [], errors: [] });
  assert.deepEqual(flagsAsConfigOptions(['--depth', '-1'], parse, (options) => options), { depth: -1 });
  assert.deepEqual(flagsAsConfigOptions(['--lib', ' es2020 , dom '], parse, (options) => options), { lib: ['es2020', 'dom'] });
  assert.deepEqual(flagsAsConfigOptions(['--lib', ''], parse, (options) => options), { lib: [] });
});

test('a project with references reads the declaration output of each referenced project as tsc -p does, also after it is built again', t => {
  // protects: T-477 the seam parses the references and opens the program on the declaration outputs, on both lanes
  const { root, config } = project(t, { 'src/main.ts': "import { x } from '../shared/src/x.js';\nexport const y: number = x;\n", 'shared/src/x.ts': "export const x = 'a';\n" }, { outDir: 'build', rootDir: 'src' });
  fs.writeFileSync(path.join(root, 'shared/tsconfig.json'), JSON.stringify({ compilerOptions: { ...COMPILER, composite: true, outDir: 'dist', rootDir: 'src' }, include: ['src'] }));
  fs.writeFileSync(config, JSON.stringify({ compilerOptions: { ...COMPILER, outDir: 'build', rootDir: 'src', noEmit: true }, include: ['src'], references: [{ path: './shared' }] }));
  const printed = (session: InstanceType<typeof ts.ProgramSession>): string => {
    using program = session.openProgram({ root, sources: session.parseConfigFile(config).fileNames, configFile: config, compilerOptionOverrides: { strict: true } });
    return ts.formatDiagnostics(ts.getTscDiagnostics(program), host(root));
  };
  using session = new ts.ProgramSession({ cwd: root });
  assert.deepEqual(session.parseConfigFile(config).projectReferences, [{ path: path.join(root, 'shared/tsconfig.json') }]);
  spawnSync(process.execPath, [TSC, '-p', 'shared'], { cwd: root });
  assert.match(printed(session), /^src\/main\.ts\(2,14\): error TS2322: Type 'string' is not assignable to type 'number'\.\n$/);
  assert.equal(printed(session), tsc(root, ['--pretty', 'false']));
  fs.writeFileSync(path.join(root, 'shared/src/x.ts'), 'export const x = 1;\n');
  spawnSync(process.execPath, [TSC, '-p', 'shared'], { cwd: root });
  assert.equal(printed(session), '');
  assert.equal(tsc(root, ['--pretty', 'false']), '');
});

for (const [name, source, options, output] of [
  ['an outDir and a rootDir', '/p/src/a/x.ts', { outDir: '/p/dist', rootDir: '/p/src' }, '/p/dist/a/x.d.ts'],
  ['a declarationDir before the outDir', '/p/src/x.ts', { outDir: '/p/dist', declarationDir: '/p/types', rootDir: '/p/src' }, '/p/types/x.d.ts'],
  ['no outDir: beside the source', '/p/src/x.tsx', { rootDir: '/p/src' }, '/p/src/x.d.ts'],
  ['a module source', '/p/src/x.mts', { outDir: '/p/dist', rootDir: '/p/src' }, '/p/dist/x.d.mts'],
  ['a commonjs source', '/p/src/x.cts', { outDir: '/p/dist', rootDir: '/p/src' }, '/p/dist/x.d.cts'],
  ['no rootDir: from the tsconfig folder', '/p/src/x.ts', { outDir: '/p/dist' }, '/p/dist/src/x.d.ts'],
] as const) {
  test(`the declaration file of a composite project's source: ${name}`, () => {
    // protects: T-477 the 7.1 resolver names the output as tsc does
    assert.equal(declarationOutputOf(source, '/p/tsconfig.json', options), output);
  });
}
