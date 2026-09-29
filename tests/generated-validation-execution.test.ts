import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generate } from '#model/generator';
import { command, workspace } from './packed/helpers.js';

test('generated validation formats nested errors without replaying field getters', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'exprtlabs-generated-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  symlinkSync(path.join(workspace, 'packages/codegen'), path.join(root, 'node_modules/@exprtlabs/codegen'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build',
      rootDir: 'src' },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(path.join(root, 'src/example.model.ts'), readFixture("models/generated-validation-execution/generated-validation-formats-nested-errors-without-replaying-field-getters/example.model.ts"));
  const generated = generate({ root, profile: { mobx: false, validation: true } });
  for (const artifact of generated.artifacts) {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content);
  }
  await command(root, process.execPath, [path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'), '-p', 'tsconfig.json']);
  const module = await import(pathToFileURL(path.join(root, 'build/example.model.js')).href) as {
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
});

test('nested whole-object tag messages keep the child path and serde state unchanged', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'exprtlabs-generated-validation-tag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  symlinkSync(path.join(workspace, 'packages/codegen'), path.join(root, 'node_modules/@exprtlabs/codegen'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build',
      rootDir: 'src' },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(path.join(root, 'src/example.model.ts'), readFixture("models/generated-validation-execution/nested-whole-object-tag-messages-keep-the-child-path-and-serde-state-unchang/example.model.ts"));
  const generated = generate({ root, profile: { mobx: false, validation: true } });
  for (const artifact of generated.artifacts) {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content);
  }
  await command(root, process.execPath, [path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'), '-p', 'tsconfig.json']);
  const module = await import(pathToFileURL(path.join(root, 'build/example.model.js')).href) as {
    exercise(): Promise<{
      issue: { code: string; message: string; path: readonly (string | number)[]; source: string; representation?: string };
      matchingMessages: number;
      wire: unknown;
      stateUnchanged: boolean;
    }>;
  };
  const result = await module.exercise();
  assert.equal(result.issue.code, 'minProperties');
  assert.equal(result.issue.message, 'Child needs two fields.');
  assert.deepEqual(result.issue.path, ['child']);
  assert.equal(result.issue.source, 'typescript');
  assert.equal(result.issue.representation, 'model');
  assert.ok(result.matchingMessages >= 1);
  assert.deepEqual(result.wire, { child: { value: 1 } });
  assert.equal(result.stateUnchanged, true);
});
