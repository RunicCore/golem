import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { generate } from '#model/generator';
import { createModelProject, writeModelSources } from './model-project.js';

// `billing` is an unnamed object type with its own constraint, so it gets its own codec.
const contracts = (property: string) => `import type { IModel } from '@exprtlabs/golem/model';
import type { DependentRequired } from '@exprtlabs/golem/tags';
import { TContractsBaseModel } from './contracts.model.generated.js';

type BillingDetails = { card?: string; ${property}?: string } & DependentRequired<{ card: ['${property}'] }>;

export type TContracts = IModel<{ billing: BillingDetails }>;
export class Contracts extends TContractsBaseModel {}
`;

const other = `import type { IModel } from '@exprtlabs/golem/model';
import type { DependentRequired } from '@exprtlabs/golem/tags';
import { TOtherBaseModel } from './other.model.generated.js';

export type TOther = IModel<{ extra: { a?: string; b?: string } & DependentRequired<{ a: ['b'] }> }>;
export class Other extends TOtherBaseModel {}
`;

function companion(t: TestContext, sources: Record<string, string>, ajvStandalone: boolean): string {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-anonymous-codecs-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, sources);
  const result = generate({ root, profile: { mobx: false, validation: true, ajvStandalone } });
  const file = result.artifacts.find(artifact => artifact.path.endsWith('contracts.model.generated.ts'));
  assert.ok(file);
  return file.content;
}

test('an unnamed object type gets a shape-based codec id and module-private codec functions', t => {
  const content = companion(t, { 'contracts.model.ts': contracts('billingAddress') }, false);
  const ids = [...new Set(content.match(/"Anonymous_[0-9a-f]{8}"/g) ?? [])];
  assert.equal(ids.length, 1, 'one anonymous codec id');
  assert.doesNotMatch(content, /__anon/);
  assert.doesNotMatch(content, /^export function \w*Anonymous_/m);
  assert.match(content, /^function stringifyAnonymous_[0-9a-f]{8}\(/m);
});

test('an unrelated unnamed type elsewhere in the job does not change a codec id', t => {
  const alone = companion(t, { 'contracts.model.ts': contracts('billingAddress') }, false);
  const withOther = companion(t, { 'contracts.model.ts': contracts('billingAddress'), 'other.model.ts': other }, false);
  const id = (content: string) => content.match(/"(Anonymous_[0-9a-f]{8})"/)?.[1];
  assert.equal(id(withOther), id(alone));
});

test('unnamed object types with different shapes in one standalone project generate with distinct ids', t => {
  // Per-file counter ids used to name both `__anon_1`, and standalone generation threw a schema identity conflict.
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-anonymous-standalone-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'contracts.model.ts': contracts('billingAddress'), 'other.model.ts': other });
  const result = generate({ root, profile: { mobx: false, validation: true, ajvStandalone: true } });
  const idIn = (name: string) => result.artifacts.find(artifact => artifact.path.endsWith(name))?.content.match(/"(Anonymous_[0-9a-f]{8})"/)?.[1];
  assert.ok(idIn('contracts.model.generated.ts'));
  assert.ok(idIn('other.model.generated.ts'));
  assert.notEqual(idIn('contracts.model.generated.ts'), idIn('other.model.generated.ts'));
});
