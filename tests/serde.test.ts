import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';

import {
  assertValue as publicAssertValue,
  fromWireFormat as publicFromWireFormat,
  parse as publicParse,
  stringify as publicStringify,
  toWireFormat as publicToWireFormat,
} from '@exprtlabs/golem/serde';
import { validate as publicValidate } from '@exprtlabs/golem/validation';
import { IssueCode, IssueRepresentation, IssueSource, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { generate } from '#model/generator';
import { ttscEnv } from './support/process.js';
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
    linkTtsc: true,
  });
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  const result = generate({ root, profile });
  writeGeneratedArtifacts(result.artifacts);
  return { root };
}

async function compile(root: string): Promise<void> {
  await compileModelProject(root, [], { env: ttscEnv });
}


interface PaymentCodecs {
  stringifyPayment: (value: object, options?: { validate?: boolean; failFast?: boolean }) => string;
  parsePayment: (text: string, options?: { validate?: boolean; failFast?: boolean }) => unknown;
  validatePayment: (value: unknown, options?: { failFast?: boolean }) => value is object;
  toWireFormatPayment: (value: unknown, options?: { validate?: boolean; failFast?: boolean }) => unknown;
  fromWireFormatPayment: (wire: unknown, options?: { validate?: boolean; failFast?: boolean }) => unknown;
  stringifyMoney: (value: object, options?: { validate?: boolean; failFast?: boolean }) => string;
  parseMoney: (text: string, options?: { validate?: boolean; failFast?: boolean }) => unknown;
}

test('IObject stringify/parse compose nested Money by call; invalid JSON fails before Ajv; validate<T> narrows', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/narrow.ts'), readFixture("models/serde/validate-t-type-predicate-narrows-to-iobject-fields-for-imodel-and-iobject/narrow.ts"));
  const generated = fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8');
  const paymentFnStart = generated.indexOf('function stringifyPayment');
  const paymentFnEnd = generated.indexOf('\n}', paymentFnStart);
  const paymentFn = generated.slice(paymentFnStart, paymentFnEnd);
  assert.match(paymentFn, /stringifyMoneyCore\(/, 'one stringify function per interned node: Payment calls the stringifyMoney core instead of inlining its fields');
  assert.doesNotMatch(
    paymentFn,
    /stringifyJsonString\([^;]*?\["currency"\]/,
    'Money fields are not inlined into stringifyPayment',
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
  await compile(root);
  const { Payment } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Payment: new (values?: object) => { id: string; amount: { currency: string; value: string }; note: string };
  };
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as PaymentCodecs & {
    parsePayment: (text: string, options?: { validate?: boolean; failFast?: boolean; construct?: new (values?: never) => object }) => unknown;
  };
  const wire = { id: '1', amount: { currency: 'USD', value: '12.50' }, note: 'ok' };
  const text = codecs.stringifyPayment(wire, { validate: false });
  assert.equal(text, '{"id":"1","amount":{"currency":"USD","value":"12.50"},"note":"ok"}');
  assert.equal(
    codecs.stringifyPayment({ ...wire, extra: true }, { validate: false }),
    text,
  );
  const money = codecs.parseMoney('{"currency":"USD","value":"12.50"}', { validate: false }) as {
    currency: string;
    value: string;
  };
  assert.equal(Object.getPrototypeOf(money), Object.prototype);
  assert.equal(money.currency, 'USD');
  const parsed = codecs.parsePayment(text, { validate: false }) as { id: string; amount: unknown };
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed.id, '1');
  assert.deepEqual(parsed.amount, wire.amount);
  const constructed = codecs.parsePayment(text, { validate: false, construct: Payment }) as InstanceType<typeof Payment>;
  assert.ok(constructed instanceof Payment);
  assert.equal(constructed.id, '1');
  assert.equal(codecs.validatePayment(wire), true);
  const defaultText = codecs.stringifyPayment(wire);
  assert.equal(defaultText, text);
  const defaultParsed = codecs.parsePayment(text) as { id: string };
  assert.equal(defaultParsed.id, '1');
  const model = codecs.fromWireFormatPayment(wire) as { id: string };
  assert.equal(Object.getPrototypeOf(model), Object.prototype);
  assert.equal(model.id, '1');
  assert.deepEqual(codecs.toWireFormatPayment(model), wire);
  assert.throws(
    () => codecs.parsePayment('{"id":'),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.InvalidJson
      && error.issues[0]?.code === IssueCode.InvalidJson
      && error.issues[0]?.source === IssueSource.JSON
      && error.issues[0]?.representation === IssueRepresentation.Wire,
  );
  try {
    codecs.parsePayment(JSON.stringify({
      id: 1,
      amount: { currency: 1, value: 2 },
      note: false,
    }));
    assert.fail('expected fail-fast Ajv');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.equal(error.issues.length, 1);
  }
  try {
    codecs.parsePayment(JSON.stringify({
      id: 1,
      amount: { currency: 1, value: 2 },
      note: false,
    }), { failFast: false });
    assert.fail('expected exhaustive Ajv');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.ok(error.issues.length > 1);
  }
});

test('untransformed public serde APIs and validate<T> throw', () => {
  const unavailable = (error: unknown) => (
    error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable
  );
  assert.throws(() => publicStringify({ id: '1' }), unavailable);
  assert.throws(() => publicParse('{"id":"1"}'), unavailable);
  assert.throws(() => publicValidate({ id: '1' }), unavailable);
  assert.throws(() => publicAssertValue({ id: '1' }), unavailable);
  assert.throws(() => publicToWireFormat({ id: '1' }), unavailable);
  assert.throws(() => publicFromWireFormat({ id: '1' }), unavailable);
});

test('IObject TSerde stringify/parse convert declared fields in one pass', async (t) => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-tserde-',
    name: 'serde-tserde',
    linkTypescript: true,
    linkTtsc: true,
  });
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/serde/iobject-tserde-stringify-parse-convert-declared-fields-in-one-pass/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'permission.model.ts'), readFixture("models/serde/iobject-tserde-stringify-parse-convert-declared-fields-in-one-pass/permission.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const generated = fs.readFileSync(path.join(root, 'src/permission.model.generated.ts'), 'utf8');
  assert.doesNotMatch(
    generated,
    /stringifyPermissionInputCore[\s\S]*__golemSerialize[\s\S]*validatePermissionInputFast/,
    'budget: TSerde fields convert declared fields in one pass, not through a second interleaved stringify/validate sequence',
  );
  await compile(root);
  const permissionCodecs = await import(pathToFileURL(path.join(root, 'build/codecs.js')).href) as {
    deserializeCalls: number;
  };
  const codecs = await import(pathToFileURL(path.join(root, 'build/permission.model.generated.js')).href) as {
    stringifyPermissionInput: (value: object, options?: { validate?: boolean }) => string;
    parsePermissionInput: (text: string, options?: { validate?: boolean }) => { permissions: number };
    stringifyPermission: (value: object, options?: { validate?: boolean }) => string;
    parsePermission: (text: string, options?: { validate?: boolean; construct?: new (values?: never) => object }) => { permissions: number };
    toWireFormatPermissionInput: (value: unknown, options?: { validate?: boolean }) => unknown;
    fromWireFormatPermissionInput: (wire: unknown, options?: { validate?: boolean }) => { permissions: number };
    validatePermissionInput: (value: unknown) => boolean;
  };
  const { Permission } = await import(pathToFileURL(path.join(root, 'build/permission.model.js')).href) as {
    Permission: new (values?: object) => { permissions: number };
  };
  assert.equal(codecs.stringifyPermissionInput({ permissions: 5 }), '{"permissions":"0x5"}');
  const parsed = codecs.parsePermissionInput('{"permissions":"0x5"}');
  assert.equal(parsed.permissions, 5);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  const dropped = codecs.parsePermissionInput('{"permissions":"0x5","extra":true}', { validate: false });
  assert.equal(dropped.permissions, 5);
  assert.equal(Reflect.get(dropped, 'extra'), undefined);
  assert.throws(
    () => codecs.parsePermissionInput('{"permissions":"0x5","extra":true}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.path?.[0] === 'extra',
  );
  const model = codecs.parsePermission('{"permissions":"0x5"}');
  assert.equal(Object.getPrototypeOf(model), Object.prototype);
  assert.equal(model.permissions, 5);
  const constructed = codecs.parsePermission('{"permissions":"0x5"}', { construct: Permission });
  assert.ok(constructed instanceof Permission);
  assert.equal(constructed.permissions, 5);
  assert.equal(codecs.stringifyPermission(constructed), '{"permissions":"0x5"}');
  assert.deepEqual(codecs.toWireFormatPermissionInput({ permissions: 5 }), { permissions: '0x5' });
  assert.equal(codecs.fromWireFormatPermissionInput({ permissions: '0x5' }).permissions, 5);
  assert.equal(codecs.validatePermissionInput({ permissions: 5 }), true);
  assert.equal(codecs.validatePermissionInput({ permissions: '0x5' }), false);
  const beforeInvalid = permissionCodecs.deserializeCalls;
  assert.throws(
    () => codecs.parsePermissionInput('{"permissions":"nope"}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Wire,
  );
  assert.equal(permissionCodecs.deserializeCalls, beforeInvalid);
  assert.throws(
    () => codecs.parsePermission('{"permissions":"0x100"}', { construct: Permission }),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Model,
  );
  assert.ok(permissionCodecs.deserializeCalls > beforeInvalid);
  const trusted = codecs.parsePermissionInput('{"permissions":"nope"}', { validate: false });
  assert.ok(trusted.permissions === Number.parseInt('nope', 16) || Number.isNaN(trusted.permissions));
});

test('same-type TSerde emits one Ajv schema and global validation false rejects { validate: true }', async (t) => {
  const { root: identityRoot, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-identity-',
    name: 'serde-identity',
    linkTypescript: true,
    linkTtsc: true,
  });
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/serde/same-type-tserde-emits-one-ajv-schema-and-global-validation-false-rejects-va/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'label.model.ts'), readFixture("models/serde/same-type-tserde-emits-one-ajv-schema-and-global-validation-false-rejects-va/label.model.ts"));
  const generatedArtifacts = generate({ root: identityRoot, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(generatedArtifacts.artifacts);
  const generated = fs.readFileSync(path.join(identityRoot, 'src/label.model.generated.ts'), 'utf8');
  assert.doesNotMatch(generated, /Label#wire/, 'budget: identical wire and model schemas share one Ajv schema, no separate Label#wire schema is hoisted');
  assert.doesNotMatch(generated, /validateLabelWireFast/, 'budget: no separate wire-plane validator is emitted when the wire and model schemas are identical');
  await compile(identityRoot);
  const codecs = await import(pathToFileURL(path.join(identityRoot, 'build/label.model.generated.js')).href) as {
    stringifyLabel: (value: object, options?: { validate?: boolean }) => string;
    parseLabel: (text: string, options?: { validate?: boolean }) => { name: string };
  };
  assert.equal(codecs.stringifyLabel({ name: 'ok' }), '{"name":"ok"}');
  assert.equal(codecs.parseLabel('{"name":"ok"}').name, 'ok');
  assert.throws(
    () => codecs.parseLabel('{"name":1}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Model,
  );

  const { root } = fixture(t, { mobx: false, validation: false });
  await compile(root);
  const off = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as PaymentCodecs;
  const trusted = off.stringifyPayment(
    { id: '1', amount: { currency: 'USD', value: '1' }, note: 'x' },
    { validate: false },
  );
  assert.equal(trusted, '{"id":"1","amount":{"currency":"USD","value":"1"},"note":"x"}');
  assert.throws(
    () => off.parsePayment('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"x"}', { validate: true }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
  assert.throws(
    () => off.stringifyPayment({ id: '1', amount: { currency: 'USD', value: '1' }, note: 'x' }, { validate: true }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
});

test('same-file nested IModel companions compile without naming the handwritten nested class unbound', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/same-file-nested-imodel-companions-compile-without-naming-the-handwritten-ne/money.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
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
  await compile(root);
});

test('nested class-typed IModel fields construct; type-only parse fills like IObject', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/nested-class-typed-imodel-fields-construct-type-only-parse-fills-like-iobjec/money.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  const generated = fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8');
  assert.doesNotMatch(generated, /from ['"]\.\/money\.model\.js['"]/);
  const pointId = generatedCodecId(generated, 'Point3D');
  assert.match(generated, new RegExp(`requireIModelClass\\("${pointId}"\\)`));
  await compile(root);
  const { registerIModelClass } = await import('@exprtlabs/golem/serde');
  const { Point3D } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Point3D: new (values?: object) => object;
  };
  registerIModelClass(pointId, Point3D);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    parseObjectTypeField: (text: string, options?: { validate?: boolean }) => { scale: object };
    parseObjectClassField: (text: string, options?: { validate?: boolean }) => { scale: object };
    fromWireFormatObjectClassField: (wire: unknown, options?: { validate?: boolean }) => { scale: object };
  };
  const wire = '{"id":"1","scale":{"x":1,"y":2,"z":3}}';
  const typedParsed = codecs.parseObjectTypeField(wire, { validate: false });
  assert.equal(Object.getPrototypeOf(typedParsed.scale), Object.prototype);
  assert.equal(Reflect.get(typedParsed.scale, 'x'), 1);
  const classified = codecs.fromWireFormatObjectClassField(JSON.parse(wire) as object, { validate: false });
  assert.ok(classified.scale instanceof Point3D);
});

test('type-only IModel parse fills nested models from the generated base', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/type-only-imodel-parse-fills-nested-models-from-the-generated-base/money.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  await compile(root);
  const { IsolatedPointBase } = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    IsolatedPointBase: new (values?: object) => object;
  };
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    parseObjectClassField: (text: string, options?: { validate?: boolean }) => { scale: object };
    fromWireFormatObjectClassField: (wire: unknown, options?: { validate?: boolean }) => { scale: object };
  };
  const parsed = codecs.parseObjectClassField('{"id":"1","scale":{"x":1,"y":2,"z":3}}', { validate: false });
  assert.ok(parsed.scale instanceof IsolatedPointBase);
  assert.equal(Reflect.get(parsed.scale, 'x'), 1);
  const constructed = codecs.fromWireFormatObjectClassField(
    { id: '1', scale: { x: 1, y: 2, z: 3 } },
    { validate: false },
  );
  assert.ok(constructed.scale instanceof IsolatedPointBase);
});

test('toWireFormat encodes nullable nested IModel fields to plain objects, not class instances', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/towireformat-encodes-nullable-nested-imodel-fields-to-plain-objects-not-clas/money.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await compile(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    fromWireFormatCustomer: (wire: unknown, options?: { validate?: boolean }) => { id: number; account: object | null };
    toWireFormatCustomer: (value: unknown, options?: { validate?: boolean }) => unknown;
  };
  const present = { id: 101, account: { id: 601, code: 'customer-account-601' } };
  const missing = { id: 101, account: null };
  const presentModel = codecs.fromWireFormatCustomer(present, { validate: false });
  const missingModel = codecs.fromWireFormatCustomer(missing, { validate: false });
  const presentWire = codecs.toWireFormatCustomer(presentModel, { validate: false }) as typeof present;
  const missingWire = codecs.toWireFormatCustomer(missingModel, { validate: false }) as typeof missing;
  assert.deepEqual(presentWire, present);
  assert.deepEqual(missingWire, missing);
  assert.equal(Object.getPrototypeOf(presentWire.account), Object.prototype);
});

test('fromWireFormat copies identity arrays and tuples instead of aliasing the input containers', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), readFixture("models/serde/fromwireformat-copies-identity-arrays-and-tuples-without-aliasing-input/money.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  await compile(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as {
    fromWireFormatMember: (wire: unknown, options?: { validate?: boolean }) => { emails: string[]; ip: [number, number, number, number] };
    toWireFormatMember: (value: unknown, options?: { validate?: boolean }) => { emails: string[]; ip: [number, number, number, number] };
  };
  const wire = { id: 1, emails: ['a@example.com', 'b@example.com'], ip: [127, 0, 0, 1] as [number, number, number, number] };
  const model = codecs.fromWireFormatMember(wire, { validate: false });
  assert.notEqual(model.emails, wire.emails);
  assert.deepEqual(model.emails, wire.emails);
  assert.notEqual(model.ip, wire.ip);
  assert.deepEqual(model.ip, wire.ip);
  const encoded = codecs.toWireFormatMember(model, { validate: false });
  assert.notEqual(encoded.emails, model.emails);
  assert.deepEqual(encoded.emails, wire.emails);
  assert.notEqual(encoded.ip, model.ip);
  assert.deepEqual(encoded.ip, wire.ip);
});
