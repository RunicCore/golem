import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

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

function companion(t: TestContext, sources: Record<string, string>): string {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-anonymous-codecs-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, sources);
  const result = generate({ root, profile: { validation: true } });
  const file = result.artifacts.find(artifact => artifact.path.endsWith('contracts.model.generated.ts'));
  assert.ok(file);
  return file.content;
}

test('an unnamed object type with its own constraint is checked by a codec that its module does not export', async t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-anonymous-built-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'contracts.model.ts': contracts('billingAddress') });
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const companionModule = await import(path.join(root, 'build/contracts.model.generated.js')) as Record<string, unknown> & { fromWireFormatTContracts(wire: unknown): unknown };
  assert.deepEqual(Object.entries(companionModule).filter(([name, value]) => name.includes('Anonymous_') && !name.startsWith('__golemStripPlan_') && typeof value === 'function').map(([name]) => name), []);
  assert.doesNotThrow(() => companionModule.fromWireFormatTContracts({ billing: { card: '1', billingAddress: 'a' } }));
  assert.throws(() => companionModule.fromWireFormatTContracts({ billing: { card: '1' } }), error => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('an unrelated unnamed type elsewhere in the job does not change a codec id', t => {
  const alone = companion(t, { 'contracts.model.ts': contracts('billingAddress') });
  const withOther = companion(t, { 'contracts.model.ts': contracts('billingAddress'), 'other.model.ts': other });
  const id = (content: string) => content.match(/"(Anonymous_[0-9a-f]{8})"/)?.[1];
  assert.equal(id(withOther), id(alone));
});

test('unnamed object types with different shapes in one project generate with distinct ids', t => {
  // Per-file counter ids used to name both `__anon_1`, and generation threw a schema identity conflict.
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-anonymous-shapes-', name: null, linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, { 'contracts.model.ts': contracts('billingAddress'), 'other.model.ts': other });
  const result = generate({ root, profile: { validation: true } });
  const idIn = (name: string) => result.artifacts.find(artifact => artifact.path.endsWith(name))?.content.match(/"(Anonymous_[0-9a-f]{8})"/)?.[1];
  assert.ok(idIn('contracts.model.generated.ts'));
  assert.ok(idIn('other.model.generated.ts'));
  assert.notEqual(idIn('contracts.model.generated.ts'), idIn('other.model.generated.ts'));
});
