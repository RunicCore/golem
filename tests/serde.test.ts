import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';

import {
  assertValue as publicAssertValue,
  fromWireFormat as publicFromWireFormat,
  parse as publicParse,
  requireObjectCodec,
  stringify as publicStringify,
  toWireFormat as publicToWireFormat,
} from '@exprtlabs/golem/serde';
import { validate as publicValidate } from '@exprtlabs/golem/validation';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { generatedCodecId } from './support/consumer.js';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';

function fixture(
  t: TestContext,
  profile: GolemProfile = { mobx: false, validation: true },
) {
  const { root } = createModelProject(t, {
    prefix: 'golem-serde-',
    name: 'serde-fixture',
    linkTypescript: true,
  });
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  writeModelGolemYaml(root, profile);
  return { root };
}

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}


interface PaymentCodecs {
  stringifyTPayment: (value: object, options?: { validate?: boolean; failFast?: boolean }) => string;
  parseTPayment: (text: string, options?: { validate?: boolean; failFast?: boolean }) => unknown;
  validateTPayment: (value: unknown, options?: { failFast?: boolean }) => value is object;
  toWireFormatTPayment: (value: unknown, options?: { validate?: boolean; failFast?: boolean }) => unknown;
  fromWireFormatTPayment: (wire: unknown, options?: { validate?: boolean; failFast?: boolean }) => unknown;
  stringifyTMoney: (value: object, options?: { validate?: boolean; failFast?: boolean }) => string;
  parseTMoney: (text: string, options?: { validate?: boolean; failFast?: boolean }) => unknown;
}

test('IObject stringify/parse compose nested Money by call; invalid JSON fails before validation; validate<T> narrows', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/narrow.ts'), readFixture("models/serde/validate-t-type-predicate-narrows-to-iobject-fields-for-imodel-and-iobject/narrow.ts"));
  await compile(root);
  const generated = fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8');
  const paymentFnStart = generated.indexOf('function stringifyTPayment');
  const paymentFnEnd = generated.indexOf('\n}', paymentFnStart);
  const paymentFn = generated.slice(paymentFnStart, paymentFnEnd);
  assert.match(paymentFn, /stringifyTMoneyCore\(/, 'one stringify function per interned node: Payment calls the stringifyTMoney core instead of inlining its fields');
  assert.doesNotMatch(
    paymentFn,
    /stringifyJsonString\([^;]*?\["currency"\]/,
    'Money fields are not inlined into stringifyTPayment',
  );
  assert.match(
    generated,
    /registerIModelClass\(/,
    'the companion registers its own base class instead of importing the handwritten subclass',
  );
  assert.doesNotMatch(
    generated,
    /from ['"]\.\/money\.model\.js['"]/,
    'the generated companion never imports the handwritten model file it registers, avoiding a require cycle between them',
  );
  const { Payment } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Payment: new (values?: object) => { id: string; amount: { currency: string; value: string }; note: string };
  };
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as PaymentCodecs & {
    parseTPayment: (text: string, options?: { validate?: boolean; failFast?: boolean; construct?: new (values?: never) => object }) => unknown;
  };
  const wire = { id: '1', amount: { currency: 'USD', value: '12.50' }, note: 'ok' };
  const text = codecs.stringifyTPayment(wire, { validate: false });
  assert.equal(text, '{"id":"1","amount":{"currency":"USD","value":"12.50"},"note":"ok"}');
  assert.equal(
    codecs.stringifyTPayment({ ...wire, extra: true }, { validate: false }),
    text,
  );
  const money = codecs.parseTMoney('{"currency":"USD","value":"12.50"}', { validate: false }) as {
    currency: string;
    value: string;
  };
  assert.equal(Object.getPrototypeOf(money), Object.prototype);
  assert.equal(money.currency, 'USD');
  const parsed = codecs.parseTPayment(text, { validate: false }) as { id: string; amount: unknown };
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed.id, '1');
  assert.deepEqual(parsed.amount, wire.amount);
  const constructed = codecs.parseTPayment(text, { validate: false, construct: Payment }) as InstanceType<typeof Payment>;
  assert.ok(constructed instanceof Payment);
  assert.equal(constructed.id, '1');
  assert.equal(codecs.validateTPayment(wire), true);
  const defaultText = codecs.stringifyTPayment(wire);
  assert.equal(defaultText, text);
  const defaultParsed = codecs.parseTPayment(text) as { id: string };
  assert.equal(defaultParsed.id, '1');
  const model = codecs.fromWireFormatTPayment(wire) as { id: string };
  assert.equal(Object.getPrototypeOf(model), Object.prototype);
  assert.equal(model.id, '1');
  assert.deepEqual(codecs.toWireFormatTPayment(model), wire);
  assert.throws(
    () => codecs.parseTPayment('{"id":'),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.InvalidJson
      && error.issues[0]?.code === 'invalid_json'
      && error.issues[0]?.source === IssueSource.JSON
      && error.issues[0]?.representation === IssueRepresentation.Wire,
  );
  try {
    codecs.parseTPayment(JSON.stringify({
      id: 1,
      amount: { currency: 1, value: 2 },
      note: false,
    }));
    assert.fail('expected fail-fast validation');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.equal(error.issues.length, 1);
  }
  try {
    codecs.parseTPayment(JSON.stringify({
      id: 1,
      amount: { currency: 1, value: 2 },
      note: false,
    }), { failFast: false });
    assert.fail('expected exhaustive validation');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.ok(error.issues.length > 1);
  }
});

test('untransformed public serde APIs and validate<T> throw with the message that names the rewrite', () => {
  const calls = [
    ['stringify', () => publicStringify({ id: '1' })],
    ['parse', () => publicParse('{"id":"1"}')],
    ['validate', () => publicValidate({ id: '1' })],
    ['assertValue', () => publicAssertValue({ id: '1' })],
    ['toWireFormat', () => publicToWireFormat({ id: '1' })],
    ['fromWireFormat', () => publicFromWireFormat({ id: '1' })],
  ] as const;
  for (const [name, call] of calls) {
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.ValidationUnavailable);
      assert.equal(
        error.message,
        `${name}<T> was not rewritten to a generated function. Build with \`golem build\`, the golem Vite or esbuild plugin, or Node with \`--import @exprtlabs/golem/register\`; a package loaded through \`node_modules\` (\`preserveSymlinks\`) is not rewritten.`,
      );
      return true;
    }, name);
  }
});

test('IObject TSerde stringify/parse convert declared fields in one pass', async (t) => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-tserde-',
    name: 'serde-tserde',
    linkTypescript: true,
  });
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/serde/iobject-tserde-stringify-parse-convert-declared-fields-in-one-pass/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'permission.model.ts'), readFixture("models/serde/iobject-tserde-stringify-parse-convert-declared-fields-in-one-pass/permission.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);
  const generated = fs.readFileSync(path.join(root, 'src/permission.model.generated.ts'), 'utf8');
  assert.doesNotMatch(
    generated,
    /stringifyTPermissionInputCore[\s\S]*__golemSerialize[\s\S]*validateTPermissionInputFast/,
    'budget: TSerde fields convert declared fields in one pass, not through a second interleaved stringify/validate sequence',
  );
  const permissionCodecs = await import(pathToFileURL(path.join(root, 'build/codecs.js')).href) as {
    deserializeCalls: number;
  };
  const codecs = await import(pathToFileURL(path.join(root, 'build/permission.model.generated.js')).href) as {
    stringifyTPermissionInput: (value: object, options?: { validate?: boolean }) => string;
    parseTPermissionInput: (text: string, options?: { validate?: boolean }) => { permissions: number };
    stringifyTPermissionModel: (value: object, options?: { validate?: boolean }) => string;
    parseTPermissionModel: (text: string, options?: { validate?: boolean; construct?: new (values?: never) => object }) => { permissions: number };
    toWireFormatTPermissionInput: (value: unknown, options?: { validate?: boolean }) => unknown;
    fromWireFormatTPermissionInput: (wire: unknown, options?: { validate?: boolean }) => { permissions: number };
    validateTPermissionInput: (value: unknown) => boolean;
  };
  const { Permission } = await import(pathToFileURL(path.join(root, 'build/permission.model.js')).href) as {
    Permission: new (values?: object) => { permissions: number };
  };
  assert.equal(codecs.stringifyTPermissionInput({ permissions: 5 }), '{"permissions":"0x5"}');
  const parsed = codecs.parseTPermissionInput('{"permissions":"0x5"}');
  assert.equal(parsed.permissions, 5);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  const dropped = codecs.parseTPermissionInput('{"permissions":"0x5","extra":true}', { validate: false });
  assert.equal(dropped.permissions, 5);
  assert.equal(Reflect.get(dropped, 'extra'), undefined);
  assert.throws(
    () => codecs.parseTPermissionInput('{"permissions":"0x5","extra":true}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.path?.[0] === 'extra',
  );
  const model = codecs.parseTPermissionModel('{"permissions":"0x5"}');
  assert.equal(Object.getPrototypeOf(model), Object.prototype);
  assert.equal(model.permissions, 5);
  const constructed = codecs.parseTPermissionModel('{"permissions":"0x5"}', { construct: Permission });
  assert.ok(constructed instanceof Permission);
  assert.equal(constructed.permissions, 5);
  assert.equal(codecs.stringifyTPermissionModel(constructed), '{"permissions":"0x5"}');
  assert.deepEqual(codecs.toWireFormatTPermissionInput({ permissions: 5 }), { permissions: '0x5' });
  assert.equal(codecs.fromWireFormatTPermissionInput({ permissions: '0x5' }).permissions, 5);
  assert.equal(codecs.validateTPermissionInput({ permissions: 5 }), true);
  assert.equal(codecs.validateTPermissionInput({ permissions: '0x5' }), false);
  const beforeInvalid = permissionCodecs.deserializeCalls;
  assert.throws(
    () => codecs.parseTPermissionInput('{"permissions":"nope"}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Wire,
  );
  assert.equal(permissionCodecs.deserializeCalls, beforeInvalid);
  assert.throws(
    () => codecs.parseTPermissionModel('{"permissions":"0x100"}', { construct: Permission }),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Model,
  );
  assert.ok(permissionCodecs.deserializeCalls > beforeInvalid);
  const trusted = codecs.parseTPermissionInput('{"permissions":"nope"}', { validate: false });
  assert.ok(trusted.permissions === Number.parseInt('nope', 16) || Number.isNaN(trusted.permissions));
});

test('same-type TSerde emits one validator and global validation false rejects { validate: true }', async (t) => {
  const { root: identityRoot, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-identity-',
    name: 'serde-identity',
    linkTypescript: true,
  });
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/serde/same-type-tserde-emits-one-validator-and-global-validation-false-rejects-va/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'label.model.ts'), readFixture("models/serde/same-type-tserde-emits-one-validator-and-global-validation-false-rejects-va/label.model.ts"));
  writeModelGolemYaml(identityRoot, { mobx: false, validation: true });
  await compile(identityRoot);
  const generated = fs.readFileSync(path.join(identityRoot, 'src/label.model.generated.ts'), 'utf8');
  assert.doesNotMatch(generated, /Label#wire/, 'budget: identical wire and model schemas share one schema, no separate Label#wire schema is hoisted');
  assert.doesNotMatch(generated, /validateLabelWireFast/, 'budget: no separate wire-plane validator is emitted when the wire and model schemas are identical');
  const codecs = await import(pathToFileURL(path.join(identityRoot, 'build/label.model.generated.js')).href) as {
    stringifyTLabel: (value: object, options?: { validate?: boolean }) => string;
    parseTLabel: (text: string, options?: { validate?: boolean }) => { name: string };
  };
  assert.equal(codecs.stringifyTLabel({ name: 'ok' }), '{"name":"ok"}');
  assert.equal(codecs.parseTLabel('{"name":"ok"}').name, 'ok');
  assert.throws(
    () => codecs.parseTLabel('{"name":1}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Model,
  );

  const { root } = fixture(t, { mobx: false, validation: false });
  await compile(root);
  const off = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as PaymentCodecs;
  const trusted = off.stringifyTPayment(
    { id: '1', amount: { currency: 'USD', value: '1' }, note: 'x' },
    { validate: false },
  );
  assert.equal(trusted, '{"id":"1","amount":{"currency":"USD","value":"1"},"note":"x"}');
  assert.throws(
    () => off.parseTPayment('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"x"}', { validate: true }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
  assert.throws(
    () => off.stringifyTPayment({ id: '1', amount: { currency: 'USD', value: '1' }, note: 'x' }, { validate: true }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
});

test('same-file nested IModel companions compile without naming the handwritten nested class unbound', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/same-file-nested-imodel-companions-compile-without-naming-the-handwritten-ne/money.model.ts"));
  await compile(root);
  const generated = fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8');
  assert.match(
    generated,
    /requireIModelClass\(/,
    'a same-file nested class field is looked up through the class registry at decode time',
  );
  assert.doesNotMatch(
    generated,
    /import \{ Item \} from ['"]\.\/money\.model\.js['"]/,
    'the generated companion never imports the same-file handwritten class, avoiding a use-before-bound reference',
  );
});

test('nested class-typed IModel fields construct; type-only parse fills like IObject', async (t) => {
  const { root } = fixture(t, { mobx: false, validation: false });
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/nested-class-typed-imodel-fields-construct-type-only-parse-fills-like-iobjec/money.model.ts"));
  await compile(root);
  const generated = fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8');
  assert.doesNotMatch(generated, /from ['"]\.\/money\.model\.js['"]/);
  const pointId = generatedCodecId(generated, 'TPoint3D');
  assert.match(generated, new RegExp(`requireIModelClass\\("${pointId}"\\)`));
  const { registerIModelClass } = await import('@exprtlabs/golem/serde');
  const { Point3D } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Point3D: new (values?: object) => object;
  };
  registerIModelClass(pointId, Point3D);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    parseTObjectTypeField: (text: string, options?: { validate?: boolean }) => { scale: object };
    parseTObjectClassField: (text: string, options?: { validate?: boolean }) => { scale: object };
    fromWireFormatTObjectClassField: (wire: unknown, options?: { validate?: boolean }) => { scale: object };
  };
  const wire = '{"id":"1","scale":{"x":1,"y":2,"z":3}}';
  const typedParsed = codecs.parseTObjectTypeField(wire, { validate: false });
  assert.equal(Object.getPrototypeOf(typedParsed.scale), Object.prototype);
  assert.equal(Reflect.get(typedParsed.scale, 'x'), 1);
  const classified = codecs.fromWireFormatTObjectClassField(JSON.parse(wire) as object, { validate: false });
  assert.ok(classified.scale instanceof Point3D);
});

test('type-only IModel parse fills nested models from the generated base', async (t) => {
  const { root } = fixture(t, { mobx: false, validation: false });
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/type-only-imodel-parse-fills-nested-models-from-the-generated-base/money.model.ts"));
  await compile(root);
  const { TIsolatedPointBaseModel } = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    TIsolatedPointBaseModel: new (values?: object) => object;
  };
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    parseTObjectClassField: (text: string, options?: { validate?: boolean }) => { scale: object };
    fromWireFormatTObjectClassField: (wire: unknown, options?: { validate?: boolean }) => { scale: object };
  };
  const parsed = codecs.parseTObjectClassField('{"id":"1","scale":{"x":1,"y":2,"z":3}}', { validate: false });
  assert.ok(parsed.scale instanceof TIsolatedPointBaseModel);
  assert.equal(Reflect.get(parsed.scale, 'x'), 1);
  const constructed = codecs.fromWireFormatTObjectClassField(
    { id: '1', scale: { x: 1, y: 2, z: 3 } },
    { validate: false },
  );
  assert.ok(constructed.scale instanceof TIsolatedPointBaseModel);
});

test('toWireFormat encodes nullable nested IModel fields to plain objects, not class instances', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/towireformat-encodes-nullable-nested-imodel-fields-to-plain-objects-not-clas/money.model.ts"));
  await compile(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    fromWireFormatTCustomer: (wire: unknown, options?: { validate?: boolean }) => { id: number; account: object | null };
    toWireFormatTCustomer: (value: unknown, options?: { validate?: boolean }) => unknown;
  };
  const present = { id: 101, account: { id: 601, code: 'customer-account-601' } };
  const missing = { id: 101, account: null };
  const presentModel = codecs.fromWireFormatTCustomer(present, { validate: false });
  const missingModel = codecs.fromWireFormatTCustomer(missing, { validate: false });
  const presentWire = codecs.toWireFormatTCustomer(presentModel, { validate: false }) as typeof present;
  const missingWire = codecs.toWireFormatTCustomer(missingModel, { validate: false }) as typeof missing;
  assert.deepEqual(presentWire, present);
  assert.deepEqual(missingWire, missing);
  assert.equal(Object.getPrototypeOf(presentWire.account), Object.prototype);
});

test('fromWireFormat copies identity arrays and tuples instead of aliasing the input containers', async (t) => {
  const { root } = fixture(t, { mobx: false, validation: false });
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/fromwireformat-copies-identity-arrays-and-tuples-without-aliasing-input/money.model.ts"));
  await compile(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    fromWireFormatTMember: (wire: unknown, options?: { validate?: boolean }) => { emails: string[]; ip: [number, number, number, number] };
    toWireFormatTMember: (value: unknown, options?: { validate?: boolean }) => { emails: string[]; ip: [number, number, number, number] };
  };
  const wire = { id: 1, emails: ['a@example.com', 'b@example.com'], ip: [127, 0, 0, 1] as [number, number, number, number] };
  const model = codecs.fromWireFormatTMember(wire, { validate: false });
  assert.notEqual(model.emails, wire.emails);
  assert.deepEqual(model.emails, wire.emails);
  assert.notEqual(model.ip, wire.ip);
  assert.deepEqual(model.ip, wire.ip);
  const encoded = codecs.toWireFormatTMember(model, { validate: false });
  assert.notEqual(encoded.emails, model.emails);
  assert.deepEqual(encoded.emails, wire.emails);
  assert.notEqual(encoded.ip, model.ip);
  assert.deepEqual(encoded.ip, wire.ip);
});

test('a codec that is not registered is a golem fault that names its id and model', () => {
  // protects: R-18 the rewrite loads each codec module, so a missing codec is golem's fault, not advice to the user
  assert.throws(() => requireObjectCodec('TOrder_0badc0de'), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.ValidationUnavailable);
    assert.match(error.message, /^golem fault: the IObject codec "TOrder_0badc0de" for model TOrder is not registered\./);
    return true;
  });
});
