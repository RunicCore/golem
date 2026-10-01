import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { MoneyModel, PaymentsClient } from '../sdk/index.js';
import { createPaymentEditor, savePayment, sendPayment } from './payment-app.js';
import type { TPaymentEditor } from './payment-editor.model.js';
import type { PaymentEditorJSON } from './payment-editor.model.generated.js';
import { editPayment, validateAndCorrectPayment } from './payment-preview.js';

test('payment preview edits nested money and returns the serialized result', () => {
  const summaries: string[] = [];
  const result = editPayment(summary => summaries.push(summary));

  assert.deepEqual(summaries, ['30 USD: Lunch']);
  assert.ok(result.editor.money instanceof MoneyModel);
  assert.equal(result.editor.summary, '30 USD: Lunch');
  assert.deepEqual(result.data, {
    money: { amount: 30, currency: 'USD' },
    note: 'Lunch',
  });
});

test('payment preview reports and corrects a nested validation error', async () => {
  const result = await validateAndCorrectPayment();

  assert.ok(result.editor.money instanceof MoneyModel);
  assert.equal(result.initiallyValid, false);
  assert.ok(result.amountErrors.length > 0);
  assert.equal(result.valid, true);
  assert.deepEqual(await validateInstance(result.editor), []);
  assert.deepEqual(result.data, {
    money: { amount: 30, currency: 'USD' },
    note: 'Lunch',
  });
});

test('combined app converts and validates a nested payment editor', async () => {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });

  assert.ok(editor.money instanceof MoneyModel);
  assert.deepEqual(await validateInstance(editor), []);

  editor.note = 'x'.repeat(101);
  let issues = await validateInstance(editor, { failFast: false });
  assert.ok(issues.some(issue => issue.path.length === 1 && issue.path[0] === 'note' && issue.source === 'custom'));

  editor.note = 'Lunch';
  editor.money.amount = -1;
  issues = await validateInstance(editor, { failFast: false });
  assert.ok(issues.some(issue => issue.path.length === 2 && issue.path[0] === 'money' && issue.path[1] === 'amount' && issue.source === 'openapi'));
});

test('combined app saves a valid payment through the generated client', async () => {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });
  let calls = 0;
  const client = new PaymentsClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      calls += 1;
      assert.equal(request.method, 'POST');
      assert.equal(request.url, 'https://example.test/payments');
      assert.deepEqual(await request.json(), { amount: 25, currency: 'USD' });
      return Response.json({ amount: 25, currency: 'USD' }, { status: 201 });
    },
  });

  const result = await savePayment(client, editor);
  assert.equal(calls, 1);
  assert.equal(result.status, 201);
  const wire: PaymentEditorJSON = toWireFormat<TPaymentEditor>(editor);
  assert.deepEqual(result.body, wire.money);
  assert.deepEqual(wire, { money: { amount: 25, currency: 'USD' }, note: 'Lunch' });
});

test('sendPayment rejects an invalid payment before fetch', async () => {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });
  editor.money.amount = -1;

  await assert.rejects(sendPayment('https://example.test', editor), /Cannot save an invalid payment\./);
});

test('sendPayment sends a valid payment to the given baseUrl', async () => {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requestUrl = new Request(input, init).url;
    return Response.json({ amount: 25, currency: 'USD' }, { status: 201 });
  }) as typeof fetch;

  try {
    const result = await sendPayment('https://example.test', editor);
    assert.equal(result.status, 201);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, 'https://example.test/payments');
});

test('combined generated client rejects an invalid request before fetch', async () => {
  let calls = 0;
  const client = new PaymentsClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ amount: 0, currency: 'USD' }, { status: 201 });
    },
  });

  await assert.rejects(client.createPayment().execute({ body: { amount: -1, currency: 'USD' } }), /validation/i);
  assert.equal(calls, 0);
});

test('createPayment sends a JSON body and returns the decoded response body', async () => {
  const originalFetch = globalThis.fetch;
  let received: { body: string; contentType: string | null } | undefined;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    received = { body: await request.text(), contentType: request.headers.get('content-type') };
    return Response.json({ amount: 25, currency: 'USD' }, { status: 201 });
  }) as typeof fetch;
  try {
    const { createdPayment } = await import('./create-payment.js');
    assert.deepEqual(received, { body: '{"amount":25,"currency":"USD"}', contentType: 'application/json' });
    assert.deepEqual(createdPayment, { amount: 25, currency: 'USD' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
