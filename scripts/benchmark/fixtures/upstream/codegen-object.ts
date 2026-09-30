import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec, type ObjectCodec } from '@exprtlabs/golem/serde';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import './codegen.object.model.generated.js';
import { createCodegenObjectFeatureFixtures } from './comparison-features-codegen-object.js';
import { assertValidText, consumeValue, createFixtureInputs, invalidIpLength, invalidVariants, missingNullable, nullableVariant, unknownPropertyVariants, type FixtureInput } from './shared.js';

function codecId(input: FixtureInput): string {
  switch (input.name) {
    case 'ObjectSimple': return 'PlainObjectSimple';
    case 'ObjectHierarchical-Constrained': return 'PlainConstrainedObjectHierarchical';
    case 'ArrayHierarchical-1000': return 'PlainCollection';
  }
}

const isPlainObject = (value: unknown): boolean => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

function verify(input: FixtureInput, codec: ObjectCodec<unknown>): void {
  const fromText = codec.parse(input.text);
  assert.ok(isPlainObject(fromText), 'IObject parse returns a plain object');
  assert.deepEqual(fromText, input.payload);
  assertValidText(codec.stringify(fromText as never), input.text);
  assert.equal(codec.validate(fromText), true);
  const invalid = [...invalidVariants(input), ...[invalidIpLength(input), missingNullable(input)].filter(value => value !== undefined)];
  for (const value of invalid) {
    assert.throws(() => codec.parse(JSON.stringify(value)), validationError);
    assert.equal(codec.validate(value), false);
  }
  assert.throws(() => codec.parse('{"broken":'), (error: unknown) => error instanceof LibError);
  // Exact, like Typia equals and Zod strict objects: unknown properties are rejected at every depth.
  for (const extra of unknownPropertyVariants(input)) {
    assert.throws(() => codec.parse(JSON.stringify(extra)), validationError, 'IObject parse rejects an unknown property');
    assert.equal(codec.validate(extra), false);
  }
  // The timed stringify validates the model first; an invalid model must not be written.
  assert.throws(() => codec.stringify(invalidVariants(input)[0] as never), validationError);
  const nullable = nullableVariant(input);
  if (nullable !== undefined) {
    const value = codec.parse(JSON.stringify(nullable)) as { account: unknown; member: { enterprise: unknown } };
    assert.equal(value.account, null);
    assert.equal(value.member.enterprise, null);
  }
}

export async function createCodegenObjectFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'codegen-object') throw new TypeError(`Unsupported Codegen IObject adapter: ${adapter}`);
  const fixtures: ComparisonFixture[] = [...await createCodegenObjectFeatureFixtures(adapter)];
  for (const input of createFixtureInputs()) {
    // Resolve the codec once, as the other libraries' fixtures do; timed calls do only the conversion.
    // #region calls
    const codec = requireObjectCodec(codecId(input));
    const model = codec.parse(input.text);
    fixtures.push({
      name: input.name,
      payload: input.payload,
      operations: {
        'text-to-model': () => codec.parse(input.text),
        'model-to-text': () => codec.stringify(model as never),
        validate: () => {
          if (!codec.validate(model)) throw new Error('IObject validate rejected a valid fixture');
          return true;
        },
      },
    // #endregion calls
      consume: consumeValue,
      verify: async () => verify(input, codec),
    });
  }
  return fixtures;
}
