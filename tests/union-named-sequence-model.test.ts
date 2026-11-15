import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { decodeGeneratedModelTrusted } from '@exprtlabs/golem/internal/model-runtime';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';

import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

// A named array (a recursive array alias) beside a string in an untagged union, held by a field of a class-backed IModel. The model
// walker builds the class from plain data (the constructor) and decodes a wire value into it. Its union must tell the array from the
// string by `Array.isArray`, as the stringify walker does, or the array value takes the string branch and nothing in it converts.

const instant = '2025-01-02T03:04:05.000Z';

interface Owner { readonly name: string }
interface Node { readonly at: unknown; readonly owner: unknown; readonly children?: readonly Node[] }
interface Box { readonly items: string | readonly Node[] }
interface Models {
  readonly Owner: new (init: { name: string }) => Owner;
  readonly Box: new (init: { items: unknown }) => Box;
}

/** A built project of a class-backed `Box` whose `items` is `TTree | string`; a node of the tree holds a date and an `Owner` model. */
async function buildBox(t: Parameters<typeof createModelProject>[0], validation: GolemProfile['validation']): Promise<Models> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-union-named-sequence-model-', name: 'union-named-sequence-model', linkTypescript: true });
  writeModelGolemYaml(root, { validation });
  writeModelSources(sourceRoot, {
    'box.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TBoxBaseModel, TOwnerBaseModel } from './box.model.generated.js';
export type TOwner = IModel<{ name: string }>;
export class Owner extends TOwnerBaseModel {}
export type TTree = { at: Date; owner: Owner; children?: TTree }[];
export type TBox = IModel<{ items: TTree | string }>;
export class Box extends TBoxBaseModel {}
`,
  });
  await buildModelProject(root);
  return await import(pathToFileURL(path.join(root, 'build/box.model.js')).href) as Models;
}

for (const [label, validation] of [['validation on', true], ['validation sanity', 'sanity'], ['validation off', false]] as const) {
  test(`a class-backed model built from a recursive array beside a string builds the models of the array and keeps the string (${label})`, async (t) => {
    // protects: T-905 the model walker took no named-sequence classification, so its union let an array value pass as it was and built no model of it
    const models = await buildBox(t, validation);
    const built = new models.Box({ items: [{ at: new Date(instant), owner: { name: 'a' }, children: [{ at: new Date(instant), owner: { name: 'b' } }] }] });
    const [node] = built.items as readonly Node[];
    assert.ok(node.owner instanceof models.Owner, 'the model of the first level');
    assert.ok(node.children![0].owner instanceof models.Owner, 'the model of the nested level');
    assert.equal(new models.Box({ items: 'text' }).items, 'text');
  });

  test(`a class-backed model decoded from a recursive array beside a string converts the array and keeps the string (${label})`, async (t) => {
    // protects: T-905 the model walker took no named-sequence classification, so its decode left the dates of an array value as strings
    const models = await buildBox(t, validation);
    const decoded = decodeGeneratedModelTrusted(models.Box as never, { items: [{ at: instant, owner: { name: 'a' }, children: [{ at: instant, owner: { name: 'b' } }] }] }) as Box;
    const [node] = decoded.items as readonly Node[];
    assert.deepEqual(node.at, new Date(instant), 'the date of the first level');
    assert.deepEqual(node.children![0].at, new Date(instant), 'the date of the nested level');
    assert.ok(node.owner instanceof models.Owner, 'the model of the first level');
    assert.equal((decodeGeneratedModelTrusted(models.Box as never, { items: 'text' }) as Box).items, 'text');
  });
}
