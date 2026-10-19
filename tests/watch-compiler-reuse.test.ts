import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { resolveTypeScript } from '#golem/typescript-version';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';

// The compiler-process claims run on TypeScript 7, which has a compiler server process; the edits regenerate on both versions.
const skipOnTypeScript6 = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd()).major === 6
  && 'TypeScript 6 runs no compiler server process';

function fixture(t: TestContext): { root: string; config: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-watch-compiler-reuse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of ['golem', 'golem-model', 'golem-openapi']) {
    fs.symlinkSync(path.join(workspace, 'packages', name), path.join(root, 'node_modules/@exprtlabs', name), 'dir');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"watch-compiler-reuse-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(
    'validation: true\n',
    'validation: true\nallowAny: false\n',
  ));
  return { root, config };
}

/** A message that reports state is a function: it runs when the wait times out, not when the wait starts. */
async function until(check: () => boolean, message: string | (() => string), timeout = 25000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${typeof message === 'function' ? message() : message}`);
}

function compilerChildren(parent: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null && Number(match[2]) === parent && match[3].includes('--api'))
    .map(match => Number(match[1]));
}

test('watch reuses one compiler across edits and tsconfig path-mapping changes', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const { root, config } = fixture(t);
  const tsconfigFile = path.join(root, 'tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigFile, 'utf8')) as { compilerOptions: Record<string, unknown>; include: string[] };
  const writeTsconfig = (paths: string, include: readonly string[]): void => {
    fs.writeFileSync(tsconfigFile, JSON.stringify({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, paths: { '@extra/types': [paths] } },
      include,
    }));
  };
  fs.mkdirSync(path.join(root, 'shared'));
  fs.mkdirSync(path.join(root, 'types'));
  fs.writeFileSync(path.join(root, 'shared/v1.ts'), 'export type Extra = { firstShape: string };\n');
  fs.writeFileSync(path.join(root, 'shared/v2.ts'), 'export type Extra = { secondShape: string };\n');
  fs.writeFileSync(path.join(root, 'types/ambient.d.ts'), 'interface AmbientNote { ambientShape: string }\n');
  writeTsconfig('./shared/v1.ts', tsconfig.include);
  const modelSource = path.join(root, 'src/cart.model.ts');
  const original = fs.readFileSync(modelSource, 'utf8');
  const writeModel = (imports: readonly string[], fields: string): void => {
    fs.writeFileSync(modelSource, [...imports, original.replace('note: string', `note: string; ${fields}`)].join('\n'));
  };
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const generated = (): string => fs.existsSync(companion) ? fs.readFileSync(companion, 'utf8') : '';

  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const child = spawn(process.execPath, [binary, 'watch', '--config', config], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const runs = (): number => stdout.split('Generated configured outputs.').length - 1;
  const context = (): string => `(stdout=${stdout}, stderr=${stderr})`;
  const failsAfter = async (edit: () => void, pattern: RegExp, message: string): Promise<void> => {
    const reported = stderr.length;
    edit();
    await until(() => pattern.test(stderr.slice(reported)), () => `${message} ${context()}`);
  };

  try {
    await until(() => runs() >= 1, () => `initial generation ${context()}`);
    // Only TypeScript 7 runs its compiler in a child process; the edits below must regenerate on both versions.
    const [compiler] = compilerChildren(child.pid!);
    if (!skipOnTypeScript6) assert.ok(compiler, 'the watch keeps its compiler process between runs');

    // Every edit must reach the warm compiler, not only the first one.
    for (const field of ['firstEdit', 'secondEdit', 'thirdEdit']) {
      writeModel([], `${field}?: boolean`);
      await until(() => generated().includes(field), () => `edit ${field} regenerates ${context()}`);
    }

    writeModel(["import type { Extra } from '@extra/types';"], 'extra: Extra');
    await until(() => generated().includes('firstShape'), () => `the tsconfig path mapping resolves ${context()}`);

    // tsconfig edits change path mapping and the project file list.
    writeTsconfig('./shared/v2.ts', tsconfig.include);
    await until(() => generated().includes('secondShape'), () => `a path mapping edit is applied ${context()}`);
    await failsAfter(
      () => writeModel(["import type { Extra } from '@extra/types';"], 'extra: Extra; ambient: AmbientNote'),
      /AmbientNote/,
      'an ambient type outside the project is reported',
    );
    writeTsconfig('./shared/v2.ts', [...tsconfig.include, 'types/**/*.d.ts']);
    await until(() => generated().includes('ambientShape'), () => `an include edit is applied ${context()}`);
    if (!skipOnTypeScript6) assert.deepEqual(compilerChildren(child.pid!), [compiler], 'edits reuse the running compiler');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
  }
});
