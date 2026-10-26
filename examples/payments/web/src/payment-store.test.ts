import assert from 'node:assert/strict';
import test from 'node:test';
import { getValidator } from '@exprtlabs/golem/validation';
import { PaymentsClient } from '../sdk/index.js';
import { PaymentStore } from './payment-store.js';
import { examplePayment, observeSummary } from './summary.js';

const saved = {
  id: '1',
  merchant: { id: 'merchant-1', name: 'Book shop' },
  billing: { name: 'Accounts' },
  money: { amount: '12.50', currency: 'USD' },
  note: '',
  charge: { id: 'charge-1', status: 'pending', settlesOn: '2025-01-04' },
};

function storeWith(fetchImpl: typeof fetch): PaymentStore {
  return new PaymentStore(new PaymentsClient({ baseUrl: 'https://api.test', fetchImpl }));
}

test('save sends the decimal amount as a string and publishes the response', async () => {
  let body: unknown;
  const store = storeWith(async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json(saved, { status: 201 }); });
  store.editor.setAmount('12.50');
  assert.equal(await store.save(), true);
  assert.deepEqual((body as { money: unknown }).money, { amount: '12.50', currency: 'USD' });
  assert.equal(store.saveState, 'success');
  assert.equal(store.message, 'Payment 1 saved. Charge charge-1 is pending, settles 2025-01-04.');
});

test('validation blocks a bad amount before fetch', async () => {
  let calls = 0;
  const store = storeWith(async () => { calls += 1; return Response.json(saved, { status: 201 }); });
  store.editor.setAmount('12,50');
  store.editor.setNote('x'.repeat(101));
  assert.equal(await store.save(), false);
  assert.equal(calls, 0);
  assert.equal(getValidator(store.editor).errors['/money/amount']?.[0], 'Enter an amount like 12.50');
  assert.equal(store.saveState, 'idle');
});

test('a transport failure is recoverable by saving again', async () => {
  let fail = true;
  const store = storeWith(async () => { if (fail) throw new Error('offline'); return Response.json(saved, { status: 201 }); });
  assert.equal(await store.save(), false);
  assert.equal(store.saveState, 'error');
  fail = false;
  assert.equal(await store.save(), true);
});

test('dispose aborts the request in flight', async () => {
  const store = storeWith((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = store.save();
  await new Promise(resolve => setTimeout(resolve, 10));
  store.dispose();
  assert.equal(await pending, false);
  assert.equal(await store.save(), false);
});

test('a draft that converts writes the number to the model', () => {
  // protects: task T-454 the draft-number example of mobx.md and wire-text.md Step 6
  const store = storeWith(async () => Response.json(saved, { status: 201 }));
  store.setPartsDraft('3');
  assert.equal(store.split.parts, 3);
  assert.equal(store.partsDraft, '3');
  assert.equal(store.partsDraftError, undefined);
});

test('a draft that does not convert keeps the number and shows the draft', () => {
  // protects: task T-454 the draft-number example of mobx.md and wire-text.md Step 6
  const store = storeWith(async () => Response.json(saved, { status: 201 }));
  store.setPartsDraft('3');
  store.setPartsDraft('3.');
  assert.equal(store.split.parts, 3);
  assert.equal(store.partsDraft, '3.');
  assert.equal(store.partsDraftError, 'Enter a whole number like 3');
});

test('an empty draft does not convert', () => {
  // protects: task T-454 the draft-number example of mobx.md and wire-text.md Step 6
  const store = storeWith(async () => Response.json(saved, { status: 201 }));
  store.setPartsDraft('3');
  store.setPartsDraft('');
  assert.equal(store.split.parts, 3);
  assert.equal(store.partsDraft, '');
  assert.equal(store.partsDraftError, 'Enter a whole number like 3');
});

test('a draft in exponent form does not convert', () => {
  // protects: task T-454 the draft-number example of mobx.md and wire-text.md Step 6
  const store = storeWith(async () => Response.json(saved, { status: 201 }));
  store.setPartsDraft('3');
  store.setPartsDraft('1e3');
  assert.equal(store.split.parts, 3);
  assert.equal(store.partsDraft, '1e3');
  assert.equal(store.partsDraftError, 'Enter a whole number like 3');
});

test('a draft above the safe integer range does not convert', () => {
  // protects: task T-454 the draft-number example of mobx.md and wire-text.md Step 6
  const store = storeWith(async () => Response.json(saved, { status: 201 }));
  store.setPartsDraft('3');
  store.setPartsDraft('99999999999999999999');
  assert.equal(store.split.parts, 3);
  assert.equal(store.partsDraft, '99999999999999999999');
  assert.equal(store.partsDraftError, 'Enter a whole number like 3');
});

test('a draft of 0 does not convert because the model needs one part or more', () => {
  // protects: task T-454 the draft-number example of mobx.md and wire-text.md Step 6
  const store = storeWith(async () => Response.json(saved, { status: 201 }));
  store.setPartsDraft('3');
  store.setPartsDraft('0');
  assert.equal(store.split.parts, 3);
  assert.equal(store.partsDraft, '0');
  assert.equal(store.partsDraftError, 'Enter a whole number like 3');
});

test('the summary reaction follows nested edits', () => {
  const editor = examplePayment();
  const lines: string[] = [];
  const stop = observeSummary(editor, line => lines.push(line));
  editor.setAmount('20.00');
  stop();
  editor.setAmount('30.00');
  assert.deepEqual(lines, ['12.50 USD: Order 123', '20.00 USD: Order 123']);
});
