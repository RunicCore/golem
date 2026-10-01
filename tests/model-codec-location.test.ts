import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { generate } from '#model/generator';
import { createModelProject, writeModelSources } from './model-project.js';

// The shared generated module imports every TSerde and TValidation function. If the function lives in a model
// file, that file and its generated companion import each other, and loading the companion first leaves the
// generated base class uninitialized when the model class extends it.
function generateWith(t: TestContext, sources: Record<string, string>): () => unknown {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-codec-location-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, sources);
  return () => generate({ root, profile: { mobx: false, validation: true, ajvStandalone: false } });
}

const model = (imports: string, field: string) => `import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde, TValidation } from '@exprtlabs/golem/tags';
${imports}import { TTaskBaseModel } from './task.model.generated.js';
export type TTask = IModel<{ ${field} }>;
export class Task extends TTaskBaseModel {}
`;

test('a TSerde function declared in a model file is a generation error naming the function and the fix', t => {
  const run = generateWith(t, {
    'task.model.ts': `${model('', 'priority: number & TSerde<typeof toWord, typeof fromWord>')}
export function toWord(value: number): string { return String(value); }
export function fromWord(word: string): number { return Number(word); }
`,
  });
  assert.throws(run, /RUNM1065[^\n]*toWord[^\n]*task\.model\.ts[^\n]*own module/);
});

test('a TValidation predicate declared in a model file is a generation error', t => {
  const run = generateWith(t, {
    'task.model.ts': `${model('', 'title: string & TValidation<typeof notBlank>')}
export function notBlank(value: string): boolean { return value.trim() !== ''; }
`,
  });
  assert.throws(run, /RUNM1065[^\n]*notBlank/);
});

test('TSerde and TValidation functions in their own module generate', t => {
  const run = generateWith(t, {
    'rules.ts': `export function toWord(value: number): string { return String(value); }
export function fromWord(word: string): number { return Number(word); }
export function notBlank(value: string): boolean { return value.trim() !== ''; }
`,
    'task.model.ts': model("import type { fromWord, notBlank, toWord } from './rules.js';\n", 'priority: number & TSerde<typeof toWord, typeof fromWord>; title: string & TValidation<typeof notBlank>'),
  });
  assert.doesNotThrow(run);
});
