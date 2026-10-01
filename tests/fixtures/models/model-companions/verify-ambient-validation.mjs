import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { InvoiceBaseModel } from './build/invoice.model.generated.js';

const invoice = decodeGeneratedModel(InvoiceBaseModel, { money: { currency: 'VND' } });
assert.ok(invoice instanceof InvoiceBaseModel);
assert.deepEqual(encodeGeneratedModel(invoice), { money: { currency: 'VND' } });
assert.throws(() => requireObjectCodec(process.argv[2]).assert({ money: { currency: 7 } }));
