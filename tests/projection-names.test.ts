import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pascalIdentifier, policySuffix } from '#codegen/type-analysis/projection-names';
import { generate } from '#controllers/generator';
import { createControllerFixture } from './fixture-templates/controllers/project.js';

test('policy suffix names only non-default settings, in a fixed order', () => {
  assert.equal(policySuffix({ exact: true, allowAny: false, representation: 'model' }), '');
  assert.equal(policySuffix({ exact: false, allowAny: false, representation: 'model' }), 'Loose');
  assert.equal(policySuffix({ exact: false, allowAny: true, representation: 'wire' }), 'LooseAnyWire');
});

test('keys become identifier parts, and keys without ASCII letters or digits give no part', () => {
  assert.equal(pascalIdentifier('id'), 'Id');
  assert.equal(pascalIdentifier('first-name'), 'FirstName');
  assert.equal(pascalIdentifier('created_at'), 'CreatedAt');
  assert.equal(pascalIdentifier('0'), '0');
  assert.equal(pascalIdentifier('ünicode'), undefined);
  assert.equal(pascalIdentifier('--'), undefined);
});

const MODELS = `import type { IModel } from '@exprtlabs/codegen/model';
export type TMerchant = IModel<{ id: string; name: string; city: string; 'first-name': string }>;
export type TMoney = IModel<{ amount: string; currency: string }>;
export type TBilling = Omit<TMerchant, 'id'>;
`;

function controller(fields: string, extraRoute = ''): string {
  return `import { Body, Controller, Post } from '@nestjs/common';
${MODELS}
export type TOrder = IModel<{ ${fields} }>;
@Controller('orders')
export class OrderController {
  @Post() save(@Body() body: TOrder): TOrder { return body; }
  ${extraRoute}
}
`;
}

async function componentNames(t: TestContext, source: string): Promise<string[]> {
  const root = createControllerFixture(t, {
    prefix: 'runic-projection-names-', packageName: 'projection-names-fixture',
    sourceFile: 'src/order.controller.ts', source,
  });
  const result = await generate({
    root, output: path.join(root, 'api.json'), openapiVersion: '3.2.0',
    info: { title: 'Projection names', version: '1' }, profile: { mobx: false, validation: false },
  });
  const document = JSON.parse(result.artifacts[0]!.content) as { components: { schemas: Record<string, unknown> } };
  return Object.keys(document.components.schemas).sort();
}

const cases: readonly [field: string, expected: string][] = [
  ["Omit<TMerchant, 'id'>", 'MerchantOmitId'],
  ["Pick<TMerchant, 'name' | 'id'>", 'MerchantPickIdName'],
  ["Partial<Omit<TMerchant, 'id'>>", 'MerchantOmitIdPartial'],
  ['TMerchant & TMoney', 'MerchantAndMoney'],
  ["Omit<TMerchant, 'first-name'>", 'MerchantOmitFirstName'],
  ['TBilling', 'Billing'],
  ['TMerchant & { note: string }', 'OrderShape'],
  ["Pick<TMerchant, 'id' | 'name' | 'city' | 'first-name'>", 'OrderShape'],
  ["Partial<Readonly<Required<Omit<TMerchant, 'id'>>>>", 'OrderShape'],
];

for (const [field, expected] of cases) {
  test(`a field typed ${field} becomes the component ${expected}`, async t => {
    const names = await componentNames(t, controller(`shape: ${field}`));
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
    assert.equal(names.some(name => name.startsWith('__Projection')), false);
  });
}

test('an optional field and the members of a union are named from their own expressions', async t => {
  const names = await componentNames(t, controller(
    "optional?: Omit<TMerchant, 'id'>; either: Pick<TMoney, 'amount'> | Pick<TMerchant, 'id'>",
  ));
  for (const expected of ['MerchantOmitId', 'MoneyPickAmount', 'MerchantPickId']) {
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  }
});

test('adding an unrelated model and route leaves existing projection names unchanged', async t => {
  const before = await componentNames(t, controller("shape: Omit<TMerchant, 'id'>"));
  const after = await componentNames(t, controller(
    "shape: Omit<TMerchant, 'id'>; extra: Pick<TMoney, 'amount'>",
    "@Post('other') other(@Body() body: Partial<TMoney>): Partial<TMoney> { return body; }",
  ));
  for (const name of before) assert.ok(after.includes(name), `${name} still present`);
});

test('two different shapes that derive the same name fail with RUNM1059', async t => {
  const source = `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/codegen/model';
import type { TMerchant as TOtherMerchant } from './other.model.js';
export type TMerchant = IModel<{ id: string; name: string }>;
export type TOrder = IModel<{ a: Omit<TMerchant, 'id'>; b: Omit<TOtherMerchant, 'id'> }>;
@Controller('orders') export class OrderController { @Post() save(@Body() body: TOrder): TOrder { return body; } }
`;
  const root = createControllerFixture(t, {
    prefix: 'runic-projection-clash-', packageName: 'projection-clash-fixture',
    sourceFile: 'src/order.controller.ts', source,
    files: { 'src/other.model.ts': "import type { IModel } from '@exprtlabs/codegen/model';\nexport type TMerchant = IModel<{ id: string; total: number }>;\n" },
  });
  await assert.rejects(generate({
    root, output: path.join(root, 'api.json'), openapiVersion: '3.2.0',
    info: { title: 'Clash', version: '1' }, profile: { mobx: false, validation: false },
  }), /RUNM1059/);
});
