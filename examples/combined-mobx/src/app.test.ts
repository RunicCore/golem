import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autorun, isObservableProp, runInAction } from 'mobx';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { MoneyModel, PaymentsClient } from '../sdk/index.js';
import { createPaymentEditor, savePayment } from './payment-app.js';
import type { TPaymentEditor } from './payment-editor.model.js';
import { editPayment } from './nested-editing.js';
import { observeCreatePayment } from './loading.js';

test('nested editing example reports both summaries and stops the reaction', () => {
  const summaries: string[] = [];
  const editor = editPayment(summary => summaries.push(summary));
  assert.deepEqual(summaries, ['25 USD: Lunch', '30 USD: Lunch']);
  editor.setAmount(40);
  assert.deepEqual(summaries, ['25 USD: Lunch', '30 USD: Lunch']);
});

test('combined-mobx app keeps nested models, summaries, and validation reactive', async () => {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });

  assert.ok(editor.money instanceof MoneyModel);
  assert.equal(isObservableProp(editor.money, 'amount'), true);
  const summaries: string[] = [];
  const validationStates: boolean[] = [];
  const stopSummary = autorun(() => { summaries.push(editor.summary); });
  const validator = getValidator(editor);
  const stopValidation = autorun(() => { validationStates.push(validator.valid); });

  editor.setAmount(-1);
  assert.equal(summaries.at(-1), '-1 USD: Lunch');
  assert.equal(await validator.validate(), false);
  assert.ok(validator.issues.some(issue => issue.path.length === 2 && issue.path[0] === 'money' && issue.path[1] === 'amount' && issue.source === 'openapi'));
  editor.setAmount(25);
  editor.setNote('x'.repeat(101));
  assert.equal(await validator.validate(), false);
  assert.ok(validator.issues.some(issue => issue.path.length === 1 && issue.path[0] === 'note' && issue.source === 'custom'));
  editor.setNote('Lunch');
  assert.equal(await validator.validate(), true);
  assert.deepEqual(validationStates, [true, false, true]);

  // Newly constructed SDK instances arrive observable, including later replacements.
  const replacement = fromWireFormat<MoneyModel>({ amount: 40, currency: 'USD' });
  runInAction(() => { editor.money = replacement; });
  assert.equal(summaries.at(-1), '40 USD: Lunch');
  editor.setAmount(25);
  assert.equal(summaries.at(-1), '25 USD: Lunch');

  stopSummary();
  stopValidation();
  const summaryCount = summaries.length;
  editor.setAmount(30);
  assert.equal(summaries.length, summaryCount);
  assert.deepEqual(toWireFormat<TPaymentEditor>(editor), { money: { amount: 30, currency: 'USD' }, note: 'Lunch' });
});

test('combined-mobx app saves a valid reactive payment through the generated client', async () => {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });
  const payment = toWireFormat<TPaymentEditor>(editor).money;
  const client = new PaymentsClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.method, 'POST');
      assert.deepEqual(await request.json(), payment);
      return Response.json(payment, { status: 201 });
    },
  });

  const result = await savePayment(client, editor);
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, payment);
});

test('observeCreatePayment reports loading while the request is pending and settles after', async () => {
  let resolveResponse!: (response: Response) => void;
  let fetchInvoked!: () => void;
  const fetchCalled = new Promise<void>(resolve => { fetchInvoked = resolve; });
  const client = new PaymentsClient({
    baseUrl: 'https://example.test',
    fetchImpl: () => {
      fetchInvoked();
      return new Promise<Response>(resolve => { resolveResponse = resolve; });
    },
  });
  const { createPayment, states, stop } = observeCreatePayment(client);
  assert.equal(createPayment.loading, false);

  const request = createPayment.execute({ body: { amount: 25, currency: 'USD' } });
  assert.equal(createPayment.loading, true);

  await fetchCalled;
  resolveResponse(Response.json({ amount: 25, currency: 'USD' }, { status: 201 }));
  await request;
  assert.equal(createPayment.loading, false);

  stop();
  assert.deepEqual(states, [false, true, false]);
});
