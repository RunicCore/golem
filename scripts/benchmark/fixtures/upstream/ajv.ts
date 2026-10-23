import assert from 'node:assert/strict';
import { Ajv, type SchemaObject, type ValidateFunction } from 'ajv';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { checkoutPlainInput, checkoutPlainInvalidWires, consumeFeatureValue } from './payloads.js';
import { consumeValue, createFixtureInputs, invalidIpLength, invalidVariants, missingNullable, nullableVariant, unknownPropertyVariants, type FixtureInput } from './shared.js';

// `object` lists every property as required and rejects unknown ones, as Golem, Typia and Zod do.
const object = (properties: Record<string, SchemaObject>): SchemaObject =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nullable = (schema: SchemaObject): SchemaObject => ({ anyOf: [schema, { type: 'null' }] });
const point = object({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } });
const objectSimple = object({ scale: point, position: point, rotate: point, pivot: point });

// `object` and `nullable` are declared with the Simple object schema.
const int1: SchemaObject = { type: 'integer', minimum: 1 };
const timestamp = object({ time: { type: 'number' }, zone: { type: 'number' } });
const account = object({ id: int1, code: { type: 'string', minLength: 3 }, created_at: timestamp });
const enterprise = object({ id: int1, account, name: { type: 'string', minLength: 2 }, grade: int1, created_at: timestamp });
const channel = object({
  id: int1, code: { type: 'string', minLength: 2, maxLength: 16, pattern: '^[a-z]+$' }, name: { type: 'string', minLength: 2 },
  sequence: int1, exclusive: { type: 'boolean' }, priority: { type: 'integer', minimum: 0 }, created_at: timestamp,
});
const member = object({
  id: int1, account, enterprise: nullable(enterprise),
  emails: { type: 'array', items: { type: 'string', minLength: 3 }, minItems: 1, maxItems: 3 },
  created_at: timestamp, authorized: { type: 'boolean' },
});
const constrainedHierarchical = object({
  id: int1, channel, member: nullable(member), account: nullable(account),
  href: { type: 'string', minLength: 8, pattern: '^https://' }, referrer: { type: 'string', minLength: 8, pattern: '^https://' },
  ip: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, created_at: timestamp,
});

// `object` is declared with the Simple object schema, `timestamp` with the Nested object schema.
const employee = object({ id: { type: 'number' }, name: { type: 'string' }, age: { type: 'number' }, grade: { type: 'number' }, employed_at: timestamp });
const department = object({
  id: { type: 'number' }, code: { type: 'string' }, sales: { type: 'number' }, created_at: timestamp,
  employees: { type: 'array', items: employee },
});
const company = object({
  id: { type: 'number' }, serial: { type: 'number' }, name: { type: 'string' }, established_at: timestamp,
  departments: { type: 'array', items: department },
});
const collection = object({ data: { type: 'array', items: company } });

// `object` is declared with the Simple object schema. Dates stay date-time strings, and nothing converts.
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };
const checkoutPlain: SchemaObject = {
  ...object({
    money: object({ amount: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }),
    note: { type: 'string', minLength: 1 },
    code: { type: 'string', pattern: '^[0-9a-f]+$' },
    when: dateTime,
    items: { type: 'array', items: object({ sku: { type: 'string', minLength: 3 } }) },
    primary: object({ sku: { type: 'string', minLength: 3 }, quantity: { type: 'integer', minimum: 0 }, price: { type: 'number', minimum: 0 } }),
    flags: { type: 'object', additionalProperties: { type: 'string' } },
    channel: { oneOf: [object({ kind: { const: 'open' } }), object({ kind: { const: 'hold' }, until: dateTime })] },
    span: { type: 'array', items: [dateTime, dateTime], minItems: 2, additionalItems: false },
    hold: nullable(dateTime),
    bag: object({ lane: { type: 'string' } }),
    memo: { type: 'string' },
  }),
  required: ['money', 'note', 'code', 'when', 'items', 'primary', 'flags', 'channel', 'span', 'hold'],
};

// Ajv has no built-in date-time format: it takes a format as a function or an expression (its documented `formats` option).
const dateTimeFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const ajv = new Ajv({ formats: { 'date-time': dateTimeFormat } });

function schemaFor(input: FixtureInput): SchemaObject {
  switch (input.name) {
    case 'ObjectSimple': return objectSimple;
    case 'ObjectHierarchical-Constrained': return constrainedHierarchical;
    case 'ArrayHierarchical-1000': return collection;
  }
}

function fixture(input: FixtureInput): ComparisonFixture {
  const validate = ajv.compile(schemaFor(input));
  const fail = (): never => { throw new Error(ajv.errorsText(validate.errors)); };
  const parse = (text: string): unknown => {
    const value: unknown = JSON.parse(text);
    return validate(value) ? value : fail();
  };
  const stringify = (model: unknown): string => validate(model) ? JSON.stringify(model) : fail();
  const model = parse(input.text);
  return {
    name: input.name,
    payload: input.payload,
    operations: {
      'text-to-model': () => {
        const value: unknown = JSON.parse(input.text);
        return validate(value) ? value : fail();
      },
      'model-to-text': () => validate(model) ? JSON.stringify(model) : fail(),
      validate: () => validate(model),
    },
    consume: consumeValue,
    verify: async () => verifyChecked(input, validate, parse, stringify, model),
  };
}

function verifyChecked(input: FixtureInput, validate: ValidateFunction, parse: (text: string) => unknown, stringify: (model: unknown) => string, model: unknown): void {
  assert.equal(stringify(parse(input.text)), input.text, 'ajv: round trip');
  assert.throws(() => parse('{"broken":'), SyntaxError);
  const invalid = [
    ...invalidVariants(input), ...unknownPropertyVariants(input),
    ...[invalidIpLength(input), missingNullable(input)].filter(value => value !== undefined),
  ];
  for (const [index, value] of invalid.entries()) {
    assert.equal(validate(value), false, `ajv ${input.name}: invalid variant ${index} accepted`);
    assert.throws(() => parse(JSON.stringify(value)), Error, `ajv ${input.name}: invalid variant ${index} parsed`);
    assert.throws(() => stringify(value), Error, `ajv ${input.name}: invalid variant ${index} stringified`);
  }
  const nullableText = nullableVariant(input);
  if (nullableText !== undefined) assert.deepEqual(parse(JSON.stringify(nullableText)), nullableText);
  assert.equal(validate(model), true);
}

function checkoutPlainFixture(): ComparisonFixture {
  const input = checkoutPlainInput();
  const validate = ajv.compile(checkoutPlain);
  const fail = (): never => { throw new Error(ajv.errorsText(validate.errors)); };
  const parse = (text: string): unknown => {
    const value: unknown = JSON.parse(text);
    return validate(value) ? value : fail();
  };
  const stringify = (model: unknown): string => validate(model) ? JSON.stringify(model) : fail();
  const model = parse(input.text);
  return {
    name: input.name,
    payload: input.payload,
    operations: {
      'text-to-model': () => {
        const value: unknown = JSON.parse(input.text);
        return validate(value) ? value : fail();
      },
      'model-to-text': () => validate(model) ? JSON.stringify(model) : fail(),
      validate: () => validate(model),
    },
    consume: consumeFeatureValue,
    verify: async () => {
      const original = structuredClone(input.payload);
      assert.deepEqual(parse(input.text), original);
      assert.equal(stringify(parse(input.text)), input.text, 'ajv: round trip');
      assert.throws(() => parse('{"broken":'), SyntaxError);
      const invalid = checkoutPlainInvalidWires();
      for (const [index, value] of [...invalid.broken, invalid.unknownProperty].entries()) {
        assert.equal(validate(value), false, `ajv checkout-plain: invalid variant ${index} accepted`);
        assert.throws(() => parse(JSON.stringify(value)), Error, `ajv checkout-plain: invalid variant ${index} parsed`);
        assert.throws(() => stringify(value), Error, `ajv checkout-plain: invalid variant ${index} stringified`);
      }
      assert.equal(validate(model), true);
      assert.deepEqual(input.payload, original);
    },
  };
}

export async function createAjvFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'ajv') throw new TypeError(`Unsupported Ajv adapter: ${adapter}`);
  return [...createFixtureInputs().map(fixture), checkoutPlainFixture()];
}
