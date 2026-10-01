import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { nestModelConstruct, objectCodecFromMetatype } from '@exprtlabs/golem/nest';
import { getObjectCodec, parse, stringify } from '@exprtlabs/golem/serde';
import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { PaymentsClient } from '../sdk/index.js';
import { Payment, type TPaymentInput } from './payment.model.js';
import { PaymentsController } from './payments.controller.js';
import { submitPayment } from './client.js';

export type ApplicationFactory = () => Promise<INestApplication>;

export function registerApplicationTests(
  createApplication: ApplicationFactory,
  expectedAdapter?: 'express' | 'fastify',
): void {
  const input: TPaymentInput = {
    merchant: { id: 'merchant-1', name: 'Book shop' },
    billing: { name: 'Accounts' },
    money: { amount: '12.50', currency: 'USD' },
    note: 'Order 123',
  };

  test('Nest @Body uses parse and a model return stringifies to the wire object', async () => {
    const application = await createApplication();
    if (expectedAdapter) assert.equal(application.getHttpAdapter().getType(), expectedAdapter);
    await application.listen(0, '127.0.0.1');
    try {
      const baseUrl = await application.getUrl();
      const client = new PaymentsClient({ baseUrl });
      const response = await client.createPayment().execute({ body: input });
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, { id: '1', ...input });
      assert.equal(Object.getPrototypeOf(response.body), Object.prototype);

      const payment = decodeGeneratedModel(Payment, response.body);
      assert.equal(payment.id, '1');
      assert.equal(payment.money.amount, '12.50');

      const parsed = parse<TPaymentInput>(stringify<TPaymentInput>(input));
      assert.deepEqual(parsed, input);
      assert.deepEqual(parse<TPaymentInput>(JSON.stringify(input)), input);

      const found = await client.getPayment().execute({ path: { id: '1' } });
      assert.deepEqual(found.body, response.body);
      const second = await submitPayment(client, { ...input, note: 'Second payment' });
      assert.equal(second.note, 'Second payment');

      await client.deletePayment().execute({ path: { id: '1' } });
      const thirdResponse = await client.createPayment().execute({ body: { ...input, note: 'Third payment' } });
      assert.equal(thirdResponse.matched, 'status');
      assert.equal(thirdResponse.status, 201);
      const thirdPaymentId = thirdResponse.body.id;
      assert.notEqual(thirdPaymentId, second.id, 'a new payment never reuses a live id');
      const secondAgain = await client.getPayment().execute({ path: { id: second.id } });
      assert.equal(secondAgain.status, 200);
      assert.equal(secondAgain.body.note, 'Second payment');

      const list = await client.listPayments().execute({ querystring: { limit: 1, status: ['paid', 'pending'] } });
      assert.deepEqual(list.body, [{ id: '2', merchant: input.merchant, billing: input.billing, money: input.money, note: 'Second payment' }]);

      const fourthResponse = await submitPayment(client, { ...input, note: 'Fourth payment' });
      assert.equal(fourthResponse.note, 'Fourth payment');

      const limited = await fetch(`${baseUrl}/api/payments/transactions?limit=2`);
      const limitedBody: unknown = await limited.json();
      assert.ok(Array.isArray(limitedBody));
      assert.equal(limitedBody.length, 2, 'limit=2 returns exactly two items when more exist');

      const badLimit = await fetch(`${baseUrl}/api/payments/transactions?limit=abc`);
      assert.equal(badLimit.status, 400);
      const extraQuery = await fetch(`${baseUrl}/api/payments/transactions?tracking=x`);
      assert.equal(extraQuery.status, 400);
      const refunded = await fetch(`${baseUrl}/api/payments/transactions?status=refunded`);
      assert.equal(refunded.status, 400);

      const invalid = await fetch(`${baseUrl}/api/payments/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, billing: { name: 'x' } }),
      });
      assert.equal(invalid.status, 400);
      const error: unknown = await invalid.json();
      assert.ok(error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues));
      const issue = error.issues[0] as { path?: unknown };
      assert.deepEqual(issue.path, ['billing', 'name']);
      const afterInvalid = await client.listPayments().execute({ querystring: {} });
      assert.equal(afterInvalid.status, 200);
      assert.equal(afterInvalid.body.length, 3, 'invalid input must not reach the controller; payments 2, 3, 4 exist');

      const malformed = await fetch(`${baseUrl}/api/payments/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"merchant":',
      });
      assert.equal(malformed.status, 400);

      await client.deletePayment().execute({ path: { id: '2' } });
      // Clean up the third and fourth payments created in the idempotency and limit testing
      await client.deletePayment().execute({ path: { id: thirdPaymentId } });
      await client.deletePayment().execute({ path: { id: fourthResponse.id } });
      const empty = await client.listPayments().execute({ querystring: {} });
      assert.deepEqual(empty.body, []);

      const classBody = { id: 'class-1', ...input };
      const classCreated = await fetch(`${baseUrl}/api/payments/transactions/as-class`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(classBody),
      });
      assert.equal(classCreated.status, 201);
      const classJson: unknown = await classCreated.json();
      assert.deepEqual(classJson, classBody);
      assert.equal(Object.getPrototypeOf(classJson), Object.prototype);
      await client.deletePayment().execute({ path: { id: 'class-1' } });
    } finally {
      await application.close();
    }
  });

  test('getPayment for a missing id resolves the declared 404, not an undeclared-response error', async () => {
    const application = await createApplication();
    await application.listen(0, '127.0.0.1');
    try {
      const baseUrl = await application.getUrl();
      const client = new PaymentsClient({ baseUrl });
      const response = await client.getPayment().execute({ path: { id: 'missing' } });
      assert.equal(response.status, 404);
    } finally {
      await application.close();
    }
  });

  test('Nest @Body codec metadata is enough to parse; a class constructs', () => {
    const types = Reflect.getMetadata('design:paramtypes', PaymentsController.prototype, 'create') as unknown[];
    const codec = objectCodecFromMetatype(types[0]);
    assert.match(codec?.id ?? '', /^PaymentInput_[0-9a-f]{8}$/);
    assert.equal(codec, getObjectCodec(codec!.id));
    const parsed = codec!.parse(JSON.stringify(input));
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(parsed instanceof Payment, false);

    const classTypes = Reflect.getMetadata('design:paramtypes', PaymentsController.prototype, 'createAsClass') as unknown[];
    const classCodec = objectCodecFromMetatype(classTypes[0]);
    assert.match(classCodec?.id ?? '', /^Payment_[0-9a-f]{8}$/);
    assert.equal(classCodec, getObjectCodec(classCodec!.id));
    const classParsed = classCodec!.parse(JSON.stringify({ id: 'class-1', ...input }), {
      construct: nestModelConstruct(classTypes[0]),
    });
    assert.ok(classParsed instanceof Payment);
    assert.equal((classParsed as Payment).id, 'class-1');
    assert.equal((classParsed as Payment).money.amount, '12.50');
  });

  test('a class body is constructed, returned as JSON and rejected before the handler when invalid', async () => {
    const application = await createApplication();
    await application.listen(0, '127.0.0.1');
    try {
      const baseUrl = await application.getUrl();
      const post = (note: string) => fetch(`${baseUrl}/api/payments/transactions/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const accepted = await post('Lunch');
      assert.equal(accepted.status, 201);
      assert.deepEqual(await accepted.json(), { note: 'Lunch' });
      assert.equal((await post('')).status, 400);
    } finally {
      await application.close();
    }
  });

  test('a controller without Swagger decorators gets a default operation ID and its JSON response', async () => {
    const application = await createApplication();
    await application.listen(0, '127.0.0.1');
    try {
      const client = new PaymentsClient({ baseUrl: await application.getUrl() });
      const response = await client.paymentNotesController_get().execute({ path: { id: 'note-1' } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { id: 'note-1', note: 'Order 123' });
    } finally {
      await application.close();
    }
  });

}
