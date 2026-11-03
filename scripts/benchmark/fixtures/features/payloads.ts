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

/**
 * The checkout-plain payload: the checkout fields with date-time strings for dates, a plain hex string for the code,
 * and no conversion and no custom rule, so every library runs it. The wire value is the checkout's.
 */
export function checkoutPlainInput(): { readonly name: 'checkout-plain'; readonly payload: typeof sdkExtendWire; readonly text: string } {
  const payload = structuredClone(sdkExtendWire);
  return { name: 'checkout-plain', payload, text: JSON.stringify(payload) };
}

/** Wire values that every validating library rejects: one broken field of each kind, and an unknown property last. */
export function checkoutPlainInvalidWires(): { readonly broken: readonly unknown[]; readonly unknownProperty: unknown } {
  const base = sdkExtendWire;
  const change = (patch: Record<string, unknown>): unknown => ({ ...structuredClone(base), ...patch });
  return {
    broken: [
      change({ money: { amount: 12, currency: 'usd' } }),
      change({ money: { amount: -1, currency: 'USD' } }),
      change({ note: '' }),
      change({ code: 'zz' }),
      change({ when: 'not a date' }),
      change({ primary: { sku: 'A', quantity: -1.5, price: -2 } }),
      change({ span: ['not a date', '2026-01-02T00:00:00.000Z'] }),
      change({ channel: { kind: 'hold', until: 'not a date' } }),
      change({ hold: 5 }),
    ],
    unknownProperty: change({ extra: 1 }),
  };
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
  name: string,
  payload: unknown,
  operations: ComparisonFixture['operations'],
  verify: ComparisonFixture['verify'],
  consume: ComparisonFixture['consume'] = consumeFeatureValue,
): ComparisonFixture {
  return { name, payload, operations, consume, verify };
}

export function assertFeatureWire(actual: unknown, expected: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), 'adapter output must retain the complete wire value');
}

export type SerdeDensity = 'serde-many' | 'serde-none';

const stamps = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-31T00:00:00.000Z'];
const lineStamps = ['2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z', '2026-04-03T00:00:00.000Z', '2026-04-04T00:00:00.000Z', '2026-04-05T00:00:00.000Z'];

/**
 * The two serde payloads: one shape of 21 fields (17 and 4 in each of five items). In serde-many every field
 * converts: money in cents, hex codes, permission bits and yes/no flags are strings on the wire, and dates are date-time strings.
 * serde-none has the same rules on values that need no conversion.
 */
export function serdeWire(name: SerdeDensity) {
  const many = name === 'serde-many';
  const money = (cents: number): string | number => many ? `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : cents;
  const hex = (value: number): string | number => many ? value.toString(16) : value;
  const bits = (value: number): string | number => many ? `0x${value.toString(16)}` : value;
  return {
    price: money(1250), tax: money(125), fee: money(99), total: money(1474),
    code: hex(255), retry: hex(26),
    perms: bits(5), admin: bits(255),
    active: 'yes', archived: 'no',
    created: stamps[0], updated: stamps[1], expires: stamps[2], shipped: stamps[3],
    window: [stamps[0], stamps[2]], review: [stamps[4], stamps[5]],
    lines: lineStamps.map((due, index) => ({ amount: money(250 + index), due, ok: index % 2 === 0 ? 'yes' : 'no', hits: hex(10 + index) })),
  };
}

/** The serde payload as a value and as JSON text. */
export function serdeInput(name: SerdeDensity): { readonly name: SerdeDensity; readonly payload: ReturnType<typeof serdeWire>; readonly text: string } {
  const payload = serdeWire(name);
  return { name, payload, text: JSON.stringify(payload) };
}

/** Folds a serde result (model, wire object, JSON text or boolean) into a positive number. */
export function consumeSerdeValue(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.length;
  if (isRecord(value) && Array.isArray(value.lines)) {
    const price = value.price;
    return value.lines.length + (typeof price === 'number' ? price : typeof price === 'string' ? price.length : 0);
  }
  return 1;
}

export function serdeComparison(
  name: SerdeDensity,
  payload: unknown,
  operations: ComparisonFixture['operations'],
  verify: ComparisonFixture['verify'],
): ComparisonFixture {
  return featureComparison(name, payload, operations, verify, consumeSerdeValue);
}

/** serde-many: every field arrives as a number, a boolean or a Date; serde-none: the fields are the wire values. */
export function assertSerdeModel(name: SerdeDensity, model: unknown): void {
  assert.ok(isRecord(model));
  const lines = model.lines as Record<string, unknown>[];
  assert.equal(lines.length, 5);
  if (name === 'serde-none') {
    assert.deepEqual(JSON.parse(JSON.stringify(model)), serdeWire(name));
    return;
  }
  assert.deepEqual([model.price, model.tax, model.fee, model.total, model.code, model.retry, model.perms, model.admin, model.active, model.archived], [1250, 125, 99, 1474, 255, 26, 5, 255, true, false]);
  for (const field of ['created', 'updated', 'expires', 'shipped'] as const) assert.ok(model[field] instanceof Date, field);
  for (const field of ['window', 'review'] as const) assert.ok((model[field] as unknown[]).every(value => value instanceof Date), field);
  assert.deepEqual(lines.map(line => [line.amount, line.ok, line.hits]), [[250, true, 10], [251, false, 11], [252, true, 12], [253, false, 13], [254, true, 14]]);
  assert.ok(lines.every(line => line.due instanceof Date));
}

/**
 * A copy of the serde wire value with one converting field broken, for each kind of conversion. The first one converts and then fails a rule
 * (the permission bits lack the read bit), so a draft model can be built from it; the invalid timing uses it.
 */
export function serdeInvalidWires(name: SerdeDensity): readonly Record<string, unknown>[] {
  const wire = serdeWire(name);
  const broken = (change: Record<string, unknown>): Record<string, unknown> => ({ ...structuredClone(wire), ...change });
  const line = (change: Record<string, unknown>): Record<string, unknown> => broken({ lines: wire.lines.map((item, index) => index === 0 ? { ...item, ...change } : item) });
  return [
    broken({ perms: name === 'serde-many' ? '0x2' : 2 }),
    broken({ price: name === 'serde-many' ? '12.5' : -1 }),
    broken({ code: name === 'serde-many' ? 'zz' : 0 }),
    broken({ active: 'maybe' }),
    broken({ created: 'not a date' }),
    broken({ window: ['not a date', stamps[2]] }),
    line({ amount: name === 'serde-many' ? '2' : -1 }),
    line({ due: 'not a date' }),
  ];
}
