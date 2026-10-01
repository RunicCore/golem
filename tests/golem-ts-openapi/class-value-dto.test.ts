import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

const CONTROLLER = `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { TemporalInstant, TemporalPlainDate } from '@exprtlabs/golem/temporal';
import { Money, encodeMoney, decodeMoney } from './money.js';

type Price = Money & TSerde<typeof encodeMoney, typeof decodeMoney>;
export type TOrder = IModel<{ price: Price; prices: Price[]; placedAt: TemporalInstant; shipsOn?: TemporalPlainDate }>;

@Controller('orders')
export class OrdersController {
  @Post()
  create(@Body() body: TOrder): TOrder { return body; }
}
`;
const MONEY = `export class Money {
  constructor(readonly cents: bigint) {}
  toString(): string { return this.cents.toString(); }
}
export function encodeMoney(value: Money): string { return value.toString(); }
export function decodeMoney(value: string): Money { return new Money(BigInt(value)); }
`;

interface Schema { readonly type?: string; readonly format?: string; readonly required?: readonly string[]; readonly properties?: Readonly<Record<string, Schema>>; readonly items?: Schema; readonly allOf?: readonly Schema[]; readonly $ref?: string }

test('a controller DTO with a class-valued TSerde field and Temporal fields documents their wire form', async t => {
  const root = createControllerFixture(t, {
    prefix: 'golem-ts-openapi-class-value-',
    packageName: 'golem-ts-openapi-class-value-fixture',
    sourceFile: 'src/orders.controller.ts',
    source: CONTROLLER,
    files: { 'src/money.ts': MONEY },
    tsconfig: {
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, skipLibCheck: true, lib: ['ES2023', 'esnext.temporal'] },
      include: ['src/**/*.ts'],
    },
  });
  const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion: '3.2.0', info: { title: 'Orders', version: '1' }, profile: { mobx: false, validation: false } });
  const document = JSON.parse(result.artifacts[0]!.content) as { components: { schemas: Record<string, Schema> } };
  const order = document.components.schemas.Order;
  assert.ok(order, 'Order component');
  assert.deepEqual(order.required, ['placedAt', 'price', 'prices']);
  assert.deepEqual(order.properties?.price, { type: 'string' }, 'a class value is documented by its codec wire type');
  assert.deepEqual(order.properties?.prices, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(order.properties?.placedAt?.allOf, [{ type: 'string' }, { format: 'date-time' }]);
  assert.deepEqual(order.properties?.shipsOn?.allOf, [{ type: 'string' }, { format: 'date' }]);
});
