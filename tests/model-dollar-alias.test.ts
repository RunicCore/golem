import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError } from '@exprtlabs/golem/errors';

import { buildModelProject, generatedModelFiles, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

test('a model alias named with a leading $ generates when another model file imports it', async (t) => {
  // protects: bug T-647 Unresolved schema reference for a $-named alias imported from another file
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-dollar-alias-', name: 'dollar-alias', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'd.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
export type $d = IModel<{ id: string }>;
export type $D = IModel<{ at: Date }>;
export type $d1 = IModel<{ n: number }>;
`,
    'a.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TABaseModel } from './a.model.generated.js';
import type { $d, $D, $d1 } from './d.model.js';
export type TA = IModel<{ d: $d; big: $D; one: $d1 }>;
export class A extends TABaseModel {}
`,
  });
  writeModelGolemYaml(root, { validation: true });
  const result = await buildModelProject(root);
  assert.equal(result.code, 0, result.stderr);
  const generated = await import(pathToFileURL(path.join(root, 'build', 'a.model.generated.js')).href);
  const parsed = generated.parseTA('{"d":{"id":"x"},"big":{"at":"2020-01-01T00:00:00.000Z"},"one":{"n":1}}');
  assert.equal(parsed.d.id, 'x');
  assert.equal(parsed.big.at.toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal(parsed.one.n, 1);
  assert.throws(() => generated.parseTA('{"d":{"id":5},"big":{"at":"2020-01-01T00:00:00.000Z"},"one":{"n":1}}'), LibError);
});

test('an IObject alias named with a leading $ generates when another model file imports it', async (t) => {
  // protects: bug T-647 Generated sibling codec is missing for a $-named IObject imported from another file
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-dollar-object-', name: 'dollar-object', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'd.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
export type $o = IObject<{ id: string }>;
`,
    'a.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TABaseModel } from './a.model.generated.js';
import type { $o } from './d.model.js';
export type TA = IModel<{ o: $o }>;
export class A extends TABaseModel {}
`,
  });
  writeModelGolemYaml(root, { validation: true });
  const result = await buildModelProject(root);
  assert.equal(result.code, 0, result.stderr);
  const generated = await import(pathToFileURL(path.join(root, 'build', 'a.model.generated.js')).href);
  assert.equal(generated.parseTA('{"o":{"id":"x"}}').o.id, 'x');
  assert.throws(() => generated.parseTA('{"o":{"id":5}}'), LibError);
});

test('two model files that import each other build when the model names start with $', async (t) => {
  // protects: bug T-647 a $-named model in an import cycle finds its codec
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-dollar-cycle-', name: 'dollar-cycle', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'customer.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Order } from './order.js';
export type $Customer = IModel<{ name: string; orders: Order[] }>;
`,
    'customer.ts': `import { $CustomerBaseModel } from './customer.model.generated.js';
export class Customer extends $CustomerBaseModel {}
`,
    'order.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Customer } from './customer.js';
export type $Order = IModel<{ id: string; customer: Customer }>;
`,
    'order.ts': `import { $OrderBaseModel } from './order.model.generated.js';
export class Order extends $OrderBaseModel {}
`,
  });
  writeModelGolemYaml(root, { validation: true });
  const result = await buildModelProject(root);
  assert.equal(result.code, 0, result.stderr);
  // A model of the other file in the cycle is reached by its codec id, as the file cannot import its class.
  const files = generatedModelFiles(root);
  const customer = files.find(file => file.path.endsWith('customer.model.generated.ts'))?.content ?? '';
  const order = files.find(file => file.path.endsWith('order.model.generated.ts'))?.content ?? '';
  assert.match(customer, /instanceof requireIModelClass\("_Order_[0-9a-f]{8}"\)/);
  assert.match(order, /instanceof requireIModelClass\("_Customer_[0-9a-f]{8}"\)/);
});
