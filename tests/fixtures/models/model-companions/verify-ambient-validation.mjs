import assert from 'node:assert/strict';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { TInvoiceBaseModel } from './build/invoice.model.generated.js';

// The script runs without the build rewrite, so it calls the codec the rewrite would bind.
const modelCodec = (model) => requireObjectCodec(findGeneratedModelDefinition(model).codecId);
const invoice = modelCodec(TInvoiceBaseModel).fromWireFormat({ money: { currency: 'VND' } }, { construct: TInvoiceBaseModel, validate: false });
assert.ok(invoice instanceof TInvoiceBaseModel);
assert.deepEqual(modelCodec(invoice).toWireFormat(invoice), { money: { currency: 'VND' } });
assert.throws(() => requireObjectCodec(process.argv[2]).assert({ money: { currency: 7 } }));
