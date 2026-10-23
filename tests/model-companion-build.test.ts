import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { command, golem } from './support/process.js';
import { companionModelProject, modelProject } from './support/model-companion-project.js';
import {
  buildModelProject,
  createModelProject,
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

const IMODEL = "import type { IModel } from '@exprtlabs/golem/model';\n";
const CUSTOMER_CLASS = "import { TCustomerBaseModel } from './customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n";

/** A project of `TCustomer`, its class `Customer`, and `TOrder` whose `summary` is `projection`; `use.js` tells whether the built `TOrder` accepts a summary. */
function orderProject(t: TestContext, options: { readonly projection: string; readonly before?: string; readonly customer?: string; readonly customerFile?: string; readonly customerClasses?: string; readonly imports?: string }) {
  const project = companionModelProject(t, 'model-class-utility');
  const { projection, before = '', customer = '{ name: string; age: number }', customerFile = '', customerClasses = '', imports = 'Customer' } = options;
  writeModelSources(project.sourceRoot, {
    'customer.model.ts': `${IMODEL}${customerFile}export type TCustomer = IModel<${customer}>;\n`,
    'customer.ts': CUSTOMER_CLASS + customerClasses,
    'order.model.ts': `${IMODEL}import type { ${imports} } from './customer.js';\n${before}export type TOrder = IModel<{ id: string; summary: ${projection} }>;\n`,
    'use.ts': "import { parse } from '@exprtlabs/golem/serde';\nimport type { TOrder } from './order.model.js';\nexport { Customer } from './customer.js';\nexport const accepts = (summary: string): boolean => { try { parse<TOrder>(`{\"id\":\"o1\",\"summary\":${summary}}`); return true; } catch { return false; } };\n",
  });
  writeModelGolemYaml(project.root, { mobx: false, validation: true });
  return project;
}

/** The summaries the built `TOrder` of `root` accepts, among `candidates`. */
async function acceptedSummaries(root: string, candidates: readonly string[], build: number): Promise<readonly string[]> {
  const loaded = await import(`${pathToFileURL(path.join(root, 'build/use.js')).href}?build=${build}`) as { accepts(summary: string): boolean };
  return candidates.filter(candidate => loaded.accepts(candidate));
}

/** Generates again from the same sources, as a second run over the first run's companions does. */
async function buildAgain(root: string): Promise<void> {
  fs.rmSync(path.join(root, '.golem/jobs.json'));
  await buildModelProject(root);
}

for (const row of [
  { label: 'a utility that the user wrote', before: 'type MyPartial<T> = { [K in keyof T]?: T[K] };\n', projection: 'MyPartial<Customer>', accepted: ['{}', '{"name":"Ada"}', '{"name":"Ada","age":36}'], rejected: ['{"name":5}', '{"city":"Oslo"}'] },
  { label: 'an inline mapped type over keyof', before: '', projection: '{ [K in keyof Customer]: Customer[K] }', accepted: ['{"name":"Ada","age":36}'], rejected: ['{"name":"Ada"}', '{"name":5,"age":36}'] },
  { label: 'Partial of a Pick', before: '', projection: "Partial<Pick<Customer, 'age'>>", accepted: ['{}', '{"age":36}'], rejected: ['{"age":"x"}', '{"name":"Ada"}'] },
  { label: 'a Pick joined with another type', before: '', projection: "Pick<Customer, 'name'> & { x: string }", accepted: ['{"name":"Ada","x":"y"}'], rejected: ['{"name":"Ada"}', '{"name":5,"x":"y"}'] },
  { label: 'an indexed access of a member', before: '', projection: "Customer['name']", accepted: ['"Ada"'], rejected: ['5'] },
  { label: 'a Record over keyof', before: '', projection: 'Record<keyof Customer, number>', accepted: ['{"name":1,"age":2}'], rejected: ['{"name":"Ada","age":2}', '{"name":1}'] },
] as const) {
  test(`a field typed by ${row.label} over an app class generates on the first run, and a second run writes the same files`, async t => {
    // protects: T-264 every utility type over an app class resolves its base fields on the first golem-model run
    const { root } = orderProject(t, row);
    await buildModelProject(root);
    const firstFiles = generatedModelFiles(root);
    const candidates = [...row.accepted, ...row.rejected];
    assert.deepEqual(await acceptedSummaries(root, candidates, 1), row.accepted);
    await buildAgain(root);
    assert.deepEqual(generatedModelFiles(root), firstFiles);
  });
}

test('a keyof over a subclass of an app class has the members of its base on the first run', async t => {
  // protects: T-264 a subclass of an app class sees the fields of its generated base on the first run
  const { root } = orderProject(t, {
    projection: '{ [K in keyof VipCustomer]: VipCustomer[K] }',
    customerClasses: 'export class VipCustomer extends Customer { tier = 1; }\n',
    imports: 'VipCustomer',
  });
  await buildModelProject(root);
  assert.deepEqual(await acceptedSummaries(root, ['{"name":"Ada","age":36,"tier":2}', '{"tier":2}', '{"name":"Ada","age":36}'], 1), ['{"name":"Ada","age":36,"tier":2}']);
});

test('a model that holds its own class has the members of its base under a keyof on the first run', async t => {
  // protects: T-264 a self-referencing model with a keyof field resolves on the first run
  const { root } = orderProject(t, {
    projection: '{ [K in keyof Customer]: Customer[K] }',
    customerFile: "import type { Customer } from './customer.js';\n",
    customer: '{ name: string; age: number; friend?: Customer }',
  });
  await buildModelProject(root);
  assert.deepEqual(
    await acceptedSummaries(root, ['{"name":"Ada","age":36,"friend":{"name":"Bo","age":7}}', '{"name":"Ada","age":36}', '{"name":"Ada","age":36,"friend":{"name":1,"age":7}}'], 1),
    ['{"name":"Ada","age":36,"friend":{"name":"Bo","age":7}}', '{"name":"Ada","age":36}'],
  );
});

test('a model defined by a keyof of its own class stops the build with a diagnostic, not a model with no fields', async t => {
  // protects: T-264 a root model over its own class has no members and says so (RUNM1058)
  const { root, sourceRoot } = companionModelProject(t, 'model-class-own-keyof');
  writeModelSources(sourceRoot, {
    'customer.model.ts': `${IMODEL}import type { Customer } from './customer.js';\nexport type TCustomer = IModel<{ [K in keyof Customer]: Customer[K] }>;\n`,
    'customer.ts': CUSTOMER_CLASS,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await assert.rejects(buildModelProject(root), /RUNM1058: .*TCustomer maps over its own class Customer/);
});

test('a tagged field picked from an app class keeps its tag on the first run and on every later run', async t => {
  // protects: T-264 a Pick of a tagged field gave the same validator on run 1 and lost the tag on run 2 (F-51)
  const { root } = orderProject(t, {
    projection: "Pick<Customer, 'name'>",
    customer: '{ name: string & MinLength<3>; age: number }',
    customerFile: "import type { MinLength } from '@exprtlabs/golem/tags';\n",
  });
  await buildModelProject(root);
  const firstFiles = generatedModelFiles(root);
  assert.deepEqual(await acceptedSummaries(root, ['{"name":"Ada"}', '{"name":"Al"}'], 1), ['{"name":"Ada"}']);
  await buildAgain(root);
  assert.deepEqual(generatedModelFiles(root), firstFiles);
  assert.deepEqual(await acceptedSummaries(root, ['{"name":"Ada"}', '{"name":"Al"}'], 2), ['{"name":"Ada"}']);
});

test('a build over the stale generated base of a changed model writes the files of a fresh build', async t => {
  // protects: T-264 a stale base on disk gave a silent fault in a projection of its class
  const changed = { projection: 'Partial<Customer>', customer: '{ name: string; city: string }' } as const;
  const stale = orderProject(t, { projection: changed.projection });
  await buildModelProject(stale.root);
  fs.writeFileSync(path.join(stale.sourceRoot, 'customer.model.ts'), `${IMODEL}export type TCustomer = IModel<${changed.customer}>;\n`);
  await buildModelProject(stale.root);
  const fresh = orderProject(t, changed);
  await buildModelProject(fresh.root);
  const contents = (root: string): readonly string[] => generatedModelFiles(root).map(file => `${path.relative(root, file.path)}\n${file.content}`);
  assert.deepEqual(contents(stale.root), contents(fresh.root));
  assert.deepEqual(await acceptedSummaries(stale.root, ['{"city":"Oslo"}', '{"age":36}'], 1), ['{"city":"Oslo"}']);
});

test('one generate after a model change gives the controllers job the new fields of a projection of its class', async t => {
  // protects: T-264 the controllers job read the stale base on disk, so its OpenAPI lagged one run behind a model change
  const root = createModelProject(t, { prefix: 'golem-controller-stale-', name: 'controller-stale', linkWorkspaceNodeModules: true, compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }).root;
  const model = (type: string): string => `${IMODEL}export type TCustomer = IModel<{ name: ${type}; age: number }>;\n`;
  writeModelSources(path.join(root, 'src'), {
    'customer.model.ts': model('string'),
    'customer.ts': CUSTOMER_CLASS,
    'api.controller.ts': "import { Controller, Get } from '@nestjs/common';\nimport type { Customer } from './customer.js';\n@Controller('customers')\nexport class CustomersController {\n  @Get() list(): Pick<Customer, 'name'> { return {} as never; }\n}\n",
  });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    output: ./api/openapi.json\n    info: { title: Stale, version: "1" }\nmodels:\n  root: .\n');
  const nameType = (): string | undefined => JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'api/openapi.json'), 'utf8'))).match(/"name":\{"type":"(\w+)"/)?.[1];
  await command(root, process.execPath, [golem, 'generate', '--config', config]);
  assert.equal(nameType(), 'string');
  fs.writeFileSync(path.join(root, 'src/customer.model.ts'), model('number'));
  await command(root, process.execPath, [golem, 'generate', '--config', config]);
  assert.equal(nameType(), 'number');
});

test('stringify writes an undefined array item as null and rejects a hole', async t => {
  // protects: T-183 an undefined array item reads as null in every array keyword; a hole is rejected
  const { root, sourceRoot } = companionModelProject(t, 'model-array-undefined-item');
  writeModelSources(sourceRoot, {
    'list.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TList = IModel<{ names: (string | null)[] }>;\nexport type TAny = IModel<{ values: unknown[] }, { allowAny: true }>;\n",
    'use.ts': `import { stringify } from '@exprtlabs/golem/serde';
import type { TAny, TList } from './list.model.js';
const run = (write: () => string): string => { try { return write(); } catch (error) { return error instanceof Error ? error.message : String(error); } };
export const undefinedItem = stringify<TList>({ names: ['x', undefined] } as never);
export const hole = run(() => stringify<TList>({ names: ['x', , ] } as never));
export const anyHole = run(() => stringify<TAny>({ values: ['x', , ] } as never));
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const loaded = await import(pathToFileURL(path.join(root, 'build/use.js')).href) as { undefinedItem: string; hole: string; anyHole: string };
  assert.deepEqual({ ...loaded }, { undefinedItem: '{"names":["x",null]}', hole: 'Model validation failed.', anyHole: 'Model validation failed.' });
});
