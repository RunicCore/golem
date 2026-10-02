import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/ts';
import type * as Six from '#golem/typescript-ts6';
import type * as Seven from '#golem/typescript-ts7';
import type { TypeScriptBackend } from '#golem/typescript-types';
import { createFixtureProject } from './fixture-project.js';

type MissingFrom<Backend> = Exclude<keyof TypeScriptBackend, keyof Backend>;
type MustBeNever<Names extends never> = Names;
// Each line stops compiling when its backend module lacks a name the seam declares.
export type SixProvidesTheSeam = MustBeNever<MissingFrom<typeof Six>>;
export type SevenProvidesTheSeam = MustBeNever<MissingFrom<typeof Seven>>;

test('every name the facade exports is defined on the active backend', () => {
  assert.deepEqual(Object.entries(ts).filter(([, value]) => value === undefined).map(([name]) => name), []);
  assert.match(ts.typescriptVersion, /^[67]\./);
});

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
