import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { workspace } from './support/process.js';
import { buildModelProject, writeModelGolemYaml } from './model-project.js';

test('generated validation formats nested errors without replaying field getters', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'exprtlabs-generated-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  symlinkSync(path.join(workspace, 'packages/golem'), path.join(root, 'node_modules/@exprtlabs/golem'), 'dir');
  symlinkSync(path.join(workspace, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build',
      rootDir: 'src' },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(path.join(root, 'src/getter-replay.model.ts'), readFixture("models/generated-validation-execution/generated-validation-formats-nested-errors-without-replaying-field-getters/example.model.ts"));
  writeFileSync(path.join(root, 'src/tag-message.model.ts'), readFixture("models/generated-validation-execution/nested-whole-object-tag-messages-keep-the-child-path-and-serde-state-unchang/example.model.ts"));
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const module = await import(pathToFileURL(path.join(root, 'build/getter-replay.model.js')).href) as {
    exercise(): Promise<{ plain: readonly { path: readonly (string | number)[] }[]; withState: readonly { path: readonly (string | number)[]; message: string }[]; plainReads: number[]; stateReads: number[]; stateUnchanged: boolean }>;
  };
  const result = await module.exercise();
  assert.equal(result.plain.length, 1);
  assert.deepEqual(result.plain[0].path, ['child', 'value']);
  assert.equal(result.withState.length, 1);
  assert.deepEqual(result.withState[0].path, ['child', 'value']);
  assert.equal(result.withState[0].message, 'Enter a number');
  assert.deepEqual(result.stateReads, result.plainReads);
  assert.equal(result.stateUnchanged, true);
  const tagModule = await import(pathToFileURL(path.join(root, 'build/tag-message.model.js')).href) as {
    exercise(): Promise<{
      issue: { code: string; message: string; path: readonly (string | number)[]; source: string; representation?: string };
      matchingMessages: number;
      wire: unknown;
      stateUnchanged: boolean;
    }>;
  };
  const tagResult = await tagModule.exercise();
  assert.equal(tagResult.issue.code, 'tooSmall');
  assert.equal(tagResult.issue.message, 'Child needs two fields.');
  assert.deepEqual(tagResult.issue.path, ['child']);
  assert.equal(tagResult.issue.source, 'typescript');
  assert.equal(tagResult.issue.representation, 'model');
  assert.ok(tagResult.matchingMessages >= 1);
  assert.deepEqual(tagResult.wire, { child: { value: 1 } });
  assert.equal(tagResult.stateUnchanged, true);
});
