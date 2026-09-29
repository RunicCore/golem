import assert from 'node:assert/strict';
import type { ComparisonFixture } from './fixture-contract.js';

export const sdkExtendWire = {
  money: { amount: 12, currency: 'USD' },
  note: 'ok',
  code: 'ff',
  when: '2026-01-01T00:00:00.000Z',
  items: [{ sku: 'ABC' }],
  primary: { sku: 'ABC', quantity: 1, price: 2 },
  flags: { rush: 'yes' },
  channel: { kind: 'hold' as const, until: '2026-01-03T00:00:00.000Z' },
  span: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'] as [string, string],
  hold: null,
  bag: { lane: 'A' },
};

/** The checkout payload the peer adapters are compared on. */
export function checkoutInput(): { readonly name: 'sdk-extend'; readonly payload: typeof sdkExtendWire; readonly text: string } {
  const payload = structuredClone(sdkExtendWire);
  return { name: 'sdk-extend', payload, text: JSON.stringify(payload) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Folds a checkout result (model, wire object, JSON text or boolean) into a positive number. */
export function consumeFeatureValue(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.length;
  if (isRecord(value) && isRecord(value.money) && typeof value.note === 'string') {
    const amount = typeof value.money.amount === 'number' ? value.money.amount : 0;
    return value.note.length + amount + (Array.isArray(value.items) ? value.items.length : 0);
  }
  return 1;
}

export function featureComparison(
  name: 'sdk-extend',
  payload: unknown,
  operations: ComparisonFixture['operations'],
  verify: ComparisonFixture['verify'],
): ComparisonFixture {
  return { name, payload, operations, consume: consumeFeatureValue, verify };
}

export function assertFeatureWire(actual: unknown, expected: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), 'adapter output must retain the complete wire value');
}
