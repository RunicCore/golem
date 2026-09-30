// Runs against the compiled, production-pruned application. Any failed check
// throws, so the process exits non-zero. TEST_HTTP_ADAPTER selects the server.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { nestModelConstruct, objectCodecFromMetatype } from '@exprtlabs/codegen/nest';
import { getObjectCodec } from '@exprtlabs/codegen/serde';
import { decodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { IOBJECT_PLUGIN_KEYS as sdkCodecKeys, PaymentsClient } from './.build/sdk/index.js';
import { createApplication } from './.build/src/application.js';
import { Payment } from './.build/src/payment.model.js';
import { PaymentsController } from './.build/src/payments.controller.js';
import { parseInput, stringifyInput, submitPayment } from './.build/src/wire.js';
import { IOBJECT_PLUGIN_KEYS as modelCodecKeys } from './.build/src/generated/models/iobject-plugin-keys.js';
import {
  OPERATION_CODECS,
  OPERATION_OUTPUT_CODECS,
  OPERATION_QUERY_CODECS,
} from './.build/src/generated/operation-codecs.js';

const adapter = process.env.TEST_HTTP_ADAPTER;
if (adapter !== 'express' && adapter !== 'fastify') {
  throw new Error(`Expected TEST_HTTP_ADAPTER to select express or fastify, got ${JSON.stringify(adapter)}.`);
}

const input = {
  merchant: { id: 'merchant-1', name: 'Book shop' },
  billing: { name: 'Accounts' },
  money: { amount: '12.50', currency: 'USD' },
  note: 'Order 123',
};

const sdkCodecId = model => Object.entries(sdkCodecKeys).find(([key]) => key.endsWith(`#${model}Model`))?.[1];

async function withApplication(run) {
  const application = await createApplication(adapter === 'fastify' ? new FastifyAdapter() : new ExpressAdapter());
  assert.equal(application.getHttpAdapter().getType(), adapter);
  await application.listen(0, '127.0.0.1');
  try {
    await run(await application.getUrl());
  } finally {
    await application.close();
  }
}

// Nest @Body uses parse and a model return stringifies to the wire object.
await withApplication(async baseUrl => {
  const client = new PaymentsClient({ baseUrl });
  const response = await client.createPayment().execute({ body: input });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { id: '1', ...input });
  assert.equal(Object.getPrototypeOf(response.body), Object.prototype);

  const payment = decodeGeneratedModel(Payment, response.body);
  assert.equal(payment.id, '1');
  assert.equal(payment.money.amount, '12.50');

  const parsed = parseInput(stringifyInput(input));
  assert.deepEqual(parsed, input);
  assert.deepEqual(parseInput(JSON.stringify(input)), input);

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
  const limitedBody = await limited.json();
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
  const error = await invalid.json();
  assert.ok(error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues));
  assert.deepEqual(error.issues[0].path, ['billing', 'name']);
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
  const classJson = await classCreated.json();
  assert.deepEqual(classJson, classBody);
  assert.equal(Object.getPrototypeOf(classJson), Object.prototype);
  await client.deletePayment().execute({ path: { id: 'class-1' } });
});

// getPayment for a missing id resolves the declared 404, not an undeclared-response error.
await withApplication(async baseUrl => {
  const response = await new PaymentsClient({ baseUrl }).getPayment().execute({ path: { id: 'missing' } });
  assert.equal(response.status, 404);
});

// Nest @Body codec metadata is enough to parse; a class constructs.
{
  const types = Reflect.getMetadata('design:paramtypes', PaymentsController.prototype, 'create');
  const codec = objectCodecFromMetatype(types[0]);
  assert.match(codec?.id ?? '', /^PaymentInput_[0-9a-f]{8}$/);
  assert.equal(codec, getObjectCodec(codec.id));
  const parsed = codec.parse(JSON.stringify(input));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed instanceof Payment, false);

  const classTypes = Reflect.getMetadata('design:paramtypes', PaymentsController.prototype, 'createAsClass');
  const classCodec = objectCodecFromMetatype(classTypes[0]);
  assert.match(classCodec?.id ?? '', /^Payment_[0-9a-f]{8}$/);
  assert.equal(classCodec, getObjectCodec(classCodec.id));
  const classParsed = classCodec.parse(JSON.stringify({ id: 'class-1', ...input }), {
    construct: nestModelConstruct(classTypes[0]),
  });
  assert.ok(classParsed instanceof Payment);
  assert.equal(classParsed.id, 'class-1');
  assert.equal(classParsed.money.amount, '12.50');
}

// Handwritten and SDK models with the same shape get different hashed codec ids.
for (const model of ['Payment', 'Merchant', 'Money', 'PaymentInput']) {
  const modelId = modelCodecKeys[`src/payment.model.ts#${model}`];
  const sdkId = sdkCodecId(model);
  assert.match(modelId ?? '', new RegExp(`^${model}_[0-9a-f]{8}$`));
  assert.match(sdkId ?? '', new RegExp(`^${model}_[0-9a-f]{8}$`));
  assert.notEqual(sdkId, modelId, `${model}: handwritten and SDK ids differ`);
  assert.equal(getObjectCodec(modelId)?.issueSource, 'typescript', `${model}: handwritten codec keeps its source`);
  assert.equal(getObjectCodec(sdkId)?.issueSource, 'openapi', `${model}: SDK codec keeps its source`);
}
assert.equal(OPERATION_CODECS['POST /api/payments/transactions'], modelCodecKeys['src/payment.model.ts#PaymentInput']);
assert.equal(OPERATION_CODECS['POST /api/payments/transactions/as-class'], modelCodecKeys['src/payment.model.ts#Payment']);
assert.equal(OPERATION_OUTPUT_CODECS['GET /api/payments/transactions/{id}'], modelCodecKeys['src/payment.model.ts#Payment']);
assert.equal(OPERATION_QUERY_CODECS['GET /api/payments/transactions'], modelCodecKeys['src/payment.model.ts#PaymentFilter']);
assert.match(OPERATION_CODECS['POST /api/payments/transactions'] ?? '', /^PaymentInput_[0-9a-f]{8}$/);
