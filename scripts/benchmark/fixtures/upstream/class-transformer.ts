import assert from 'node:assert/strict';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { createClassTransformerFeatureFixtures } from './comparison-features-class-transformer.js';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import {
  Account,
  Channel,
  Collection,
  Company,
  ConstrainedChannel,
  ConstrainedMember,
  ConstrainedObjectHierarchical,
  Department,
  Employee,
  Enterprise,
  Member,
  ObjectSimple,
  Point3D,
  Timestamp,
} from './class-transformer.models.js';
import {
  assertDetached,
  assertNoMutation,
  assertValidText,
  assertValidWire,
  consumeValue,
  createFixtureInputs,
  type FixtureInput,
} from './shared.js';

type TransformModel =
  | ObjectSimple
  | ConstrainedObjectHierarchical
  | Collection;

function transform(input: FixtureInput, value: unknown): TransformModel {
  switch (input.name) {
    case 'ObjectSimple': return plainToInstance(ObjectSimple, value);
    case 'ObjectHierarchical-Constrained': return plainToInstance(ConstrainedObjectHierarchical, value);
    case 'ArrayHierarchical-1000':
      return plainToInstance(Collection, value);
  }
}

function toPlain(model: TransformModel): unknown {
  return instanceToPlain(model);
}

function assertNestedInstances(input: FixtureInput, value: TransformModel): void {
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
      assert.ok(value.channel instanceof ConstrainedChannel);
      assert.ok(value.member instanceof ConstrainedMember);
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

async function verify(input: FixtureInput, model: TransformModel): Promise<void> {
  const original = structuredClone(input.payload);
  const fromObject = transform(input, input.payload);
  const fromText = transform(input, JSON.parse(input.text) as unknown);
  assertNestedInstances(input, fromObject);
  assertNestedInstances(input, fromText);
  assertDetached(input.payload, fromObject);
  assertDetached(fromObject, fromText);

  const output = toPlain(fromObject);
  assertValidWire(output, original);
  assertDetached(fromObject, output);
  assertDetached(input.payload, output);
  assertValidText(JSON.stringify(output), input.text);
  assertNoMutation(input.payload, original);
  assertNestedInstances(input, model);
}

export async function createClassTransformerFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'class-transformer') throw new TypeError(`Unsupported class-transformer adapter: ${adapter}`);
  const fixtures: ComparisonFixture[] = [];
  for (const input of createFixtureInputs()) {
    const model = transform(input, input.payload);
    fixtures.push({
      name: input.name,
      payload: input.payload,
      operations: {
        'object-to-model': () => transform(input, input.payload),
        'model-to-object': () => toPlain(model),
        'text-to-model': () => transform(input, JSON.parse(input.text) as unknown),
        'model-to-text': () => JSON.stringify(toPlain(model)),
      },
      consume: consumeValue,
      verify: () => verify(input, model),
    });
  }
  return [...await createClassTransformerFeatureFixtures(adapter), ...fixtures];
}
