import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from './application.js';
import { writePrice } from './price.model.js';

const charged: Request[] = [];
const provider = {
  baseUrl: 'https://provider.test',
  fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    charged.push(new Request(url, init));
    return Response.json({ id: 'charge-1', status: 'pending', money: { amount: '12.50', currency: 'USD' }, createdAt: '2025-01-02T03:04:05Z', settlesOn: '2025-01-04' }, { status: 201 });
  }) as typeof fetch,
};

async function withApi(run: (api: string) => Promise<void>, options = provider): Promise<void> {
  const application = await createApplication(options);
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

test('a saved payment is charged through the provider with a bearer token and its own idempotency key', () => withApi(async api => {
  charged.length = 0;
  const created = await post(`${api}/payments/transactions`, input);
  assert.deepEqual((await created.json()).charge, { id: 'charge-1', status: 'pending', settlesOn: '2025-01-04' });
  assert.equal(charged[0]?.headers.get('authorization'), 'Bearer dev-token');
  assert.match(charged[0]?.headers.get('idempotency-key') ?? '', /^payment-\d+$/);
  assert.equal(await charged[0]?.text(), JSON.stringify({ amount: '12.50', currency: 'USD' }));
}));

test('a failing provider is a 502 with a clear message and saves no payment', () => withApi(async api => {
  const listed = async () => (await (await fetch(`${api}/payments/transactions`)).json()).length;
  const before = await listed();
  const created = await post(`${api}/payments/transactions`, input);
  assert.equal(created.status, 502);
  assert.equal((await created.json()).message, 'The payment provider declined or is unavailable.');
  assert.equal(await listed(), before);
}, { ...provider, fetchImpl: (async () => new Response('down', { status: 500 })) as typeof fetch }));

test('a provider connection failure is not reported as a provider answer', () => withApi(async api => {
  assert.equal((await post(`${api}/payments/transactions`, input)).status, 500);
}, { ...provider, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }));

test('a float amount and a bad currency are rejected before the handler', () => withApi(async api => {
  const float = await post(`${api}/payments/transactions`, { ...input, money: { amount: 12.5, currency: 'USD' } });
  assert.equal(float.status, 400);
  const bad = await post(`${api}/payments/transactions`, { ...input, money: { amount: '12.50', currency: 'usd' } });
  assert.equal(bad.status, 400);
  const { issues } = await bad.json();
  assert.deepEqual(issues[0].path, ['money', 'currency']);
}));

test('a class body is checked and stored as a payment', () => withApi(async api => {
  const created = await post(`${api}/payments/transactions/as-class`, { id: 'p-1', ...input });
  assert.equal(created.status, 201);
  assert.deepEqual(await (await fetch(`${api}/payments/transactions/p-1`)).json(), { id: 'p-1', ...input });
  const bad = await post(`${api}/payments/transactions/as-class`, { id: 'p-2', ...input, money: { amount: '12.50', currency: 'usd' } });
  assert.equal(bad.status, 400);
}));

test('the query limit decodes to a number and limits the list', () => withApi(async api => {
  await post(`${api}/payments/transactions/as-class`, { id: 'p-3', ...input });
  await post(`${api}/payments/transactions/as-class`, { id: 'p-4', ...input });
  const limited = await fetch(`${api}/payments/transactions?limit=1`);
  assert.equal(limited.status, 200);
  assert.equal((await limited.json()).length, 1);
  assert.equal((await fetch(`${api}/payments/transactions?limit=0`)).status, 400);
}));

test('a query with an undeclared key or an unknown status is 400', () => withApi(async api => {
  assert.equal((await fetch(`${api}/payments/transactions?tracking=x`)).status, 400);
  assert.equal((await fetch(`${api}/payments/transactions?status=refunded`)).status, 400);
  assert.equal((await fetch(`${api}/payments/transactions?status=paid&status=pending`)).status, 200);
}));

test('a draft needs a note of two characters or more', () => withApi(async api => {
  const draft = await post(`${api}/payments/transactions/drafts`, { note: 'Lunch' });
  assert.deepEqual(await draft.json(), { note: 'Lunch' });
  assert.equal((await post(`${api}/payments/transactions/drafts`, { note: '' })).status, 400);
}));

test('an unknown payment is a 404', () => withApi(async api => {
  assert.equal((await fetch(`${api}/payments/transactions/missing`)).status, 404);
}));

test('a price stores integer minor units and writes the decimal text', () => {
  assert.deepEqual(writePrice({ amount: 1250, currency: 'USD' }), { amount: '12.50', currency: 'USD' });
});
