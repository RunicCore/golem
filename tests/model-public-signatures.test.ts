import assert from 'node:assert/strict';
import test from 'node:test';

import { generate } from '#model/generator';
import { createModelProject, writeModelSources } from './model-project.js';

const OPTIONS = String.raw`options\?: \{[^}]*\}`;

test('model companion functions use the model types instead of unknown', t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-public-signatures-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'task.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TaskBase } from './task.model.generated.js';
export type TTask = IModel<{ title: string; done: boolean }>;
export class Task extends TaskBase {}
`,
  });
  const result = generate({ root, profile: { mobx: false, validation: true, ajvStandalone: false } });
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('task.model.generated.ts'))?.content ?? '';
  for (const signature of [
    `export function stringifyTask\\(value: TaskFields, ${OPTIONS}\\): string \\{`,
    `export function toWireFormatTask\\(value: TaskFields, ${OPTIONS}\\): TaskJSON \\{`,
    `export function fromWireFormatTask\\(wire: unknown, ${OPTIONS}\\): TaskFields \\{`,
    `export function parseTask\\(text: string, ${OPTIONS}\\): TaskFields \\{`,
    `export function validateTask\\(value: unknown, ${OPTIONS}\\): value is TaskFields \\{`,
    `export function assertTask\\(value: unknown, ${OPTIONS}\\): TaskFields \\{`,
  ]) assert.match(companion, new RegExp(`^${signature}`, 'm'), signature);
});
