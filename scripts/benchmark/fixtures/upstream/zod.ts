import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { checkoutInput, checkoutPlainInput, checkoutPlainInvalidWires, consumeFeatureValue } from './payloads.js';
import { consumeValue, createFixtureInputs, invalidIpLength, invalidVariants, missingNullable, nullableVariant, unknownPropertyVariants, type FixtureInput } from './shared.js';

// #region simple
const point = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });
const objectSimple = z.strictObject({ scale: point, position: point, rotate: point, pivot: point });
// #endregion simple

// #region nested
const int1 = z.number().int().min(1);
const timestamp = z.strictObject({ time: z.number(), zone: z.number() });
const account = z.strictObject({ id: int1, code: z.string().min(3), created_at: timestamp });
const enterprise = z.strictObject({ id: int1, account, name: z.string().min(2), grade: int1, created_at: timestamp });
const channel = z.strictObject({
  id: int1, code: z.string().min(2).max(16).regex(/^[a-z]+$/), name: z.string().min(2), sequence: int1,
  exclusive: z.boolean(), priority: z.number().int().min(0), created_at: timestamp,
});
const member = z.strictObject({
  id: int1, account, enterprise: enterprise.nullable(), emails: z.array(z.string().min(3)).min(1).max(3),
  created_at: timestamp, authorized: z.boolean(),
});
const constrainedHierarchical = z.strictObject({
  id: int1, channel, member: member.nullable(), account: account.nullable(),
  href: z.string().min(8).regex(/^https:\/\//), referrer: z.string().min(8).regex(/^https:\/\//),
  ip: z.tuple([z.number(), z.number(), z.number(), z.number()]), created_at: timestamp,
});
// #endregion nested

// #region array
// timestamp is declared with the Nested object schema.
const employee = z.strictObject({ id: z.number(), name: z.string(), age: z.number(), grade: z.number(), employed_at: timestamp });
const department = z.strictObject({ id: z.number(), code: z.string(), sales: z.number(), created_at: timestamp, employees: z.array(employee) });
const company = z.strictObject({ id: z.number(), serial: z.number(), name: z.string(), established_at: timestamp, departments: z.array(department) });
const collection = z.strictObject({ data: z.array(company) });
// #endregion array

// #region checkout
const isoDate = z.codec(z.iso.datetime(), z.date(), { decode: text => new Date(text), encode: date => date.toISOString() });
const hexNumber = z.codec(z.string().regex(/^[0-9a-fA-F]+$/), z.number().positive(), {
  decode: text => Number.parseInt(text, 16), encode: value => value.toString(16),
});
const checkout = z.strictObject({
  money: z.strictObject({ amount: z.number().min(0), currency: z.string().regex(/^[A-Z]{3}$/).refine(value => value !== 'XXX', 'reserved') }),
  note: z.string().refine(value => value.trim().length > 0, 'blank'),
  code: hexNumber,
  when: isoDate,
  items: z.array(z.strictObject({ sku: z.string().min(3) })),
  primary: z.strictObject({ sku: z.string().min(3), quantity: z.number().int().min(0), price: z.number().min(0) }),
  flags: z.record(z.string(), z.string()),
  channel: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('open') }), z.strictObject({ kind: z.literal('hold'), until: isoDate })]),
  span: z.tuple([isoDate, isoDate]),
  hold: isoDate.nullable(),
  bag: z.strictObject({ lane: z.string() }).optional(),
  memo: z.string().optional(),
});
// #endregion checkout

// #region checkout-plain
// Dates stay date-time strings, and nothing converts.
const dateTime = z.iso.datetime();
const checkoutPlain = z.strictObject({
  money: z.strictObject({ amount: z.number().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }),
  note: z.string().min(1),
  code: z.string().regex(/^[0-9a-f]+$/),
  when: dateTime,
  items: z.array(z.strictObject({ sku: z.string().min(3) })),
  primary: z.strictObject({ sku: z.string().min(3), quantity: z.number().int().min(0), price: z.number().min(0) }),
  flags: z.record(z.string(), z.string()),
  channel: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('open') }), z.strictObject({ kind: z.literal('hold'), until: dateTime })]),
  span: z.tuple([dateTime, dateTime]),
  hold: dateTime.nullable(),
  bag: z.strictObject({ lane: z.string() }).optional(),
  memo: z.string().optional(),
});
// #endregion checkout-plain

type Schema = z.ZodType;

function fixture(name: string, payload: unknown, text: string, schema: Schema, consume: (value: unknown) => number, invalid: readonly unknown[], invalidModel: unknown, checkModel?: () => void): ComparisonFixture {
  const model: unknown = schema.parse(JSON.parse(text));
  return {
    name,
    payload,
    // #region calls
    operations: {
      'text-to-model': () => schema.parse(JSON.parse(text)),
      'model-to-text': () => JSON.stringify(z.encode(schema, model)),
      validate: () => z.safeEncode(schema, model).success,
    },
    // #endregion calls
    consume,
    async verify() {
      const decoded = schema.parse(JSON.parse(text));
      checkModel?.();
      assert.equal(JSON.stringify(z.encode(schema, decoded)), text, `zod ${name}: round trip`);
      for (const [index, value] of invalid.entries()) assert.equal(schema.safeParse(value).success, false, `zod ${name}: invalid variant ${index} accepted`);
      // The timed validate and stringify encode a model; an invalid model must fail both.
      assert.equal(z.safeEncode(schema, invalidModel).success, false, `zod ${name}: invalid model accepted by safeEncode`);
      assert.throws(() => z.encode(schema, invalidModel), `zod ${name}: invalid model encoded`);
    },
  };
}

function schemaFor(input: FixtureInput): Schema | undefined {
  switch (input.name) {
    case 'ObjectSimple': return objectSimple;
    case 'ObjectHierarchical-Constrained': return constrainedHierarchical;
    case 'ArrayHierarchical-1000': return collection;
    default: return undefined;
  }
}

function checkUpstream(schema: Schema, input: FixtureInput): void {
  assert.throws(() => schema.parse(JSON.parse('{"broken":')), SyntaxError);
  const nullable = nullableVariant(input);
  if (nullable === undefined) return;
  const model = schema.parse(nullable);
  assert.ok(isRecord(model));
  assert.equal(model.account, null);
  assert.ok(isRecord(model.member));
  assert.equal(model.member.enterprise, null);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkCheckout(text: string): void {
  const value = checkout.parse(JSON.parse(text));
  assert.ok(value.when instanceof Date);
  assert.equal(value.code, 255);
  assert.ok(value.span[0] instanceof Date && value.span[1] instanceof Date);
  assert.ok(value.channel.kind === 'hold' && value.channel.until instanceof Date);
}

export async function createZodFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'zod') throw new TypeError(`Unsupported Zod adapter: ${adapter}`);
  const fixtures: ComparisonFixture[] = [];
  for (const input of createFixtureInputs()) {
    const schema = schemaFor(input);
    if (!schema) continue;
    const invalid = [...invalidVariants(input), ...unknownPropertyVariants(input), ...[invalidIpLength(input), missingNullable(input)].filter(value => value !== undefined)];
    // Upstream payloads have no converted fields, so an invalid wire variant is also an invalid model.
    fixtures.push(fixture(input.name, input.payload, input.text, schema, consumeValue, invalid, invalidVariants(input)[0], () => checkUpstream(schema, input)));
  }
  const sdk = checkoutInput();
  const base = sdk.payload;
  const invalid = [
    { ...structuredClone(base), money: { amount: 12, currency: 'XXX' } },
    { ...structuredClone(base), code: 'zz' },
    { ...structuredClone(base), note: '  ' },
    { ...structuredClone(base), primary: { sku: 'A', quantity: -1.5, price: -2 } },
    { ...structuredClone(base), extra: 1 },
  ];
  const checkoutModel = checkout.parse(JSON.parse(sdk.text)) as Record<string, unknown>;
  const plain = checkoutPlainInput();
  const plainInvalid = checkoutPlainInvalidWires();
  fixtures.push(fixture(plain.name, plain.payload, plain.text, checkoutPlain, consumeFeatureValue, [...plainInvalid.broken, plainInvalid.unknownProperty],
    { ...checkoutPlain.parse(JSON.parse(plain.text)), note: '' }, () => assert.deepEqual(checkoutPlain.parse(JSON.parse(plain.text)), plain.payload)));
  fixtures.push(fixture('sdk-extend', sdk.payload, sdk.text, checkout, consumeFeatureValue, invalid, { ...checkoutModel, note: '  ' }, () => checkCheckout(sdk.text)));
  return fixtures;
}
