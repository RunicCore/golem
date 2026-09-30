import assert from 'node:assert/strict';
import typia, { TypeGuardError } from 'typia';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import type {
  Collection,
  ConstrainedObjectHierarchical,
  ObjectSimple,
} from './typia.models.js';
import {
  assertNoMutation,
  assertValidText,
  consumeValue,
  createFixtureInputs,
  invalidIpLength,
  invalidVariants,
  isRecord,
  missingNullable,
  mutateInPlaceAt,
  nullableVariant,
  unknownPropertyVariants,
  type FixtureInput,
} from './shared.js';

type TypiaModel = ObjectSimple | ConstrainedObjectHierarchical | Collection;

interface TypiaFunctions {
  readonly parse: (text: string) => TypiaModel;
  readonly stringify: (model: unknown) => string;
  readonly is: (value: unknown) => boolean;
}

// #region calls
// Exact variants: unknown properties are rejected, as Golem and Zod do.
function createFunctions(shape: 'simple' | 'constrained' | 'collection'): TypiaFunctions {
  switch (shape) {
    case 'simple': {
      const assertEquals = typia.createAssertEquals<ObjectSimple>();
      const stringify = typia.json.createStringify<ObjectSimple>();
      return { parse: (text) => assertEquals(JSON.parse(text)), stringify: (model) => stringify(assertEquals(model)), is: typia.createEquals<ObjectSimple>() };
    }
    case 'constrained': {
      const assertEquals = typia.createAssertEquals<ConstrainedObjectHierarchical>();
      const stringify = typia.json.createStringify<ConstrainedObjectHierarchical>();
      return { parse: (text) => assertEquals(JSON.parse(text)), stringify: (model) => stringify(assertEquals(model)), is: typia.createEquals<ConstrainedObjectHierarchical>() };
    }
    case 'collection': {
      const assertEquals = typia.createAssertEquals<Collection>();
      const stringify = typia.json.createStringify<Collection>();
      return { parse: (text) => assertEquals(JSON.parse(text)), stringify: (model) => stringify(assertEquals(model)), is: typia.createEquals<Collection>() };
    }
  }
}
// #endregion calls

interface TypiaFunctionTable {
  readonly simple: TypiaFunctions;
  readonly constrained: TypiaFunctions;
  readonly collection: TypiaFunctions;
}

function createFunctionTable(): TypiaFunctionTable {
  return {
    simple: createFunctions('simple'),
    constrained: createFunctions('constrained'),
    collection: createFunctions('collection'),
  };
}

function functionsForInput(input: FixtureInput, table: TypiaFunctionTable): TypiaFunctions {
  switch (input.name) {
    case 'ObjectSimple': return table.simple;
    case 'ObjectHierarchical-Constrained': return table.constrained;
    case 'ArrayHierarchical-1000': return table.collection;
  }
}

function withPayload(input: FixtureInput, payload: unknown): FixtureInput {
  return { ...input, payload } as FixtureInput;
}

function verifyChecked(input: FixtureInput, model: TypiaModel, functions: TypiaFunctions): void {
  const original = structuredClone(input.payload);
  const fromText = functions.parse(input.text);
  assert.deepEqual(fromText, original, 'Typia parse must retain the complete upstream wire value');
  assertValidText(functions.stringify(fromText), input.text);
  assert.equal(functions.is(fromText), true);
  assert.equal(functions.is(invalidVariants(input)[0]), false);
  assertNoMutation(input.payload, original);

  const [invalidScalar, missingRequired, nestedInvalid] = invalidVariants(input);
  for (const invalid of [invalidScalar, missingRequired, nestedInvalid]) {
    assert.throws(() => functions.parse(JSON.stringify(invalid)), TypeGuardError);
  }
  assert.throws(() => functions.parse('{"broken":'), SyntaxError);
  // Exact, like Golem and Zod: unknown properties are rejected at every depth.
  for (const extra of unknownPropertyVariants(input)) {
    assert.throws(() => functions.parse(JSON.stringify(extra)), TypeGuardError, 'typia equals rejects an unknown property');
    assert.equal(functions.is(extra), false);
    assert.throws(() => functions.stringify(extra), TypeGuardError);
  }
  const wrongIpLength = invalidIpLength(input);
  if (wrongIpLength !== undefined) assert.throws(() => functions.parse(JSON.stringify(wrongIpLength)), TypeGuardError);
  const missingNullableField = missingNullable(input);
  if (missingNullableField !== undefined) assert.throws(() => functions.parse(JSON.stringify(missingNullableField)), TypeGuardError);
  const nullable = nullableVariant(input);
  if (nullable !== undefined) {
    const nullableModel = functions.parse(JSON.stringify(nullable));
    assert.deepEqual(nullableModel, nullable);
    assert.ok(isRecord(nullableModel));
    assert.equal(nullableModel.account, null);
    const member = nullableModel.member;
    assert.ok(isRecord(member));
    assert.equal(member.enterprise, null);
  }

  const invalidModel = structuredClone(model);
  mutateInPlaceAt(invalidModel, input, 'invalid-number');
  assert.throws(() => functions.stringify(invalidModel), TypeGuardError);
}

export async function createTypiaFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'typia') throw new TypeError(`Unsupported Typia adapter: ${adapter}`);
  const functionTable = createFunctionTable();
  const fixtures: ComparisonFixture[] = [];
  for (const input of createFixtureInputs()) {
    const functions = functionsForInput(input, functionTable);
    const model = functions.parse(input.text);
    fixtures.push({
      name: input.name,
      payload: input.payload,
      operations: {
        'text-to-model': () => functions.parse(input.text),
        'model-to-text': () => functions.stringify(model),
        validate: () => {
          const ok = functions.is(model);
          if (!ok) throw new Error('typia.equals rejected a valid fixture');
          return true;
        },
      },
      consume: consumeValue,
      verify: async () => verifyChecked(input, model, functions),
    });
  }
  return fixtures;
}
