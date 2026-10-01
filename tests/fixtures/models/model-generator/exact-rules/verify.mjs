import assert from 'node:assert/strict';
import { LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { PaymentBaseModel } from './build/models.model.generated.js';

const paymentId = process.argv[2];
assert.ok(paymentId, 'generated Payment codec ID is required');
const codec = requireObjectCodec(paymentId);
const valid = { id: 'payment-1', currency: 'VND', metadata: { source: 'api' }, audit: { source: 'ledger' } };
const payment = codec.fromWireFormat(valid);
assert.equal(Object.getPrototypeOf(payment), Object.prototype);
assert.equal(typeof PaymentBaseModel, 'function');
assert.deepEqual(codec.toWireFormat(payment), valid);

const rejectsValidation = error => error instanceof Error && error.kind === LibErrorKind.Validation;
assert.throws(() => codec.assert({ ...valid, currency: 'JPY' }), rejectsValidation);
assert.throws(() => codec.assert({ ...valid, metadata: { source: 7 } }), rejectsValidation);
assert.throws(() => codec.assert({ ...valid, audit: { source: 7 } }), rejectsValidation);
assert.throws(() => codec.assert({ ...valid, unexpected: true }), rejectsValidation);
