import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError } from '@exprtlabs/golem/errors';

import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

// A model whose child is declared in another file still reads the child's wire form from JSON text.
const SOURCES = {
  'b.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TBBaseModel } from './b.model.generated.js';
export type TB = IModel<{ at: Date }>;
export class B extends TBBaseModel {}
`,
  'a.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TABaseModel } from './a.model.generated.js';
import type { TB } from './b.model.js';
export type TA = IModel<{ b: TB }>;
export class A extends TABaseModel {}
`,
  // A middle model reaches the child only through another model of its own file.
  'c.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TCBaseModel } from './c.model.generated.js';
import type { TA } from './a.model.js';
export type TMid = IModel<{ a: TA }>;
export type TC = IModel<{ mid: TMid }>;
export class C extends TCBaseModel {}
`,
};

async function build(t: test.TestContext) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-cross-file-wire-', name: 'cross-file-wire', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, SOURCES);
  writeModelGolemYaml(root, { validation: true });
  const result = await buildModelProject(root);
  assert.equal(result.code, 0, result.stderr);
  const load = (name: string) => import(`${pathToFileURL(path.join(root, 'build', name)).href}`);
  return { a: await load('a.model.generated.js'), c: await load('c.model.generated.js'), models: await load('a.model.js') };
}

test('parse reads the wire date of a child model declared in another file', async (t) => {
  // protects: bug T-161 parse and stringify of a model whose child in another file has a Date
  const { a, c, models } = await build(t);
  const text = '{"b":{"at":"2020-01-01T00:00:00.000Z"}}';
  for (const options of [undefined, { construct: models.A }]) {
    const parsed = a.parseTA(text, options);
    assert.ok(parsed.b.at instanceof Date);
    assert.equal(parsed.b.at.toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(a.stringifyTA(parsed), text);
  }
  assert.throws(() => a.parseTA('{"b":{"at":"not a date"}}'), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues.map((issue) => issue.path), [['b', 'at']]);
    return true;
  });
  const deep = c.parseTC(`{"mid":{"a":${text}}}`);
  assert.equal(deep.mid.a.b.at.toISOString(), '2020-01-01T00:00:00.000Z');
});
