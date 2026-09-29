import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/codegen/serde';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { InvoiceBase } from './build/invoice.model.generated.js';

const invoice = decodeGeneratedModel(InvoiceBase, { money: { currency: 'VND' } });
assert.ok(invoice instanceof InvoiceBase);
assert.deepEqual(encodeGeneratedModel(invoice), { money: { currency: 'VND' } });
assert.throws(() => requireObjectCodec(process.argv[2]).assert({ money: { currency: 7 } }));
