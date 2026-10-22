import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/serde';
import { rejects, rejectsValidate, type Adapter, type ComparisonFixture, type InvalidOperations } from './fixture-contract.js';
import {
  Account,
  Channel,
  Collection,
  Company,
  Department,
  Employee,
  Enterprise,
  Member,
  ObjectSimple,
  Point3D,
  Timestamp,
} from './golem.model.js';
import {
  ConstrainedAccount,
  ConstrainedChannel,
  ConstrainedEnterprise,
  ConstrainedMember,
  ConstrainedObjectHierarchical,
  ConstrainedTimestamp,
} from './golem.constrained.model.js';
import { createGolemFeatureFixtures } from './comparison-features-golem.js';
import {
  assertDetached,
  assertNoMutation,
  assertValidText,
  assertValidWire,
  consumeValue,
  createFixtureInputs,
  invalidIpLength,
  missingNullable,
  nullableVariant,
  invalidVariants,
  mutateInPlaceAt,
  type FixtureInput,
} from './shared.js';

type GolemModel =
  | InstanceType<typeof ObjectSimple>
  | InstanceType<typeof ConstrainedObjectHierarchical>
  | InstanceType<typeof Collection>;

function trusted(validation: boolean, construct?: new (values?: never) => object): { readonly validate?: false; readonly construct?: new (values?: never) => object } {
  return {
    ...(validation ? {} : { validate: false as const }),
    ...(construct ? { construct } : {}),
  };
}

function registerHandwrittenClasses(): void {
  registerIModelClass('TPoint3D', Point3D);
  registerIModelClass('TTimestamp', Timestamp);
  registerIModelClass('TAccount', Account);
  registerIModelClass('TEnterprise', Enterprise);
  registerIModelClass('TChannel', Channel);
  registerIModelClass('TMember', Member);
  registerIModelClass('TObjectSimple', ObjectSimple);
  registerIModelClass('TEmployee', Employee);
  registerIModelClass('TDepartment', Department);
  registerIModelClass('TCompany', Company);
  registerIModelClass('TCollection', Collection);
  registerIModelClass('TConstrainedTimestamp', ConstrainedTimestamp);
  registerIModelClass('TConstrainedAccount', ConstrainedAccount);
  registerIModelClass('TConstrainedEnterprise', ConstrainedEnterprise);
  registerIModelClass('TConstrainedChannel', ConstrainedChannel);
  registerIModelClass('TConstrainedMember', ConstrainedMember);
  registerIModelClass('TConstrainedObjectHierarchical', ConstrainedObjectHierarchical);
}

registerHandwrittenClasses();

function constructFor(input: FixtureInput): new (values?: never) => object {
  switch (input.name) {
    case 'ObjectSimple': return ObjectSimple;
    case 'ObjectHierarchical-Constrained': return ConstrainedObjectHierarchical;
    case 'ArrayHierarchical-1000':
      return Collection;
  }
}

/**
 * Prove that IObject parse / stringify compose the generated validators by default.
 * IModel tagValidators stay on the class editor path and are not the JSON hot path.
 */
async function verifyPublicTagInvocation(input: FixtureInput): Promise<void> {
  const codec = requireObjectCodec('TConstrainedObjectHierarchical');
  const model = codec.fromWireFormat(input.payload, { construct: ConstrainedObjectHierarchical }) as InstanceType<typeof ConstrainedObjectHierarchical>;
  assert.ok(model instanceof ConstrainedObjectHierarchical);
  codec.toWireFormat(model);
  codec.parse(input.text);
  codec.stringify(input.payload);
  const tagOnlyInvalid = invalidVariants(input)[1];
  assert.throws(
    () => codec.assert(tagOnlyInvalid),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
    'invalid tagged input must be rejected through assert',
  );
}

function validationFor(adapter: Adapter): boolean {
  if (adapter !== 'golem' && adapter !== 'golem-validated') {
    throw new TypeError(`Unsupported golem adapter: ${adapter}`);
  }
  return adapter !== 'golem';
}

function codecId(input: FixtureInput): string {
  switch (input.name) {
    case 'ObjectSimple': return 'TObjectSimple';
    case 'ObjectHierarchical-Constrained': return 'TConstrainedObjectHierarchical';
    case 'ArrayHierarchical-1000':
      return 'TCollection';
  }
}

function decode(input: FixtureInput, validation: boolean): GolemModel {
  return requireObjectCodec(codecId(input)).fromWireFormat(input.payload, trusted(validation, constructFor(input))) as GolemModel;
}

function decodeText(input: FixtureInput, text: string, validation: boolean): GolemModel {
  return requireObjectCodec(codecId(input)).parse(text, trusted(validation, constructFor(input))) as GolemModel;
}

function encode(model: GolemModel, validation: boolean): unknown {
  return requireObjectCodec(codecIdFromModel(model)).toWireFormat(model, trusted(validation));
}

function encodeText(model: GolemModel, _payload: unknown, validation: boolean, id: string): string {
  return requireObjectCodec(id).stringify(model as never, trusted(validation));
}

function codecIdFromModel(model: GolemModel): string {
  if (model instanceof ObjectSimple) return 'TObjectSimple';
  if (model instanceof Collection) return 'TCollection';
  return 'TConstrainedObjectHierarchical';
}

function assertNestedInstances(input: FixtureInput, value: GolemModel): void {
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
      const member = value.member;
      assert.ok(member instanceof ConstrainedMember);
      assert.ok(member.account instanceof ConstrainedAccount);
      assert.ok(member.account.created_at instanceof ConstrainedTimestamp);
      if (member.enterprise !== null) {
        assert.ok(member.enterprise instanceof ConstrainedEnterprise);
        assert.ok(member.enterprise.account instanceof ConstrainedAccount);
        assert.ok(member.enterprise.created_at instanceof ConstrainedTimestamp);
      }
      if (value.account !== null) {
        assert.ok(value.account instanceof ConstrainedAccount);
        assert.ok(value.account.created_at instanceof ConstrainedTimestamp);
      }
      assert.ok(member.created_at instanceof ConstrainedTimestamp);
      assert.ok(value.channel.created_at instanceof ConstrainedTimestamp);
      assert.ok(value.created_at instanceof ConstrainedTimestamp);
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

async function verify(input: FixtureInput, validation: boolean, model: GolemModel): Promise<void> {
  const original = structuredClone(input.payload);
  const fromObject = await decode(input, validation);
  const fromText = await decodeText(input, input.text, validation);
  assertNestedInstances(input, fromObject);
  assertNestedInstances(input, fromText);
  assertDetached(input.payload, fromObject);
  assertDetached(fromObject, fromText);

  const output = encode(fromObject, validation);
  assertValidWire(output, original);
  assertDetached(fromObject, output);
  assertDetached(input.payload, output);
  assertValidText(encodeText(fromObject, original, validation, codecId(input)), input.text);
  assertNoMutation(input.payload, original);
  assertNestedInstances(input, model);

  if (!validation) return;
  // Broken input is built in a verify step only, never when the fixtures are created (R5).
  if (input.name === 'ObjectHierarchical-Constrained') await verifyPublicTagInvocation(input);
  const codec = requireObjectCodec(codecId(input));
  assert.equal(codec.validate(fromObject), true);
  assert.equal(codec.validate(fromText), true);
  const [invalidScalar, missingRequired, nestedInvalid] = invalidVariants(input);
  const invalidDraft = decode({ ...input, payload: invalidScalar } as FixtureInput, false);
  assert.equal(codec.validate(invalidDraft), false);
  const withPayload = (payload: unknown): FixtureInput => ({ ...input, payload } as FixtureInput);
  await assert.throws(() => decode(withPayload(invalidScalar), true), validationError);
  await assert.throws(() => decode(withPayload(missingRequired), true), validationError);
  await assert.throws(() => decode(withPayload(nestedInvalid), true), validationError);
  await assert.throws(() => decodeText(withPayload(invalidScalar), JSON.stringify(invalidScalar), true), validationError);
  await assert.throws(() => decodeText(withPayload(missingRequired), JSON.stringify(missingRequired), true), validationError);
  await assert.throws(() => decodeText(withPayload(nestedInvalid), JSON.stringify(nestedInvalid), true), validationError);
  await assert.throws(() => decodeText(input, '{"broken":', true), (error: unknown) => error instanceof LibError);
  const wrongIpLength = invalidIpLength(input);
  if (wrongIpLength !== undefined) {
    assert.throws(() => decode(withPayload(wrongIpLength), true), validationError);
    assert.throws(() => decodeText(withPayload(wrongIpLength), JSON.stringify(wrongIpLength), true), validationError);
  }
  const missingNullableField = missingNullable(input);
  if (missingNullableField !== undefined) {
    assert.throws(() => decode(withPayload(missingNullableField), true), validationError);
    assert.throws(() => decodeText(withPayload(missingNullableField), JSON.stringify(missingNullableField), true), validationError);
  }
  const nullable = nullableVariant(input);
  if (nullable !== undefined) {
    const nullableInput = withPayload(nullable);
    const nullableModel = await decode(nullableInput, true);
    assert.ok(nullableModel instanceof ConstrainedObjectHierarchical);
    assert.equal(nullableModel.account, null);
    assert.ok(nullableModel.member !== null);
    assert.equal(nullableModel.member.enterprise, null);
    const nullableTextModel = await decodeText(nullableInput, JSON.stringify(nullable), true);
    assert.ok(nullableTextModel instanceof ConstrainedObjectHierarchical);
    assert.equal(nullableTextModel.account, null);
    assert.ok(nullableTextModel.member !== null);
    assert.equal(nullableTextModel.member.enterprise, null);
  }

  const invalidModel = await decode(input, true);
  mutateInPlaceAt(invalidModel, input, 'invalid-number');
  assert.throws(() => encode(invalidModel, true));
}

const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

/** The factory of the invalid-input calls on the first broken variant of the verify step. The worker calls it only in `invalid` mode (R5). */
function invalidOperationsOf(input: FixtureInput): () => InvalidOperations {
  return () => {
    const codec = requireObjectCodec(codecId(input));
    const construct = constructFor(input);
    const wire = invalidVariants(input)[0];
    const text = JSON.stringify(wire);
    const draft = codec.fromWireFormat(wire, { validate: false as const, construct });
    return {
      'object-to-model': rejects(() => codec.fromWireFormat(wire, { construct }), validationError),
      'text-to-model': rejects(() => codec.parse(text, { construct }), validationError),
      validate: rejectsValidate(() => codec.validate(draft)),
    };
  };
}

export async function createGolemFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  const features = await createGolemFeatureFixtures(adapter);
  const validation = validationFor(adapter);
  const fixtures: ComparisonFixture[] = [];
  const inputs = createFixtureInputs();
  for (const input of inputs) {
    const model = await decode(input, validation);
    // #region calls
    // Resolve the codec and options once, as the other libraries' fixtures do; timed calls do only the conversion.
    const codec = requireObjectCodec(codecId(input));
    // parse builds instances of this class: ObjectSimple, ConstrainedObjectHierarchical or Collection.
    const construct = constructFor(input);
    const decodeOptions = validation ? { construct } : { validate: false as const, construct };
    const encodeOptions = validation ? {} : { validate: false as const };
    fixtures.push({
      name: input.name,
      payload: input.payload,
      operations: {
        'object-to-model': () => codec.fromWireFormat(input.payload, decodeOptions),
        'model-to-object': () => codec.toWireFormat(model, encodeOptions),
        'text-to-model': () => codec.parse(input.text, decodeOptions),
        'model-to-text': () => codec.stringify(model as never, encodeOptions),
        ...(validation ? {
          validate: () => {
            const ok = codec.validate(model);
            if (!ok) throw new Error('Class validate rejected a valid fixture');
            return true;
          },
        } : {}),
      },
  // #endregion calls
      // The first broken variant of the verify step, timed in a process of its own (R5): decode and parse must throw, validate must say no.
      ...(validation ? { invalidOperations: invalidOperationsOf(input) } : {}),
      consume: consumeValue,
      verify: () => verify(input, validation, model),
    });
  }
  return [...features, ...fixtures];
}
