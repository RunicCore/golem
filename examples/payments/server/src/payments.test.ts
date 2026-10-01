import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from './application.js';
import { writePrice } from './price.model.js';

async function withApi(run: (api: string) => Promise<void>): Promise<void> {
  const application = await createApplication();
  await application.listen(0, '127.0.0.1');
  try {
    await run(`${await application.getUrl()}/api`);
  } finally {
    await application.close();
  }
}

const input = {
  merchant: { id: 'merchant-1', name: 'Book shop' },
  billing: { name: 'Accounts' },
  money: { amount: '12.50', currency: 'USD' },
  note: 'Order 123',
};
const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('a created payment keeps its decimal amount exact on the wire', () => withApi(async api => {
  const created = await post(`${api}/payments/transactions`, input);
  assert.equal(created.status, 201);
  const payment = await created.json();
  assert.equal(payment.money.amount, '12.50');
  const found = await fetch(`${api}/payments/transactions/${payment.id}`);
  assert.deepEqual(await found.json(), payment);
}));

test('a float amount and a bad currency are rejected before the handler', () => withApi(async api => {
  const float = await post(`${api}/payments/transactions`, { ...input, money: { amount: 12.5, currency: 'USD' } });
  assert.equal(float.status, 400);
  const bad = await post(`${api}/payments/transactions`, { ...input, money: { amount: '12.50', currency: 'usd' } });
  assert.equal(bad.status, 400);
  const { issues } = await bad.json();
  assert.deepEqual(issues[0].path, ['money', 'currency']);
}));

test('a class body is built from JSON and the query limit decodes to a number', () => withApi(async api => {
  const created = await post(`${api}/payments/transactions/as-class`, { id: 'p-1', ...input });
  assert.equal(created.status, 201);
  assert.equal((await fetch(`${api}/payments/transactions?limit=1`)).status, 200);
  assert.equal((await fetch(`${api}/payments/transactions?limit=0`)).status, 400);
  assert.equal((await post(`${api}/payments/transactions/drafts`, { note: '' })).status, 400);
}));

test('an unknown payment is a 404', () => withApi(async api => {
  assert.equal((await fetch(`${api}/payments/transactions/missing`)).status, 404);
}));

test('a price stores integer minor units and writes the decimal text', () => {
  assert.deepEqual(writePrice({ amount: 1250, currency: 'USD' }), { amount: '12.50', currency: 'USD' });
});
