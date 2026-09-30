import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isObservableProp } from 'mobx';
import { getValidator } from '@exprtlabs/golem/validation';
import { PaymentsClient } from '../sdk/index.js';
import { PaymentStore } from '../src/payment-store.js';

function responseFor(body: unknown): Response {
  return Response.json(body, {
    headers: { 'Content-Type': 'application/json' },
    status: 201,
  });
}

test('save sends one validated request and publishes the generated response', async () => {
  const requests: Request[] = [];
  const client = new PaymentsClient({
    baseUrl: 'http://demo.test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return responseFor({ amount: 25, currency: 'USD' });
    },
  });
  const store = new PaymentStore(client, {
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });

  const firstSave = store.save();
  assert.equal(await store.save(), false, 'a second click while saving must be ignored');
  assert.equal(await firstSave, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(await requests[0]?.json(), { amount: 25, currency: 'USD' });
  assert.equal(store.saveState, 'success');
  assert.equal(store.message, 'Payment saved by the local demo server.');
  assert.equal(store.lastSaved?.amount, 25);
  assert.equal(store.lastSaved?.currency, 'USD');
  assert.equal(isObservableProp(store.lastSaved, 'amount'), true);
  store.dispose();
});

test('validation blocks invalid nested money and custom note values before fetch', async () => {
  let calls = 0;
  const client = new PaymentsClient({
    baseUrl: 'http://demo.test',
    fetchImpl: async () => {
      calls += 1;
      return responseFor({ amount: 0, currency: 'USD' });
    },
  });
  const store = new PaymentStore(client);
  store.editor.setAmount(-1);
  store.editor.setNote('x'.repeat(101));

  assert.equal(await store.save(), false);
  assert.equal(calls, 0);
  assert.equal(store.saveState, 'idle');
  const validator = getValidator(store.editor);
  assert.ok(validator.errors['/money/amount']?.length);
  assert.ok(validator.errorsFor('note').length);
  assert.equal(validator.error('note'), 'Keep the note within 100 characters');
  store.dispose();
});

test('a transport failure is recoverable by saving again', async () => {
  let calls = 0;
  const client = new PaymentsClient({
    baseUrl: 'http://demo.test',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('demo server unavailable');
      return responseFor({ amount: 12, currency: 'EUR' });
    },
  });
  const store = new PaymentStore(client, { money: { amount: 12, currency: 'EUR' } });

  assert.equal(await store.save(), false);
  assert.equal(store.saveState, 'error');
  assert.match(store.message, /demo server unavailable/);
  assert.equal(await store.save(), true);
  assert.equal(calls, 2);
  assert.equal(store.saveState, 'success');
  store.dispose();
});

test('dispose aborts an in-flight request and prevents stale state updates', async () => {
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  let requestSignal: AbortSignal | undefined;
  const client = new PaymentsClient({
    baseUrl: 'http://demo.test',
    fetchImpl: async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      resolveStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('The request was aborted.', 'AbortError'));
        }, { once: true });
      });
    },
  });
  const store = new PaymentStore(client);
  const save = store.save();
  await started;
  store.dispose();

  assert.equal(requestSignal?.aborted, true);
  assert.equal(await save, false);
  assert.equal(store.saveState, 'idle');
  assert.equal(store.message, '');
});

test('a disposed editor cannot send another save request', async () => {
  let calls = 0;
  const store = new PaymentStore(new PaymentsClient({
    baseUrl: 'http://demo.test',
    fetchImpl: async () => { calls += 1; return responseFor({ amount: 25, currency: 'USD' }); },
  }));
  store.dispose();
  assert.equal(await store.save(), false);
  assert.equal(calls, 0);
  assert.equal(store.saveState, 'idle');
});
