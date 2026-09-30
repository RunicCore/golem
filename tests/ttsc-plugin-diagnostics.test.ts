import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#model/generator';
import { createModelProject } from './model-project.js';
import { ttsc, ttscEnv } from './support/process.js';

const ANSI = /\u001b\[[0-9;]*m/g;

function pluginProject(t: TestContext): string {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'runic-plugin-diagnostics-',
    linkTypescript: true,
    linkTtsc: true,
    ttscPlugin: true,
  });
  fs.writeFileSync(path.join(sourceRoot, 'clean.ts'), 'export const clean: string = "ok";\n');
  return root;
}

function runTtsc(root: string, args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [ttsc, ...args, '-p', path.join(root, 'tsconfig.json')], {
    cwd: root,
    env: { ...process.env, ...ttscEnv },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`.replace(ANSI, '') };
}

const modes = [['build', []], ['--noEmit', ['--noEmit']], ['check', ['check']]] as const;

test('ttsc with the codegen plugin reports TypeScript errors with code and line:col and fails', (t) => {
  const root = pluginProject(t);
  assert.equal(runTtsc(root, []).status, 0, 'a clean project compiles');
  fs.writeFileSync(path.join(root, 'src/broken.ts'), 'export const ok = 1;\nconst wrong: string = 5;\nexport { wrong };\n');
  for (const [label, args] of modes) {
    const { status, output } = runTtsc(root, args);
    assert.notEqual(status, 0, `${label}: a type error fails the command`);
    assert.match(output, /src\/broken\.ts:2:7\b[\s\S]*TS2322/, `${label}: ${output}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'build/broken.js')), false, 'errors block emit');
});

test('model generation reports source type errors with path:line:col and TS code', (t) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'runic-generate-diagnostics-', linkTypescript: true });
  fs.writeFileSync(path.join(sourceRoot, 'broken.model.ts'), `import type { IModel } from '@exprtlabs/codegen/model';
const wrong: string = 5;
export type TBroken = IModel<{ id: string }>;
export { wrong };
`);
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: false } }),
    /broken\.model\.ts:2:7 - error TS2322: Type 'number' is not assignable to type 'string'\./,
  );
});
