import assert from 'node:assert/strict';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validateOrReject, ValidationError } from 'class-validator';
import { createClassValidatorFeatureFixtures } from './comparison-features-class-validator.js';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import {
  Collection,
  Company,
  ConstrainedObjectHierarchical,
  Department,
  Employee,
  ObjectSimple,
  Point3D,
  Timestamp,
} from './class-validator.models.js';
import {
  assertDetached,
  assertNoMutation,
  assertValidText,
  assertValidWire,
  consumeValue,
  createFixtureInputs,
  invalidIpLength,
  invalidVariants,
  missingNullable,
  mutateInPlaceAt,
  nullableVariant,
  type FixtureInput,
} from './shared.js';


function isValidationFailure(error: unknown): boolean {
  const hasConstraint = (item: ValidationError): boolean => Object.keys(item.constraints ?? {}).length > 0 || (item.children ?? []).some(hasConstraint);
  return Array.isArray(error) && error.length > 0 && error.every(item => item instanceof ValidationError) && error.some(hasConstraint);
}

type ValidatedModel = ObjectSimple | ConstrainedObjectHierarchical | Collection;

function transform(input: FixtureInput, value: unknown): ValidatedModel {
  switch (input.name) {
    case 'ObjectSimple': return plainToInstance(ObjectSimple, value);
    case 'ObjectHierarchical-Constrained': return plainToInstance(ConstrainedObjectHierarchical, value);
    case 'ArrayHierarchical-1000':
      return plainToInstance(Collection, value);
  }
}

async function toModel(input: FixtureInput, value: unknown): Promise<ValidatedModel> {
  const model = transform(input, value);
  await validateOrReject(model);
  return model;
}

async function toTextModel(input: FixtureInput, text: string): Promise<ValidatedModel> {
  return toModel(input, JSON.parse(text) as unknown);
}

async function toPlain(model: ValidatedModel): Promise<unknown> {
  await validateOrReject(model);
  return instanceToPlain(model);
}

function assertNestedInstances(input: FixtureInput, value: ValidatedModel): void {
  switch (input.name) {
    case 'ObjectSimple': {
      assert.ok(value instanceof ObjectSimple);
      assert.ok(value.scale instanceof Point3D);
      assert.ok(value.position instanceof Point3D);
      assert.ok(value.rotate instanceof Point3D);
      assert.ok(value.pivot instanceof Point3D);
      return;
    }
    case 'ObjectHierarchical-Constrained': {
      assert.ok(value instanceof ConstrainedObjectHierarchical);
      assert.ok(value.channel.id >= 1);
      assert.ok(value.member !== null);
      return;
    }
    case 'ArrayHierarchical-1000': {
      assert.ok(value instanceof Collection);
      assert.equal(value.data.length, 1);
      assert.ok(value.data[0] instanceof Company);
      for (const department of value.data[0].departments) {
        assert.ok(department instanceof Department);
        assert.ok(department.created_at instanceof Timestamp);
        for (const employee of department.employees) {
          assert.ok(employee instanceof Employee);
          assert.ok(employee.employed_at instanceof Timestamp);
        }
      }
      return;
    }
  }
}

async function verify(input: FixtureInput, model: ValidatedModel): Promise<void> {
  const original = structuredClone(input.payload);
  const fromObject = await toModel(input, input.payload);
  const fromText = await toModel(input, JSON.parse(input.text) as unknown);
  assertNestedInstances(input, fromObject);
  assertNestedInstances(input, fromText);
  assertDetached(input.payload, fromObject);
  assertDetached(fromObject, fromText);

  const output = await toPlain(fromObject);
  assertValidWire(output, original);
  assertDetached(fromObject, output);
  assertDetached(input.payload, output);
  assertValidText(JSON.stringify(output), input.text);
  assertNoMutation(input.payload, original);
  assertNestedInstances(input, model);

  const [invalidScalar, missingRequired, nestedInvalid] = invalidVariants(input);
  const withPayload = (payload: unknown): FixtureInput => ({ ...input, payload } as FixtureInput);
  await assert.rejects(() => toModel(withPayload(invalidScalar), invalidScalar), isValidationFailure);
  await assert.rejects(() => toModel(withPayload(missingRequired), missingRequired), isValidationFailure);
  await assert.rejects(() => toModel(withPayload(nestedInvalid), nestedInvalid), isValidationFailure);
  await assert.rejects(() => toModel(withPayload(invalidScalar), JSON.parse(JSON.stringify(invalidScalar)) as unknown), isValidationFailure);
  await assert.rejects(() => toModel(withPayload(missingRequired), JSON.parse(JSON.stringify(missingRequired)) as unknown), isValidationFailure);
  await assert.rejects(() => toModel(withPayload(nestedInvalid), JSON.parse(JSON.stringify(nestedInvalid)) as unknown), isValidationFailure);
  await assert.rejects(() => toTextModel(input, '{"broken":'), SyntaxError);
  const wrongIpLength = invalidIpLength(input);
  if (wrongIpLength !== undefined) {
    await assert.rejects(() => toModel(withPayload(wrongIpLength), wrongIpLength), isValidationFailure);
    await assert.rejects(() => toModel(withPayload(wrongIpLength), JSON.parse(JSON.stringify(wrongIpLength)) as unknown), isValidationFailure);
  }
  const missingNullableField = missingNullable(input);
  if (missingNullableField !== undefined) {
    await assert.rejects(() => toModel(withPayload(missingNullableField), missingNullableField), isValidationFailure);
    await assert.rejects(() => toModel(withPayload(missingNullableField), JSON.parse(JSON.stringify(missingNullableField)) as unknown), isValidationFailure);
  }
  const nullable = nullableVariant(input);
  if (nullable !== undefined) {
    const nullableModel = await toModel(withPayload(nullable), nullable);
    assert.ok(nullableModel instanceof ConstrainedObjectHierarchical);
    assert.equal(nullableModel.account, null);
    assert.ok(nullableModel.member !== null);
    assert.equal(nullableModel.member.enterprise, null);
  }

  const invalidModel = await toModel(input, input.payload);
  mutateInPlaceAt(invalidModel, input, 'invalid-number');
  await assert.rejects(() => toPlain(invalidModel), isValidationFailure);
}

export async function createClassValidatorFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'class-validator') throw new TypeError(`Unsupported class-validator adapter: ${adapter}`);
  const fixtures: ComparisonFixture[] = [];
  for (const input of createFixtureInputs()) {
    const model = await toModel(input, input.payload);
    fixtures.push({
      name: input.name,
      payload: input.payload,
      operations: {
        'object-to-model': () => toModel(input, input.payload),
        'model-to-object': () => toPlain(model),
        'text-to-model': () => toTextModel(input, input.text),
        'model-to-text': async () => JSON.stringify(await toPlain(model)),
        validate: async () => {
          await validateOrReject(model);
          return true;
        },
      },
      consume: consumeValue,
      verify: () => verify(input, model),
    });
  }
  return [...await createClassValidatorFeatureFixtures(adapter), ...fixtures];
}
