import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { command } from './support/process.js';
import { companionModelProject, modelProject } from './support/model-companion-project.js';
import {
  buildModelProject,
  generatedModelFiles,
  writeModelGolemYaml,
  writeModelSources,
} from './model-project.js';
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { companionModelSource } from './fixture-templates/models/model-companions.js';

test('model companions compile with --noUnusedLocals for empty, scalar and nested models', async t => {
  const { root, sourceRoot } = modelProject(t);
  const modelNames = ['Empty', 'Scalar', 'Nested'] as const;
  for (const mobx of [false, true]) for (const validation of [false, true]) {
    const profile = { mobx, validation };
    for (const name of modelNames) {
      const stem = name.toLowerCase();
      writeModelSources(sourceRoot, { [`${stem}.model.ts`]: companionModelSource({ name, mobx }) });
    }
    writeModelGolemYaml(root, profile);
    await buildModelProject(root, ['--noUnusedLocals', '--noUnusedParameters']);
    for (const artifact of generatedModelFiles(root)) {
      const modelName = modelNames.find(name => path.basename(artifact.path) === `${name.toLowerCase()}.model.generated.ts`);
      if (!modelName) {
        const base = path.basename(artifact.path);
        assert.ok(base === 'models.validators.generated.ts' || base === 'codec-keys.json', base);
        continue;
      }
      assert.match(artifact.content, new RegExp(`function fillT${modelName}\\(`), `${modelName}: shared fill`);
    }
    // Execution does not depend on the profile, so the verifier runs once.
    if (mobx && validation) {
      const verifier = copyFixtureFile(root, 'models/model-companions/verify-empty-scalar-nested.mjs', 'verify.mjs');
      await command(root, process.execPath, [verifier]);
    }
  }
});

test('golem build rewrites nested model serde calls and preserves class construction in CRLF source', async t => {
  const { root, sourceRoot } = companionModelProject(t, 'model-serde-edit');
  const source = readFixture('models/model-companions/serde-edit.model.ts').replaceAll('\n', '\r\n');
  const sourceFile = path.join(sourceRoot, 'item.model.ts');
  fs.writeFileSync(sourceFile, source);

  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);

  const emitted = fs.readFileSync(path.join(root, 'build/item.model.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("TItem_[0-9a-f]{8}"\)\.parse\(/);
  assert.match(emitted, /requireObjectCodec\("TItem_[0-9a-f]{8}"\)\.fromWireFormat\(/);
  assert.match(emitted, /construct: Item/);
  const firstEmit = emitted;
  await buildModelProject(root);
  assert.equal(fs.readFileSync(path.join(root, 'build/item.model.js'), 'utf8'), firstEmit);

  const loaded = await import(pathToFileURL(path.join(root, 'build/item.model.js')).href) as {
    readonly Item: new (values?: object) => object;
  };
  const item = new loaded.Item();
  const parsed = (item as { parseItem(text: string): object }).parseItem('{"title":"nested","value":7}');
  assert.ok(parsed instanceof loaded.Item);
  const wired = (item as { fromWireItem(value: unknown): object }).fromWireItem({ title: 'wire', value: 8 });
  assert.deepEqual({ ...wired }, { title: 'wire', value: 8 });
  assert.ok(wired instanceof loaded.Item);
});

test('a field typed with an app class from its own file builds, parses and writes that class, and a second build writes the same files', async t => {
  // protects: T-205 a model field typed with a class that extends a generated base generates
  const { root, sourceRoot } = companionModelProject(t, 'model-class-field');
  const imodel = "import type { IModel } from '@exprtlabs/golem/model';\n";
  writeModelSources(sourceRoot, {
    'customer.model.ts': `${imodel}export type TCustomer = IModel<{ name: string }>;\n`,
    'customer.ts': "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n",
    'order.model.ts': `${imodel}import type { Customer } from './customer.js';\nexport type TOrder = IModel<{ id: string; customer: Customer }>;\n`,
    'use.ts': "import { parse, stringify } from '@exprtlabs/golem/serde';\nimport type { TOrder } from './order.model.js';\nexport { Customer } from './customer.js';\nexport const order = parse<TOrder>('{\"id\":\"o1\",\"customer\":{\"name\":\"Ada\"}}');\nexport const text = stringify<TOrder>(order);\n",
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const firstFiles = generatedModelFiles(root);
  const loaded = await import(pathToFileURL(path.join(root, 'build/use.js')).href) as { Customer: new () => object; order: { customer: object }; text: string };
  assert.ok(loaded.order.customer instanceof loaded.Customer);
  assert.equal(loaded.text, '{"id":"o1","customer":{"name":"Ada"}}');
  await buildModelProject(root);
  assert.deepEqual(generatedModelFiles(root), firstFiles);
});

test('a class field that a projection reaches builds: a model that picks it from another model parses that class', async t => {
  // protects: T-205 final review: a class field reached only through a projection (Pick of a model) generates
  const { root, sourceRoot } = companionModelProject(t, 'model-class-projection');
  const imodel = "import type { IModel, IObject } from '@exprtlabs/golem/model';\n";
  writeModelSources(sourceRoot, {
    'customer.model.ts': `${imodel}export type TCustomer = IModel<{ name: string }>;\n`,
    'customer.ts': "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n",
    'order.model.ts': `${imodel}import type { Customer } from './customer.js';\nexport type TOrder = IModel<{ id: string; customer: Customer }>;\n`,
    'invoice.model.ts': `${imodel}import type { TOrder } from './order.model.js';\nexport type TInvoice = IObject<{ order: Pick<TOrder, 'customer'> }>;\n`,
    'use.ts': "import { parse } from '@exprtlabs/golem/serde';\nimport type { TInvoice } from './invoice.model.js';\nexport { Customer } from './customer.js';\nexport const invoice = parse<TInvoice>('{\"order\":{\"customer\":{\"name\":\"Ada\"}}}');\n",
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const loaded = await import(pathToFileURL(path.join(root, 'build/use.js')).href) as { Customer: new () => object; invoice: { order: { customer: object } } };
  assert.ok(loaded.invoice.order.customer instanceof loaded.Customer);
});

test('two models that name each other through their app classes build, and each parse gives the class of the other', async t => {
  // protects: T-205 final review: two models that reach each other through app classes are siblings of each other and still generate
  const { root, sourceRoot } = companionModelProject(t, 'model-class-cycle');
  const imodel = "import type { IModel } from '@exprtlabs/golem/model';\n";
  writeModelSources(sourceRoot, {
    'customer.model.ts': `${imodel}import type { Order } from './order.js';\nexport type TCustomer = IModel<{ name: string; orders: Order[] }>;\n`,
    'customer.ts': "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n",
    'order.model.ts': `${imodel}import type { Customer } from './customer.js';\nexport type TOrder = IModel<{ id: string; customer: Customer }>;\n`,
    'order.ts': "import { TOrderBaseModel } from './order.model.generated.js';\nexport class Order extends TOrderBaseModel {}\n",
    'use.ts': "import { parse } from '@exprtlabs/golem/serde';\nimport type { TCustomer } from './customer.model.js';\nimport type { TOrder } from './order.model.js';\nexport { Customer } from './customer.js';\nexport { Order } from './order.js';\nexport const customer = parse<TCustomer>('{\"name\":\"Ada\",\"orders\":[{\"id\":\"o1\",\"customer\":{\"name\":\"Ada\",\"orders\":[]}}]}');\nexport const order = parse<TOrder>('{\"id\":\"o1\",\"customer\":{\"name\":\"Ada\",\"orders\":[]}}');\n",
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const loaded = await import(pathToFileURL(path.join(root, 'build/use.js')).href) as { Customer: new () => object; Order: new () => object; customer: { orders: object[] }; order: { customer: object } };
  assert.ok(loaded.customer.orders[0] instanceof loaded.Order);
  assert.ok(loaded.order.customer instanceof loaded.Customer);
});

test('a field typed with a projection of an app class builds on the first run, keeps an optional picked member optional, and a second build writes the same files', async t => {
  // protects: T-211 a projection of an app class (Pick<Customer, 'name'>) in a model field generates on the first run
  const { root, sourceRoot } = companionModelProject(t, 'model-class-pick');
  const imodel = "import type { IModel } from '@exprtlabs/golem/model';\n";
  writeModelSources(sourceRoot, {
    'customer.model.ts': `${imodel}export type TCustomer = IModel<{ name: string; age?: number }>;\n`,
    'customer.ts': "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n",
    'order.model.ts': `${imodel}import type { Customer } from './customer.js';\nexport type TOrder = IModel<{ id: string; summary: Pick<Customer, 'name' | 'age'> }>;\n`,
    'use.ts': "import { parse, stringify } from '@exprtlabs/golem/serde';\nimport type { TOrder } from './order.model.js';\nexport { Customer } from './customer.js';\nexport const order = parse<TOrder>('{\"id\":\"o1\",\"summary\":{\"name\":\"Ada\"}}');\nexport const text = stringify<TOrder>(order);\n",
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const firstFiles = generatedModelFiles(root);
  const loaded = await import(pathToFileURL(path.join(root, 'build/use.js')).href) as { order: { id: string; summary: { name: string } }; text: string };
  assert.deepEqual({ ...loaded.order.summary }, { name: 'Ada' });
  assert.equal(loaded.text, '{"id":"o1","summary":{"name":"Ada"}}');
  await buildModelProject(root);
  assert.deepEqual(generatedModelFiles(root), firstFiles);
});

for (const row of [
  { projection: 'Partial<Customer>', fields: '{ name?: string | undefined; age?: number | undefined }', json: '{"name":"Ada"}' },
  { projection: "Omit<Customer, 'age'>", fields: '{ name: string }', json: '{"name":"Ada"}' },
  { projection: 'Required<Customer>', fields: '{ name: string; age: number }', json: '{"name":"Ada","age":36}' },
  { projection: 'Readonly<Customer>', fields: '{ readonly name: string; readonly age: number }', json: '{"name":"Ada","age":36}' },
  { projection: "{ [K in 'name']: Customer[K] }", fields: '{ name: string }', json: '{"name":"Ada"}' },
] as const) {
  test(`${row.projection} of an app class builds on the first run with the model fields and no brand key, and a second build writes the same files`, async t => {
    // protects: T-211 every projection of an app class gives the fields of its model on the first and the second run, never a generated brand key
    const { root, sourceRoot } = companionModelProject(t, 'model-class-utility');
    const imodel = "import type { IModel } from '@exprtlabs/golem/model';\n";
    writeModelSources(sourceRoot, {
      'customer.model.ts': `${imodel}export type TCustomer = IModel<{ name: string; age: number }>;\n`,
      'customer.ts': "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n",
      'order.model.ts': `${imodel}import type { Customer } from './customer.js';\nexport type TOrder = IModel<{ id: string; summary: ${row.projection} }>;\n`,
      'use.ts': `import { parse, stringify } from '@exprtlabs/golem/serde';\nimport type { TOrder } from './order.model.js';\nexport { Customer } from './customer.js';\nexport const order = parse<TOrder>('{"id":"o1","summary":${row.json}}');\nexport const text = stringify<TOrder>(order);\n`,
    });
    writeModelGolemYaml(root, { mobx: false, validation: true });
    await buildModelProject(root);
    const firstFiles = generatedModelFiles(root);
    const companion = firstFiles.find(file => file.path.endsWith('order.model.generated.ts'))?.content ?? '';
    assert.equal(companion.match(/type TOrderSummaryFields = (.*);$/m)?.[1], row.fields);
    assert.doesNotMatch(companion, /Brand@/);
    const loaded = await import(pathToFileURL(path.join(root, 'build/use.js')).href) as { text: string };
    assert.equal(loaded.text, `{"id":"o1","summary":${row.json}}`);
    await buildModelProject(root);
    assert.deepEqual(generatedModelFiles(root), firstFiles);
  });
}

for (const row of [
  { label: 'a utility that the user wrote', before: 'type MyPartial<T> = { [K in keyof T]?: T[K] };\n', projection: 'MyPartial<Customer>' },
  { label: 'an inline mapped type over keyof', before: '', projection: '{ [K in keyof Customer]: Customer[K] }' },
] as const) {
  test(`a field typed by ${row.label} over an app class stops the build with a diagnostic, not a field with no members`, async t => {
    // protects: T-211 a mapped type over keyof of an app class gives RUNM1058, not an empty field type
    const { root, sourceRoot } = companionModelProject(t, 'model-class-keyof');
    const imodel = "import type { IModel } from '@exprtlabs/golem/model';\n";
    writeModelSources(sourceRoot, {
      'customer.model.ts': `${imodel}export type TCustomer = IModel<{ name: string; age: number }>;\n`,
      'customer.ts': "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n",
      'order.model.ts': `${imodel}import type { Customer } from './customer.js';\n${row.before}export type TOrder = IModel<{ id: string; summary: ${row.projection} }>;\n`,
    });
    writeModelGolemYaml(root, { mobx: false, validation: true });
    await assert.rejects(buildModelProject(root), /RUNM1058: Field "summary" of TOrder maps over Customer, and golem finds no members in it\. Use Pick, Omit, Partial, Required or Readonly, or name the keys in the mapped type\./);
  });
}
