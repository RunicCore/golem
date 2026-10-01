import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { TInvoiceBaseModel } from './build/invoice.model.generated.js';

const invoice = decodeGeneratedModel(TInvoiceBaseModel, { money: { currency: 'VND' } });
assert.ok(invoice instanceof TInvoiceBaseModel);
assert.deepEqual(encodeGeneratedModel(invoice), { money: { currency: 'VND' } });
assert.throws(() => requireObjectCodec(process.argv[2]).assert({ money: { currency: 7 } }));
