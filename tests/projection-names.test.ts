import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pascalIdentifier, policySuffix } from '#golem/type-analysis/projection-names';
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

const MODELS = `import type { IModel } from '@exprtlabs/golem/model';
export type TMerchant = IModel<{ id: string; name: string; city: string; 'first-name': string }>;
export type TMoney = IModel<{ amount: string; currency: string }>;
// A shape of its own: the same shape as another field in one document would share that field's schema and name.
export type TBilling = Omit<TMerchant, 'city'>;
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
    prefix: 'golem-projection-names-', packageName: 'projection-names-fixture',
    sourceFile: 'src/order.controller.ts', source,
  });
  const result = await generate({
    root, output: path.join(root, 'api.json'), openapiVersion: '3.2.0',
    info: { title: 'Projection names', version: '1' }, profile: { mobx: false, validation: false },
  });
  const document = JSON.parse(result.artifacts[0]!.content) as { components: { schemas: Record<string, unknown> } };
  return Object.keys(document.components.schemas).sort();
}

// Projections that name themselves from their own expression; the field that holds each one is irrelevant.
const namedProjections: readonly [field: string, expected: string][] = [
  ["Omit<TMerchant, 'id'>", 'TMerchantOmitId'],
  ["Pick<TMerchant, 'name' | 'id'>", 'TMerchantPickIdName'],
  ["Partial<Omit<TMerchant, 'id'>>", 'TMerchantOmitIdPartial'],
  ['TMerchant & TMoney', 'TMerchantAndTMoney'],
  ["Omit<TMerchant, 'first-name'>", 'TMerchantOmitFirstName'],
  ['TBilling', 'TBilling'],
];

// Projections with no name of their own fall back to the owner and the field, so each sits in its own field.
const ownerFieldFallbacks: readonly [field: string, expected: string][] = [
  ['TMerchant & { note: string }', 'TOrderShape1'],
  ["Pick<TMerchant, 'id' | 'name' | 'city' | 'first-name'>", 'TOrderShape2'],
  ["Partial<Readonly<Required<Omit<TMerchant, 'id'>>>>", 'TOrderShape3'],
];

test('projections over a model are named from their own expressions', async t => {
  const fields = namedProjections.map(([field], index) => `named${index + 1}: ${field}`).join('; ');
  const names = await componentNames(t, controller(fields));
  for (const [, expected] of namedProjections) assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  assert.equal(names.some(name => name.startsWith('__Projection')), false);
});

test('projections without a name of their own become the owner and the field', async t => {
  const fields = ownerFieldFallbacks.map(([field], index) => `shape${index + 1}: ${field}`).join('; ');
  const names = await componentNames(t, controller(fields));
  for (const [, expected] of ownerFieldFallbacks) assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  assert.equal(names.some(name => name.startsWith('__Projection')), false);
});

test('an optional field and the members of a union are named from their own expressions', async t => {
  const names = await componentNames(t, controller(
    "optional?: Omit<TMerchant, 'id'>; either: Pick<TMoney, 'amount'> | Pick<TMerchant, 'id'>",
  ));
  for (const expected of ['TMerchantOmitId', 'TMoneyPickAmount', 'TMerchantPickId']) {
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
import type { IModel } from '@exprtlabs/golem/model';
import type { TMerchant as TOtherMerchant } from './other.model.js';
export type TMerchant = IModel<{ id: string; name: string }>;
export type TOrder = IModel<{ a: Omit<TMerchant, 'id'>; b: Omit<TOtherMerchant, 'id'> }>;
@Controller('orders') export class OrderController { @Post() save(@Body() body: TOrder): TOrder { return body; } }
`;
  const root = createControllerFixture(t, {
    prefix: 'golem-projection-clash-', packageName: 'projection-clash-fixture',
    sourceFile: 'src/order.controller.ts', source,
    files: { 'src/other.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TMerchant = IModel<{ id: string; total: number }>;\n" },
  });
  await assert.rejects(generate({
    root, output: path.join(root, 'api.json'), openapiVersion: '3.2.0',
    info: { title: 'Clash', version: '1' }, profile: { mobx: false, validation: false },
  }), /RUNM1059/);
});

const GENERATE_OPTIONS = { openapiVersion: '3.2.0' as const, info: { title: 'Projection names', version: '1' }, profile: { mobx: false, validation: false } };

async function generateSource(t: TestContext, source: string, files: Record<string, string> = {}) {
  const root = createControllerFixture(t, {
    prefix: 'golem-projection-names-', packageName: 'projection-names-fixture',
    sourceFile: 'src/order.controller.ts', source, files,
  });
  return generate({ root, output: path.join(root, 'api.json'), ...GENERATE_OPTIONS });
}

interface Document { components: { schemas: Record<string, { properties?: Record<string, { $ref?: string }> }> } }

async function documentOf(t: TestContext, source: string, files: Record<string, string> = {}): Promise<Document> {
  const result = await generateSource(t, source, files);
  return JSON.parse(result.artifacts[0]!.content) as Document;
}

const PRELUDE = `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';
import type { Pattern } from '@exprtlabs/golem/tags';
`;
const ROUTE = (body: string, result: string): string => `@Controller('orders')
export class OrderController { @Post() save(@Body() body: ${body}): ${result} { return body; } }
`;

test('a projection named like a model fails with RUNM1059 naming both places', async t => {
  const source = `${PRELUDE}
export type TMerchant = IModel<{ id: string; name: string }>;
export type TMerchantOmitId = IModel<{ other: string }>;
export type TOrder = IModel<{ shape: Omit<TMerchant, 'id'> }>;
${ROUTE('TOrder', 'TOrder')}`;
  await assert.rejects(generateSource(t, source), /RUNM1059.*TMerchantOmitId.*order\.controller\.ts:\d+:\d+ and .*order\.controller\.ts:\d+:\d+/);
});

test('one expression used by two owners yields one schema, named the same whichever model is declared first', async t => {
  const order = "export type TOrder = IModel<{ shape: Pick<TMerchant, 'id' | 'name' | 'city' | 'first-name'>; same: Omit<TMerchant, 'id'> }>;";
  const payment = "export type TPayment = IModel<{ shape: Pick<TMerchant, 'id' | 'name' | 'city' | 'first-name'>; same: Omit<TMerchant, 'id'> }>;";
  const route = `@Controller('orders')
export class OrderController { @Post() save(@Body() body: TOrder): TPayment { return body as never; } }
`;
  const build = (first: string, second: string): string => `import { Body, Controller, Post } from '@nestjs/common';\n${MODELS}\n${first}\n${second}\n${route}`;
  const forward = await documentOf(t, build(order, payment));
  const swapped = await documentOf(t, build(payment, order));
  assert.deepEqual(Object.keys(forward.components.schemas).sort(), Object.keys(swapped.components.schemas).sort());
  const names = Object.keys(forward.components.schemas);
  assert.ok(names.includes('TOrderShape'), 'the smallest candidate survives');
  assert.equal(names.includes('TPaymentShape'), false);
  assert.equal(names.filter(name => name === 'TMerchantOmitId').length, 1);
  assert.equal(forward.components.schemas.TOrder?.properties?.same?.$ref, forward.components.schemas.TPayment?.properties?.same?.$ref);
});

test('a projection whose name is shared with a different tagged shape fails instead of merging', async t => {
  const source = `${PRELUDE}
import type { TMerchant as TOtherMerchant } from './other.model.js';
export type TMerchant = IModel<{ id: string; name: string }>;
export type TOrder = IModel<{ a: Omit<TMerchant, 'id'>; b: Omit<TOtherMerchant, 'id'> }>;
${ROUTE('TOrder', 'TOrder')}`;
  await assert.rejects(generateSource(t, source, {
    'src/other.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Pattern } from '@exprtlabs/golem/tags';\nexport type TMerchant = IModel<{ id: string; name: string & Pattern<'^x$'> }>;\n",
  }), /RUNM1059.*used by two different types: .*order\.controller\.ts:\d+:\d+ and .*order\.controller\.ts:\d+:\d+/);
});

test('Record fields with different value types keep separate schemas and never merge tags', async t => {
  const source = `${PRELUDE}
type TCode = string & Pattern<'^[A-Z]+$'>;
export type TOrder = IModel<{ a: Record<string, string>; b: Record<string, TCode>; c: Record<string, number> }>;
${ROUTE('TOrder', 'TOrder')}`;
  const document = await documentOf(t, source);
  const properties = document.components.schemas.TOrder?.properties ?? {};
  assert.deepEqual(Object.keys(document.components.schemas).sort(), ['TOrder', 'TOrderA', 'TOrderB', 'TOrderC']);
  assert.equal(new Set(Object.values(properties).map(property => property.$ref)).size, 3);
});

test('a generic helper alias used twice does not name its projections', async t => {
  const source = `${PRELUDE}
export type TMerchant = IModel<{ id: string; name: string }>;
export type TMoney = IModel<{ id: string; amount: string }>;
type TWithout<T, K extends keyof T> = Omit<T, K>;
export type TOrder = IModel<{ a: TWithout<TMerchant, 'id'>; b: TWithout<TMoney, 'id'> }>;
${ROUTE('TOrder', 'TOrder')}`;
  const names = Object.keys((await documentOf(t, source)).components.schemas).sort();
  assert.deepEqual(names, ['TOrder', 'TOrderA', 'TOrderB']);
});

test('a union of projection arrays names each item from its own expression', async t => {
  const names = await componentNames(t, controller("x: Pick<TMerchant, 'id'>[] | Pick<TMoney, 'amount'>[]"));
  for (const expected of ['TMerchantPickId', 'TMoneyPickAmount']) {
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  }
});

const CONTROLLER_MODELS = `import { Body, Controller, Post, Put } from '@nestjs/common';
${MODELS}
`;
const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function assertReadableNames(names: readonly string[]): void {
  for (const name of names) assert.match(name, COMPONENT_NAME, `${name} is a plain component name`);
}

test('an inline controller body names its derived field after the method and parameter', async t => {
  const source = `${CONTROLLER_MODELS}
@Controller('payments')
export class PaymentController {
  @Post() createPayment(@Body() input: { merchant: TMerchant & { note: string } }): void {}
}
`;
  const names = Object.keys((await documentOf(t, source)).components.schemas);
  assertReadableNames(names);
  assert.ok(names.includes('PaymentCreatePaymentBodyMerchantLoose'), names.join(', '));
});

test('an intersection-root controller body names its derived field readably', async t => {
  const source = `${CONTROLLER_MODELS}
@Controller('payments')
export class PaymentController {
  @Post() createPayment(@Body() input: TMerchant & { extra: TMerchant & { note: string } }): void {}
}
`;
  const names = Object.keys((await documentOf(t, source)).components.schemas);
  assertReadableNames(names);
  assert.ok(names.includes('PaymentCreatePaymentBodyExtraLoose'), names.join(', '));
});

test('two routes with same-named, differently shaped inline fields get distinct names without RUNM1059', async t => {
  const source = `${CONTROLLER_MODELS}
@Controller('payments')
export class PaymentController {
  @Post() createPayment(@Body() input: { merchant: TMerchant & { note: string } }): void {}
  @Put() updatePayment(@Body() input: { merchant: TMerchant & { other: number } }): void {}
}
`;
  const names = Object.keys((await documentOf(t, source)).components.schemas);
  assertReadableNames(names);
  for (const expected of ['PaymentCreatePaymentBodyMerchantLoose', 'PaymentUpdatePaymentBodyMerchantLoose']) {
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  }
});

test('union members that fall back to owner and property are told apart by a literal discriminant', async t => {
  const names = await componentNames(t, controller(
    "either: (TMerchant & { kind: 'card'; a: string }) | (TMoney & { kind: 'bank-transfer'; b: string })",
  ));
  for (const expected of ['TOrderEitherCard', 'TOrderEitherBankTransfer']) {
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  }
});

test('union members without a discriminant are told apart by position', async t => {
  const names = await componentNames(t, controller(
    'either: (TMerchant & { a: string }) | (TMoney & { b: string })',
  ));
  for (const expected of ['TOrderEither1', 'TOrderEither2']) {
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  }
});

type Schemas = Document['components']['schemas'];

function variantShapes(schemas: Schemas, prefix: string): Record<string, string[]> {
  return Object.fromEntries(Object.keys(schemas).filter(name => name.startsWith(prefix)).sort()
    .map(name => [name, Object.keys(schemas[name]?.properties ?? {}).sort()]));
}

const SPLIT_MODELS = {
  'src/b-merchant.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TMerchant = IModel<{ id: string; name: string }>;\n",
  'src/a-money.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TMoney = IModel<{ amount: string }>;\n",
};

function eitherController(union: string): string {
  return `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';
import type { TMerchant } from './b-merchant.js';
import type { TMoney } from './a-money.js';
export type TOrder = IModel<{ either: ${union} }>;
@Controller('orders') export class OrderController { @Post() save(@Body() body: TOrder): TOrder { return body; } }
`;
}

test('union member positions do not change when an unrelated controller file is added', async t => {
  const source = eitherController('(TMerchant & { a: string }) | (TMoney & { b: string })');
  const before = await documentOf(t, source, SPLIT_MODELS);
  const unrelated = `import { Body, Controller, Post } from '@nestjs/common';
import type { TMerchant } from './b-merchant.js';
@Controller('users') export class UserController { @Post() save(@Body() body: TMerchant): TMerchant { return body; } }
`;
  const after = await documentOf(t, source, { ...SPLIT_MODELS, 'src/0-user.controller.ts': unrelated });
  const expected = variantShapes(before.components.schemas, 'TOrderEither');
  assert.deepEqual(Object.keys(expected), ['TOrderEither1', 'TOrderEither2']);
  assert.ok(expected.TOrderEither1?.includes('a'), 'member 1 is the first authored member');
  assert.ok(expected.TOrderEither2?.includes('b'), 'member 2 is the second authored member');
  assert.deepEqual(variantShapes(after.components.schemas, 'TOrderEither'), expected);
});

test('union member positions follow the authored order', async t => {
  const document = await documentOf(t, eitherController('(TMoney & { b: string }) | (TMerchant & { a: string })'), SPLIT_MODELS);
  const shapes = variantShapes(document.components.schemas, 'TOrderEither');
  assert.ok(shapes.TOrderEither1?.includes('b'));
  assert.ok(shapes.TOrderEither2?.includes('a'));

  const aliasedSource = eitherController('TEither | null')
    .replace('export type TOrder', 'type TEither = (TMerchant & { a: string }) | (TMoney & { b: string });\nexport type TOrder');
  const aliased = variantShapes((await documentOf(t, aliasedSource, SPLIT_MODELS)).components.schemas, 'TOrderEither');
  assert.ok(aliased.TOrderEither1?.includes('a'), 'a union written as an alias plus null: member 1 is the first authored member');
  assert.ok(aliased.TOrderEither2?.includes('b'), 'a union written as an alias plus null: member 2 is the second authored member');
});

test('the discriminant is chosen by sorted property name, not by declaration order', async t => {
  const names = await componentNames(t, controller(
    "either: (TMerchant & { type: 'x'; kind: 'card' }) | (TMoney & { kind: 'bank'; type: 'y' })",
  ));
  for (const expected of ['TOrderEitherCard', 'TOrderEitherBank']) assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
});

test('discriminant values that collide after PascalCase fall back to positions', async t => {
  const names = await componentNames(t, controller(
    "either: (TMerchant & { kind: 'bank-transfer' }) | (TMoney & { kind: 'bank_transfer' })",
  ));
  for (const expected of ['TOrderEither1', 'TOrderEither2']) assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
});

test('underscores in model names become part of the derived name instead of dropping it', async t => {
  const source = `import { Body, Controller, Post } from '@nestjs/common';
${MODELS}
export type TShop_Owner = IModel<{ id: string; name: string }>;
export type TOrder_V2 = IModel<{ shape: TMerchant & { x: string }; owner: Omit<TShop_Owner, 'id'> }>;
export type TPay_V2 = IModel<{ shape: TMerchant & { y: string } }>;
@Controller('orders')
export class OrderController { @Post() save(@Body() body: TOrder_V2): TPay_V2 { return body as never; } }
`;
  const names = await componentNames(t, source);
  for (const expected of ['TOrderV2Shape', 'TPayV2Shape', 'TShopOwnerOmitId']) assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
});

test('the same method name on two controllers keeps distinct names', async t => {
  const source = `${CONTROLLER_MODELS}
@Controller('payments')
export class PaymentsController { @Post() create(@Body() input: { merchant: TMerchant & { x: string } }): void {} }
@Controller('refunds')
export class RefundsController { @Post() create(@Body() input: { merchant: TMerchant & { y: string } }): void {} }
`;
  const names = Object.keys((await documentOf(t, source)).components.schemas);
  for (const expected of ['PaymentsCreateBodyMerchantLoose', 'RefundsCreateBodyMerchantLoose']) assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
});

test('models named alike in dir/a.ts and dir/a.model.ts get two component names', async t => {
  // protects: bug sweep 3 both files gave the stem "a", so two different schemas shared the component dir.a.TName
  const source = `${PRELUDE}
import type { TName as TFirst } from './dir/a.js';
import type { TName as TSecond } from './dir/a.model.js';
export type TOrder = IModel<{ first: TFirst; second: TSecond }>;
${ROUTE('TOrder', 'TOrder')}`;
  const { components: { schemas } } = await documentOf(t, source, {
    'src/dir/a.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TName = IModel<{ id: string }>;\n",
    'src/dir/a.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TName = IModel<{ total: number }>;\n",
  });
  const first = schemas.TOrder?.properties?.first?.$ref;
  const second = schemas.TOrder?.properties?.second?.$ref;
  assert.notEqual(first, second);
  assert.deepEqual(Object.keys(schemas[first!.split('/').pop()!]!.properties!), ['id']);
  assert.deepEqual(Object.keys(schemas[second!.split('/').pop()!]!.properties!), ['total']);
});
