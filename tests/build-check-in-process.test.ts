// lane: typescript6 the in-process check of golem build: tsc-form diagnostics and exit status, listFiles, the refused tsc-command options and the forwarded arguments
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { mock } from 'node:test';
import { runBuild } from '#golem/build';
import { command } from './support/process.js';
import { TSC, write, editTsconfig, serdeProject, golemBuild } from './support/build-project.js';

/** What a command printed, without the line `golem build` ends with. */
const printed = (stdout: string): string => stdout.split('\n').filter((line) => !line.startsWith('Built ')).join('\n');

async function tsc(root: string, args: readonly string[]): Promise<string> {
  return (await command(root, process.execPath, [TSC, '-p', root, '--noEmit', ...args], { allowFailure: true })).stdout;
}

/** A project with two files that hold type errors, so that the order and the count of the report show. */
function failingProject(t: Parameters<typeof serdeProject>[0], name: string): string {
  const root = serdeProject(t, name);
  write(root, 'src/b.ts', "export const b: number = 'b';\nexport const c: number = 'c';\n");
  write(root, 'src/a.ts', "export const a: number = 'a';\n");
  return root;
}

for (const [option, flag] of [['generateTrace', ['--generateTrace', 'trace']], ['extendedDiagnostics', ['--extendedDiagnostics']], ['explainFiles', ['--explainFiles']], ['traceResolution', ['--traceResolution']], ['diagnostics', ['--diagnostics']]] as const) {
  for (const source of ['tsconfig', 'flag'] as const) {
    test(`golem build refuses ${option} from the ${source} before it generates, and names the tsc command that gives it`, async (t) => {
      // protects: T-461 D-78 the tsc-command options are refused the same from a tsconfig and a flag
      const root = serdeProject(t, `build-refuse-${option}-${source}`);
      fs.rmSync(path.join(root, '.golem'), { recursive: true, force: true });
      if (source === 'tsconfig') editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions[option] = option === 'generateTrace' ? 'trace' : true; });
      const result = await golemBuild(root, source === 'flag' ? flag : []);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`golem build does not support ${option} \\(.*tsconfig\\.json\\): .*Run tsc -p .*tsconfig\\.json --noEmit --${option}`));
      assert.equal(fs.existsSync(path.join(root, 'build')), false, 'nothing is emitted');
      assert.equal(fs.existsSync(path.join(root, '.golem')), false, 'nothing is generated');
    });
  }
}

for (const source of ['tsconfig', 'flag'] as const) {
  test(`golem build prints listFiles from the ${source} as tsc prints it`, async (t) => {
    // protects: T-461 D-78 listFiles is printed from the check program, in tsc's order and path form
    const root = serdeProject(t, `build-list-files-${source}`);
    write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
    if (source === 'tsconfig') editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.listFiles = true; });
    const built = await golemBuild(root, source === 'flag' ? ['--listFiles'] : []);
    assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
    const listed = printed(built.stdout);
    assert.ok(listed.includes(path.join(root, 'src/plain.ts')));
    assert.equal(listed, printed(await tsc(root, ['--listFiles'])));
  });
}

test('golem build prints the diagnostics of a failing check as tsc does, plain and pretty, and keeps the exit status', async (t) => {
  // protects: T-461 the check prints tsc's diagnostics, sorted, with the Found N errors line when pretty
  const root = failingProject(t, 'build-diagnostics');
  const plain = await golemBuild(root, []);
  assert.equal(printed(plain.stdout), printed(await tsc(root, ['--pretty', 'false'])));
  assert.match(plain.stdout, /src\/a\.ts\(1,14\): error TS2322[^]*src\/b\.ts\(1,14\): error TS2322/);
  assert.equal(plain.code, 2, 'the declarations are written, as the compiler reports it');
  const pretty = await golemBuild(root, ['--pretty']);
  assert.equal(printed(pretty.stdout), printed(await tsc(root, ['--pretty'])));
  assert.match(pretty.stdout, /Found 3 errors in 2 files\./);
  const skipped = await golemBuild(root, ['--declaration', 'false']);
  assert.equal(skipped.code, 1, 'no output of the check is written');
});

test('a declaration-less build with a type error and noEmitOnError stops before any file is written', async (t) => {
  // protects: T-461 noEmitOnError stops the build after a failed in-process check
  const root = failingProject(t, 'build-no-emit-on-error');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.noEmitOnError = true; });
  const result = await golemBuild(root, []);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
});

test('no tsc process starts for the check of a check-only build', async (t) => {
  // protects: T-461 the check runs in process
  const root = serdeProject(t, 'build-no-tsc-spawn');
  write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.noEmit = true; tsconfig.compilerOptions.declaration = false; });
  const spawn = mock.method(childProcess, 'spawn');
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await runBuild({ watch: false, config: path.join(root, 'golem.yaml') }), { exitCode: 0 });
  const compilerRuns = spawn.mock.calls.filter((call) => (call.arguments[1] as readonly unknown[] | undefined)?.some((argument) => typeof argument === 'string' && argument.endsWith(path.join('bin', 'tsc'))));
  assert.equal(compilerRuns.length, 0);
});

test('golem build refuses the tsc commands and the arguments that name files before it generates', async (t) => {
  // protects: T-461 an option only tsc takes, or a file argument, fails at once instead of building something else
  const root = serdeProject(t, 'build-refuse-commands');
  write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
  fs.rmSync(path.join(root, '.golem'), { recursive: true, force: true });
  for (const name of ['showConfig', 'listFilesOnly', 'version', 'help', 'init']) {
    const result = await golemBuild(root, [`--${name}`]);
    assert.notEqual(result.code, 0, name);
    assert.match(result.stderr, new RegExp(`golem build does not support --${name} \\(.*tsconfig\\.json\\): it is a command of tsc`), name);
  }
  const files = await golemBuild(root, ['src/plain.ts']);
  assert.notEqual(files.code, 0);
  assert.match(files.stderr, /name source files \(.*src\/plain\.ts\).*TS5042/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'nothing is emitted');
  assert.equal(fs.existsSync(path.join(root, '.golem')), false, 'nothing is generated');
});

test('with noEmitOnError a syntax error alone is printed, as tsc prints it, and nothing is emitted', async (t) => {
  // protects: T-461 a syntax error hides the type errors of the report, and noEmitOnError stops the build
  const root = serdeProject(t, 'build-syntax-no-emit-on-error');
  write(root, 'src/a.ts', "export const a: number = 'a';\n");
  write(root, 'src/b.ts', 'export const = ;\n');
  const flags = ['--noEmitOnError', '--pretty', 'false'];
  const result = await golemBuild(root, flags);
  assert.equal(printed(result.stdout), printed(await tsc(root, flags)));
  assert.match(result.stdout, /src\/b\.ts\(1,14\): error TS1134/);
  assert.doesNotMatch(result.stdout, /TS2322/);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
});
