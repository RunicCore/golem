import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

// The codec and predicate live in their own module (RUNM1065); the preamble shifts every declaration in both files.
const priority = (preamble: string): Record<string, string> => ({
  'rules.ts': `${preamble}export function toWord(value: number): string { return String(value); }
export function fromWord(word: string): number { return Number(word); }
export function short(value: string): boolean { return value.length < 20; }
`,
  'task.model.ts': `${preamble}import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { fromWord, short, toWord } from './rules.js';
import { TTaskBaseModel } from './task.model.generated.js';

export type TTask = IModel<{ title: string & TValidation<typeof short>; priority: number & TSerde<typeof toWord, typeof fromWord> }>;
export class Task extends TTaskBaseModel {}
`,
});

test('reformatting model and codec sources leaves every generated file unchanged', t => {
  const generated = (preamble: string) => {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-reformat-', name: null, linkWorkspaceNodeModules: true });
    writeModelSources(sourceRoot, priority(preamble));
    const result = generate({ root, profile: { validation: true } });
    return new Map(result.artifacts.map(artifact => [artifact.path.slice(root.length), artifact.content]));
  };
  const before = generated('');
  const after = generated('// A comment and blank lines shift every declaration.\n\n\n');
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, content] of before) assert.equal(after.get(file), content, file);
});

const CONSUMER = `import { assertTTask, fromWireFormatTTask, parseTTask, stringifyTTask, toWireFormatTTask, validateTTask, type TTaskFields, type TTaskJSON } from './task.model.generated.js';

const task: TTaskFields = { title: 'a', priority: 1 };
export const text: string = stringifyTTask(task, { validate: false });
export const wire: TTaskJSON = toWireFormatTTask(task);
export const decoded: TTaskFields = fromWireFormatTTask(wire);
export const parsed: TTaskFields = parseTTask(text);
export function narrowed(value: unknown): TTaskFields { return validateTTask(value) ? value : assertTTask(value); }
// @ts-expect-error a title that is no string is no task
stringifyTTask({ title: 1, priority: 1 });
`;

test('model companion functions take and return the model types, and assert returns a valid model and throws for another', async t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-public-signatures-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { ...priority(''), 'consumer.ts': CONSUMER });
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const { assertTTask } = await import(path.join(root, 'build/task.model.generated.js')) as { assertTTask(value: unknown): unknown };
  assert.deepEqual(assertTTask({ title: 'a', priority: 1 }), { title: 'a', priority: 1 });
  assert.throws(() => assertTTask({ title: 'a'.repeat(20), priority: 1 }), error => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('model companion assert functions share one runtime helper', t => {
  // protects: F-129 generated code is lean: each assert function calls the shared helper and carries no check of its own
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-assert-helper-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, priority(''));
  const companion = generate({ root, profile: { validation: true } }).artifacts.find(artifact => artifact.path.endsWith('task.model.generated.ts'))?.content ?? '';
  assert.match(companion, /^export function assertTTask\(value: unknown, options\?: __GolemValidateOptions\): TTaskFields \{\n  return __golemAssertModel_TTask\(value, options\);/m);
  assert.match(companion, /^function __golemAssertModel_TTask\(value: unknown, options\?: __GolemSerdeOptions\): TTaskFields \{\n  assertModelValue\(value, options, /m);
});

test('a model file that declares only IObject types compiles under noUnusedLocals', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-object-only-', name: null, linkWorkspaceNodeModules: true,
    compilerOptions: { noUnusedLocals: true, noUnusedParameters: true },
  });
  writeModelSources(sourceRoot, {
    'note.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TAuthor = IObject<{ name: string & MinLength<1> }>;
export type TNote = IObject<{ text: string; author: TAuthor; at: Date }>;
`,
  });
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root, ['--noEmit']);
});
