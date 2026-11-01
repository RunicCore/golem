import assert from 'node:assert/strict';
import test from 'node:test';

import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const OPTIONS = String.raw`options\?: __Golem(?:Serde|Validate)Options`;

test('model companion functions use the model types instead of unknown', t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-public-signatures-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'task.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TTaskBaseModel } from './task.model.generated.js';
export type TTask = IModel<{ title: string; done: boolean }>;
export class Task extends TTaskBaseModel {}
`,
  });
  const result = generate({ root, profile: { validation: true } });
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('task.model.generated.ts'))?.content ?? '';
  for (const signature of [
    `export function stringifyTTask\\(value: TTaskFields, ${OPTIONS}\\): string \\{`,
    `export function toWireFormatTTask\\(value: TTaskFields, ${OPTIONS}\\): TTaskJSON \\{`,
    `export function fromWireFormatTTask\\(wire: unknown, ${OPTIONS}\\): TTaskFields \\{`,
    `export function parseTTask\\(text: string, ${OPTIONS}\\): TTaskFields \\{`,
    `export function validateTTask\\(value: unknown, ${OPTIONS}\\): value is TTaskFields \\{`,
    `export function assertTTask\\(value: unknown, ${OPTIONS}\\): TTaskFields \\{`,
  ]) assert.match(companion, new RegExp(`^${signature}`, 'm'), signature);
});

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

test('model companion assert functions share one runtime helper and named option types', t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-assert-helper-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, priority(''));
  const result = generate({ root, profile: { validation: true } });
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('task.model.generated.ts'))?.content ?? '';
  assert.doesNotMatch(companion, /import\('@exprtlabs\/golem\/model'\)/);
  assert.doesNotMatch(companion, /validationContext === undefined\) \{\n\s+if \(!\(/);
  assert.match(companion, /^export function assertTTask\(value: unknown, options\?: __GolemValidateOptions\): TTaskFields \{\n  return __golemAssertModel_TTask\(value, options\);/m);
  assert.match(companion, /^function __golemAssertModel_TTask\(value: unknown, options\?: __GolemSerdeOptions\): TTaskFields \{\n  assertModelValue\(value, options, /m);
  assert.match(companion, /import type \{ SerdeOptions as __GolemSerdeOptions, ValidateOptions as __GolemValidateOptions \} from '@exprtlabs\/golem\/serde';/);
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
