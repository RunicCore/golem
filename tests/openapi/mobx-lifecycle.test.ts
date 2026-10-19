import { copyFixtureFile, createFixtureProject, linkProjectPackages } from '../fixture-project.js';
import { generatedModelSource } from './helpers.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import type { GeneratedModelConstructor } from '@exprtlabs/golem/model';
import {
  autorun,
  isObservableObject,
  isObservableProp,
  runInAction,
} from 'mobx';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedModelClass,
  repoRoot,
  requireRecord,
} from './helpers.js';

function lifecycleDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'MobXLifecycle', version: '1' },
    paths: {},
    components: {
      schemas: {
        User: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'score'],
          properties: {
            id: { type: 'string' },
            score: { type: 'integer' },
          },
        },
        Envelope: {
          type: 'object',
          additionalProperties: false,
          required: ['user', 'users'],
          properties: {
            user: { $ref: '#/components/schemas/User' },
            users: {
              type: 'array',
              items: { $ref: '#/components/schemas/User' },
            },
          },
        },
        // An open base, closed on each derived component by unevaluatedProperties: false.
        PaymentBase: {
          type: 'object',
          required: ['amount', 'kind'],
          properties: {
            amount: { type: 'integer' },
            kind: { type: 'string' },
          },
        },
        CardPayment: {
          allOf: [
            { $ref: '#/components/schemas/PaymentBase' },
            {
              type: 'object',
              required: ['kind', 'last4'],
              properties: {
                kind: { const: 'card' },
                last4: { type: 'string' },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        BankTransferPayment: {
          allOf: [
            { $ref: '#/components/schemas/PaymentBase' },
            {
              type: 'object',
              required: ['kind', 'bankReference'],
              properties: {
                kind: { const: 'bank-transfer' },
                bankReference: { type: 'string' },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        Payment: {
          oneOf: [
            { $ref: '#/components/schemas/CardPayment' },
            { $ref: '#/components/schemas/BankTransferPayment' },
          ],
          discriminator: {
            propertyName: 'kind',
            mapping: {
              card: '#/components/schemas/CardPayment',
              'bank-transfer': '#/components/schemas/BankTransferPayment',
            },
          },
        },
      },
    },
  };
}

function asCtor<Instance extends object>(value: unknown): new (values?: object) => Instance {
  return value as new (values?: object) => Instance;
}

function asInstance<Instance extends object>(value: unknown): Instance {
  return value as Instance;
}

function classBody(models: string, className: string): string {
  const start = models.indexOf(`export class ${className} `) >= 0
    ? models.indexOf(`export class ${className} `)
    : models.indexOf(`export abstract class ${className} `);
  assert.ok(start >= 0, `expected ${className} in generated models`);
  const rest = models.slice(start);
  const next = rest.search(/\nexport (?:abstract )?class /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('generated MobX models initialize at construction and keep subclass hooks', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-mobx-lifecycle-'), 'sdk');

  const enabled = await generateMaterializedSdk(lifecycleDocument(), {
    output,
    name: 'MobXLifecycle',
    profile: { mobx: true, validation: false },
  });
  const models = generatedModelSource(enabled.artifacts);
  // asGenObservable exists in packages/golem/src/mobx.ts and is exercised for every
  // concrete class below; PaymentModel is a discriminated union that is never directly
  // constructed, so its own hook can only be proven absent from the emitted text (a rename
  // of the pattern would still fail the positive checks elsewhere in this test).
  assert.doesNotMatch(classBody(models, 'PaymentModel'), /if \(new\.target === PaymentModel\)/, 'keep-absence: the union class does not get its own asGenObservable hook');
  linkProjectPackages(output, { mobx: path.join(repoRoot(), 'node_modules/mobx') });

  const subclass = path.join(output, 'tracked-envelope.ts');
  copyFixtureFile(output, "openapi/mobx-lifecycle/tracked-envelope.ts", "tracked-envelope.ts");
  compileGeneratedSdk(output, [subclass], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
  });

  const generated = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'mobx lifecycle models',
  );
  const trackedModule = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/tracked-envelope.js')).href),
    'tracked envelope',
  );
  const UserModel = generated.UserModel;
  const EnvelopeModel = generated.EnvelopeModel;
  const PaymentBaseModel = generated.PaymentBaseModel;
  const CardPaymentModel = generated.CardPaymentModel;
  const PaymentModel = generated.PaymentModel;
  const TrackedEnvelope = trackedModule.TrackedEnvelope;
  assert.equal(typeof trackedModule.TrackedCard, 'function');
  const trackedCard = new (asCtor<{ edits: number }>(trackedModule.TrackedCard))();
  assert.equal(isObservableProp(trackedCard, 'edits'), true);
  assert.ok(isGeneratedModelClass(UserModel));
  assert.ok(isGeneratedModelClass(EnvelopeModel));
  assert.ok(typeof PaymentBaseModel === 'function');
  assert.ok(isGeneratedModelClass(CardPaymentModel));
  if (!isGeneratedModelClass(UserModel) || !isGeneratedModelClass(EnvelopeModel)) {
    throw new TypeError('expected UserModel and EnvelopeModel');
  }

  // PaymentBaseModel is concrete (not part of the Payment union), so it gets its own
  // asGenObservable hook and can be constructed directly.
  const paymentBaseInstance = new (asCtor<{ amount: number; kind: string }>(PaymentBaseModel))({ amount: 5, kind: 'card' });
  assert.equal(isObservableObject(paymentBaseInstance), true);

  type UserInstance = { id: string; score: number };
  const constructed = new (asCtor<UserInstance>(UserModel))({ id: 'u1', score: 1 });
  const parsed = asInstance<UserInstance>(decodeGeneratedModel(UserModel, { id: 'u2', score: 2 }));
  assert.equal(isObservableObject(constructed), true);
  assert.equal(isObservableProp(constructed, 'score'), true);
  assert.equal(isObservableObject(parsed), true);
  assert.equal(isObservableProp(parsed, 'id'), true);

  type EnvelopeInstance = {
    user: UserInstance;
    users: UserInstance[];
  };
  const nested = asInstance<EnvelopeInstance>(decodeGeneratedModel(EnvelopeModel, {
    user: { id: 'nested', score: 3 },
    users: [{ id: 'listed', score: 4 }],
  }));
  assert.equal(isObservableObject(nested), true);
  assert.equal(isObservableObject(nested.user), true);
  assert.equal(isObservableProp(nested.user, 'score'), true);
  assert.equal(isObservableObject(nested.users[0]), true);

  const inherited = new (asCtor<{ amount: number; kind: string; last4: string }>(CardPaymentModel))({
    amount: 10,
    kind: 'card',
    last4: '4242',
  });
  assert.equal(isObservableObject(inherited), true);
  assert.equal(isObservableProp(inherited, 'amount'), true);
  assert.equal(isObservableProp(inherited, 'last4'), true);
  const fromUnion = decodeGeneratedModel(PaymentModel as unknown as GeneratedModelConstructor, {
    amount: 11,
    kind: 'card',
    last4: '1111',
  });
  assert.equal(fromUnion instanceof CardPaymentModel, true);
  assert.equal(isObservableObject(fromUnion), true);

  type TrackedInstance = EnvelopeInstance & {
    edits: number;
  };
  const tracked = new (asCtor<TrackedInstance>(TrackedEnvelope))({
    user: { id: 'tracked', score: 5 },
    users: [],
  });
  assert.equal(isObservableObject(tracked), true);
  assert.equal(isObservableProp(tracked, 'edits'), true);
  const editCounts: number[] = [];
  const disposeEdits = autorun(() => editCounts.push(tracked.edits));
  runInAction(() => {
    tracked.edits = 7;
  });
  assert.deepEqual(editCounts, [0, 7]);
  disposeEdits();

  const replacements: string[] = [];
  const disposeUser = autorun(() => replacements.push(nested.user.id));
  runInAction(() => {
    nested.user = new (asCtor<UserInstance>(UserModel))({ id: 'replaced', score: 8 });
  });
  assert.deepEqual(replacements, ['nested', 'replaced']);
  assert.equal(isObservableObject(nested.user), true);
  runInAction(() => { nested.user.id = 'changed'; });
  assert.deepEqual(replacements, ['nested', 'replaced', 'changed']);
  disposeUser();

  const arrayIds: string[] = [];
  const disposeUsers = autorun(() => arrayIds.push(nested.users.map((user) => user.id).join(',')));
  runInAction(() => {
    nested.users.push(new (asCtor<UserInstance>(UserModel))({ id: 'pushed', score: 9 }));
  });
  assert.deepEqual(arrayIds, ['listed', 'listed,pushed']);
  runInAction(() => { nested.users[1].id = 'changed'; });
  assert.deepEqual(arrayIds, ['listed', 'listed,pushed', 'listed,changed']);
  disposeUsers();

  const { asGenObservable } = await import('@exprtlabs/golem/mobx');
  assert.throws(
    () => asGenObservable(constructed),
    /asGenObservable\(\) may only be called once/,
  );

  const disabledOutput = path.join(path.dirname(output), 'disabled');
  const disabled = await generateMaterializedSdk(lifecycleDocument(), {
    output: disabledOutput,
    name: 'MobXDisabled',
    profile: { mobx: false, validation: false },
  });
  compileGeneratedSdk(disabledOutput, [], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
  });
  const disabledGenerated = requireRecord(
    await import(pathToFileURL(path.join(disabledOutput, 'dist/index.js')).href),
    'disabled mobx models',
  );
  const DisabledUser = disabledGenerated.UserModel;
  assert.ok(isGeneratedModelClass(DisabledUser));
  if (!isGeneratedModelClass(DisabledUser)) throw new TypeError('expected disabled UserModel');
  const plain = new (asCtor<UserInstance>(DisabledUser))({ id: 'plain', score: 1 });
  assert.equal(isObservableObject(plain), false);
});
