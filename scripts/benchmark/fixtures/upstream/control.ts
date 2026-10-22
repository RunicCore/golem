import assert from 'node:assert/strict';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { checkoutInput, consumeFeatureValue } from './payloads.js';
import { consumeValue, createFixtureInputs } from './shared.js';

/**
 * The control: native JSON.parse and JSON.stringify on the same text. It validates and converts nothing and joins no
 * group. The run measures it in its own process so the spread of its numbers is the noise band of the run.
 */
function fixture(name: string, payload: unknown, text: string, consume: (value: unknown) => number): ComparisonFixture {
  const model: unknown = JSON.parse(text);
  const operations = {
    'text-to-model': () => JSON.parse(text) as unknown,
    'model-to-text': () => JSON.stringify(model),
  };
  return {
    name, payload, operations, consume,
    verify: async () => {
      assert.deepEqual(JSON.parse(text), payload);
      assert.equal(JSON.stringify(JSON.parse(text)), text);
    },
  };
}

export async function createControlFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'control') throw new TypeError(`Unsupported control adapter: ${adapter}`);
  const checkout = checkoutInput();
  return [
    ...createFixtureInputs().map(input => fixture(input.name, input.payload, input.text, consumeValue)),
    fixture(checkout.name, checkout.payload, checkout.text, consumeFeatureValue),
  ];
}
