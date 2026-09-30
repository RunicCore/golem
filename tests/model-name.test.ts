import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { codecShortName } from '@exprtlabs/golem/schema-graph';

// modelName is internal to the built package; load it from dist instead of compiling package source into the tests.
const distRoot = dirname(fileURLToPath(import.meta.resolve('@exprtlabs/golem/model')));
const { modelName } = await import(pathToFileURL(join(distRoot, 'model-name.js')).href) as {
  readonly modelName: (aliasName: string) => string;
};

const cases: Record<string, string> = {
  Payment: 'Payment',
  TPayment: 'Payment',
  PaymentModel: 'Payment',
  TPaymentModel: 'Payment',
  Model: 'Model',
  TModel: 'Model',
};

test('modelName matches the Go plugin examples', () => {
  for (const [alias, want] of Object.entries(cases)) {
    assert.equal(modelName(alias), want);
    assert.equal(codecShortName(alias), want);
  }
});
