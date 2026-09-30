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
} from '@exprtlabs/codegen/serde';
import { validate as publicValidate } from '@exprtlabs/codegen/validation';
import { IssueCode, IssueRepresentation, IssueSource, LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { generate } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import { command, ttscEnv, workspace } from './support/process.js';
import { generatedCodecId } from './support/consumer.js';
import type { CodegenProfile } from '@exprtlabs/codegen/generator-api';

function fixture(
  t: TestContext,
  profile: CodegenProfile = { mobx: false, validation: true },
) {
  const { root } = createModelProject(t, {
    prefix: 'runic-serde-',
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

function enableSerdePlugin(root: string): void {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.plugins = [{ transform: '@exprtlabs/codegen/ttsc-plugin' }];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
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

test('IObject stringify/parse compose nested Money by call and type-only parse stays IObject', async (t) => {
  const { root } = fixture(t);
  const generated = fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8');
  const paymentFnStart = generated.indexOf('function stringifyPayment');
  const paymentFnEnd = generated.indexOf('\n}', paymentFnStart);
  const paymentFn = generated.slice(paymentFnStart, paymentFnEnd);
  assert.match(paymentFn, /stringifyMoney\(/, 'one stringify function per interned node: Payment calls stringifyMoney instead of inlining its fields');
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

test('invalid JSON fails before Ajv and fail-fast reports the first nested field', async (t) => {
  const { root } = fixture(t);
  await compile(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/money.model.generated.js')).href) as PaymentCodecs;
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

test('IObject TSerde stringify/parse convert declared fields in one pass', async (t) => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'runic-serde-tserde-',
    name: 'serde-tserde',
    linkTypescript: true,
    linkTtsc: true,
  });
  fs.writeFileSync(path.join(sourceRoot, 'permission.model.ts'), readFixture("models/serde/iobject-tserde-stringify-parse-convert-declared-fields-in-one-pass/permission.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const generated = fs.readFileSync(path.join(root, 'src/permission.model.generated.ts'), 'utf8');
  assert.doesNotMatch(
    generated,
    /stringifyPermissionInputCore[\s\S]*__runicSerialize[\s\S]*validatePermissionInputFast/,
    'budget: TSerde fields convert declared fields in one pass, not through a second interleaved stringify/validate sequence',
  );
  await compile(root);
  const permissionModule = await import(pathToFileURL(path.join(root, 'build/permission.model.js')).href) as {
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
  const beforeInvalid = permissionModule.deserializeCalls;
  assert.throws(
    () => codecs.parsePermissionInput('{"permissions":"nope"}'),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Wire,
  );
  assert.equal(permissionModule.deserializeCalls, beforeInvalid);
  assert.throws(
    () => codecs.parsePermission('{"permissions":"0x100"}', { construct: Permission }),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.issues[0]?.representation === IssueRepresentation.Model,
  );
  assert.ok(permissionModule.deserializeCalls > beforeInvalid);
  const trusted = codecs.parsePermissionInput('{"permissions":"nope"}', { validate: false });
  assert.ok(trusted.permissions === Number.parseInt('nope', 16) || Number.isNaN(trusted.permissions));
});

test('validate<T> type predicate narrows to IObject fields for IModel and IObject', async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/narrow.ts'), readFixture("models/serde/validate-t-type-predicate-narrows-to-iobject-fields-for-imodel-and-iobject/narrow.ts"));
  await compile(root);
});

test('same-type TSerde emits one Ajv schema and global validation false rejects { validate: true }', async (t) => {
  const { root: identityRoot, sourceRoot } = createModelProject(t, {
    prefix: 'runic-serde-identity-',
    name: 'serde-identity',
    linkTypescript: true,
    linkTtsc: true,
  });
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

test('ttsc plugin rewrites stringify<TMoney> to the generated codec', async (t) => {
  const { root } = fixture(t);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.plugins = [{ transform: '@exprtlabs/codegen/ttsc-plugin' }];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  fs.writeFileSync(path.join(root, 'src/use-stringify.ts'), readFixture("models/serde/ttsc-plugin-rewrites-stringify-tmoney-to-the-generated-codec/use-stringify.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-stringify.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("Money_[0-9a-f]{8}"\)\.stringify\(/);
  assert.doesNotMatch(emitted, /construct:/);
  const { text } = await import(pathToFileURL(path.join(root, 'build/use-stringify.js')).href) as { text: string };
  assert.equal(text, '{"currency":"USD","value":"1"}');
});

test('ttsc plugin rewrites parse<Payment> to construct the handwritten class', async (t) => {
  const { root } = fixture(t);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.plugins = [{ transform: '@exprtlabs/codegen/ttsc-plugin' }];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  fs.writeFileSync(path.join(root, 'src/use-parse-class.ts'), readFixture("models/serde/ttsc-plugin-rewrites-parse-payment-to-construct-the-handwritten-class/use-parse-class.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-parse-class.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("Payment_[0-9a-f]{8}"\)\.parse\([^;]+construct: Payment/);
  assert.match(emitted, /\.\.\.\{ validate: false \}, construct: Payment/);
  assert.doesNotMatch(emitted.split('typed')[1]?.split('\n')[0] ?? '', /construct:/);
  const modelJs = fs.readFileSync(path.join(root, 'build/money.model.js'), 'utf8');
  assert.match(modelJs, /registerIModelClass\("Payment_[0-9a-f]{8}", Payment\)/);
  const { parsed, trusted, typed, wrapped, wire } = await import(pathToFileURL(path.join(root, 'build/use-parse-class.js')).href) as {
    parsed: object;
    trusted: object;
    typed: object;
    wrapped: object;
    wire: object;
  };
  const { Payment } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Payment: new (values?: object) => object;
  };
  assert.ok(parsed instanceof Payment);
  assert.ok(trusted instanceof Payment);
  assert.equal(Object.getPrototypeOf(typed), Object.prototype);
  assert.ok(wrapped instanceof Payment);
  assert.ok(wire instanceof Payment);
});

test('ttsc plugin does not rewrite validation validate between fromWireFormat<T> calls', async (t) => {
  const { root } = fixture(t);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.plugins = [{ transform: '@exprtlabs/codegen/ttsc-plugin' }];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  fs.writeFileSync(path.join(root, 'src/use-from-wire.ts'), readFixture("models/serde/ttsc-plugin-does-not-rewrite-validation-validate-between-fromwireformat-t-ca/use-from-wire.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-from-wire.js'), 'utf8');
  assert.equal([...emitted.matchAll(/requireObjectCodec\("Money_[0-9a-f]{8}"\)\.fromWireFormat\(/g)].length, 2);
  assert.match(emitted, /validateInstance\(value\)/);
  assert.doesNotMatch(emitted, /requireObjectCodec\("Money_[0-9a-f]{8}"\)\.validate\(/);
  const { first, second } = await import(pathToFileURL(path.join(root, 'build/use-from-wire.js')).href) as {
    first: { currency: string; value: string };
    second: { currency: string; value: string };
  };
  assert.equal(first.currency, 'USD');
  assert.equal(second.currency, 'EUR');
});

test('ttsc plugin resolves OpenAPI codecs through modular SDK facades without crossing SDK identities', async (t) => {
  const { root } = fixture(t, { mobx: false, validation: false });
  const writeGeneratedSdk = (sdkName: string, property: string, type: 'number' | 'string'): string => {
    const output = path.join(root, sdkName);
    const generated = writeSdk({
      openapi: '3.1.0',
      info: { title: sdkName, version: '1' },
      components: {
        schemas: {
          Money: {
            type: 'object',
            required: [property],
            properties: { [property]: { type } },
          },
        },
      },
    }, { output, name: sdkName, profile: { mobx: false, validation: false } });
    writeGeneratedArtifacts(generated.artifacts);
    const keys = fs.readFileSync(path.join(output, 'iobject-plugin-keys.ts'), 'utf8');
    assert.doesNotMatch(keys, /"models\.ts#/);
    assert.match(keys, /"models\/_group-[0-9a-f]{8}\.ts#MoneyModel": "Money_[0-9a-f]{8}"/);
    return keys;
  };

  const firstKeys = writeGeneratedSdk('sdk-first', 'cents', 'number');
  const secondKeys = writeGeneratedSdk('sdk-second', 'code', 'string');
  const firstId = firstKeys.match(/"models\/_group-[0-9a-f]{8}\.ts#MoneyModel": "(Money_[0-9a-f]{8})"/)?.[1];
  const secondId = secondKeys.match(/"models\/_group-[0-9a-f]{8}\.ts#MoneyModel": "(Money_[0-9a-f]{8})"/)?.[1];
  assert.ok(firstId);
  assert.ok(secondId);
  assert.notEqual(firstId, secondId);

  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.rootDir = '.';
  tsconfig.include = ['src/**/*.ts', 'sdk-first/**/*.ts', 'sdk-second/**/*.ts'];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-openapi-codecs.ts'), readFixture("models/serde/ttsc-plugin-resolves-openapi-codecs-through-modular-sdk-facades-without-cros/use-openapi-codecs.ts"));

  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/src/use-openapi-codecs.js'), 'utf8');
  assert.match(emitted, new RegExp(`requireObjectCodec\\("${firstId}"\\)\\.fromWireFormat`));
  assert.match(emitted, new RegExp(`requireObjectCodec\\("${secondId}"\\)\\.fromWireFormat`));
  assert.match(emitted, /import \{ MoneyModel as FirstMoneyModel \} from ['"]\.\.\/sdk-first\/index\.js['"]/);
  assert.match(emitted, /construct: FirstMoneyModel/);
  assert.match(emitted, /construct: SecondSdk\.MoneyModel/);
  assert.doesNotMatch(emitted, /fromWireFormat<FirstMoneyModel>|fromWireFormat<SecondSdk\.MoneyModel>/);

  const [firstSdk, secondSdk, consumer] = await Promise.all([
    import(pathToFileURL(path.join(root, 'build/sdk-first/index.js')).href) as Promise<{
      MoneyModel: new (values?: object) => { cents: number };
    }>,
    import(pathToFileURL(path.join(root, 'build/sdk-second/index.js')).href) as Promise<{
      MoneyModel: new (values?: object) => { code: string };
    }>,
    import(pathToFileURL(path.join(root, 'build/src/use-openapi-codecs.js')).href) as Promise<{
      first: { cents: number };
      second: { code: string };
    }>,
  ]);
  assert.ok(consumer.first instanceof firstSdk.MoneyModel);
  assert.ok(consumer.second instanceof secondSdk.MoneyModel);
  assert.equal(consumer.first.cents, 3);
  assert.equal(consumer.second.code, 'USD');
  assert.equal(consumer.first instanceof secondSdk.MoneyModel, false);
  assert.equal(consumer.second instanceof firstSdk.MoneyModel, false);
});

test('ttsc plugin resolves OpenAPI codecs for schemas whose class names carry the Model suffix', async (t) => {
  const { root } = fixture(t, { mobx: false, validation: false });
  const object = (property: string, type: string) => ({ type: 'object', required: [property], properties: { [property]: { type } } });
  const generated = writeSdk({
    openapi: '3.1.0',
    info: { title: 'Suffixed', version: '1' },
    components: {
      schemas: {
        PaymentModel: object('id', 'string'),
        TPayment: object('amount', 'number'),
        'Pay$ment': object('flag', 'boolean'),
        Money: object('cents', 'number'),
      },
    },
  }, { output: path.join(root, 'sdk'), name: 'Suffixed', profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(generated.artifacts);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.rootDir = '.';
  tsconfig.include = ['src/**/*.ts', 'sdk/**/*.ts'];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-suffixed.ts'), `import { fromWireFormat, parse, stringify } from '@exprtlabs/codegen/serde';
import type { MoneyModel, PaymentModelModel, Pay$mentModel, TPaymentModel } from '../sdk/index.js';
export const payment = fromWireFormat<PaymentModelModel>({ id: 'a' });
export const tpayment = fromWireFormat<TPaymentModel>({ amount: 3 });
export const dollar = fromWireFormat<Pay$mentModel>({ flag: true });
export const money = fromWireFormat<MoneyModel>({ cents: 5 });
export const texts = [stringify<PaymentModelModel>(payment), stringify<TPaymentModel>(tpayment), stringify<Pay$mentModel>(dollar), stringify<MoneyModel>(money)];
export const parsed = [parse<PaymentModelModel>(texts[0]!), parse<TPaymentModel>(texts[1]!), parse<Pay$mentModel>(texts[2]!), parse<MoneyModel>(texts[3]!)];
`);
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/src/use-suffixed.js'), 'utf8');
  assert.doesNotMatch(emitted, /fromWireFormat<|stringify<|parse</);
  const ids = [...emitted.matchAll(/requireObjectCodec\("([A-Za-z_$]+_[0-9a-f]{8})"\)\.fromWireFormat/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, 4, 'each call resolves to its own codec');

  const sdk = await import(pathToFileURL(path.join(root, 'build/sdk/index.js')).href) as Record<string, new () => object>;
  const consumer = await import(pathToFileURL(path.join(root, 'build/src/use-suffixed.js')).href) as {
    payment: object; tpayment: object; dollar: object; money: object; texts: string[]; parsed: object[];
  };
  assert.ok(consumer.payment instanceof sdk.PaymentModelModel);
  assert.ok(consumer.tpayment instanceof sdk.TPaymentModel);
  assert.ok(consumer.dollar instanceof sdk['Pay$mentModel']!);
  assert.ok(consumer.money instanceof sdk.MoneyModel);
  assert.deepEqual(consumer.texts.map((text) => JSON.parse(text) as unknown), [{ id: 'a' }, { amount: 3 }, { flag: true }, { cents: 5 }]);
  assert.deepEqual(consumer.parsed.map((item) => JSON.parse(JSON.stringify(item)) as unknown), [{ id: 'a' }, { amount: 3 }, { flag: true }, { cents: 5 }]);
});

test('ttsc plugin ignores a comment and string that look like serde calls', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-comment.ts'), readFixture("models/serde/ttsc-plugin-ignores-a-comment-and-string-that-look-like-serde-calls/use-comment.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-comment.js'), 'utf8');
  assert.match(emitted, /parse<Foo>\(/);
  assert.match(emitted, /requireObjectCodec\("Money_[0-9a-f]{8}"\)\.stringify\(/);
  const { text } = await import(pathToFileURL(path.join(root, 'build/use-comment.js')).href) as { text: string };
  assert.equal(text, '{"currency":"USD","value":"1"}');
});

test('ttsc plugin compiles classes that extend non-generated bases next to serde calls', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/ns.ts'), 'export class Thing { readonly kind = "thing"; }\n');
  fs.writeFileSync(path.join(root, 'src/use-heritage.ts'), `import { parse, stringify } from '@exprtlabs/codegen/serde';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import * as ns from './ns.js';
import { Payment, type TMoney } from './money.model.js';
function Mixin<T extends new (...args: any[]) => object>(Target: T) { return class extends Target { readonly mixed = true; }; }
class Base {}
export class A extends Error {}
export class B extends ns.Thing {}
export class C extends Mixin(Base) {}
export class D extends LibError {}
export const errorName = new A('x') instanceof Error;
export const kind = new B().kind;
export const mixed = new C().mixed;
export const libError = new D(LibErrorKind.Validation, 'bad') instanceof LibError;
export const text = stringify<TMoney>({ currency: 'USD', value: '1' });
export const payment = parse<Payment>('{"id":"p","amount":{"currency":"USD","value":"1"},"note":"n"}');
export const isPayment = payment instanceof Payment;
`);
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-heritage.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("Money_[0-9a-f]{8}"\)\.stringify\(/);
  assert.match(emitted, /requireObjectCodec\("Payment_[0-9a-f]{8}"\)\.parse\([\s\S]*construct: Payment/);
  const module = await import(pathToFileURL(path.join(root, 'build/use-heritage.js')).href) as Record<string, unknown>;
  assert.deepEqual(
    [module.errorName, module.kind, module.mixed, module.libError, module.text, module.isPayment],
    [true, 'thing', true, true, '{"currency":"USD","value":"1"}', true],
  );
});

test('a serde call behind a type-only import names the model and the generated file to import', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-type-only.ts'), `import { parse } from '@exprtlabs/codegen/serde';
import type { TPayment } from './money.model.js';
export function run(): unknown { return parse<TPayment>('{"id":"p","amount":{"currency":"USD","value":"1"},"note":"n"}'); }
`);
  await compile(root);
  // A fresh process: nothing else has loaded the companion that registers the codec.
  const probe = `import(${JSON.stringify(pathToFileURL(path.join(root, 'build/use-type-only.js')).href)}).then((m) => m.run()).catch((error) => { console.log(JSON.stringify({ kind: error.kind, message: error.message })); });`;
  const result = await command(root, process.execPath, ['--input-type=module', '-e', probe]);
  const failure = JSON.parse(result.stdout.trim()) as { kind: string; message: string };
  assert.equal(failure.kind, LibErrorKind.ValidationUnavailable);
  assert.match(failure.message, /IObject codec "Payment_[0-9a-f]{8}" for model Payment is not registered\./);
  assert.match(failure.message, /type-only import such as `import type \{ TPayment \}` does not load it/);
  assert.match(failure.message, /\.model\.generated\.js/);
  assert.match(failure.message, /Import the model's \.model\.generated\.js file, or a value from its model file,/);
  assert.doesNotMatch(failure.message, /companion/i);
});

test('ttsc plugin rewrites a serde call whose type argument is split across lines', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-multiline.ts'), readFixture("models/serde/ttsc-plugin-rewrites-a-serde-call-whose-type-argument-is-split-across-lines/use-multiline.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-multiline.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("Money_[0-9a-f]{8}"\)\.stringify\(/);
  const { text } = await import(pathToFileURL(path.join(root, 'build/use-multiline.js')).href) as { text: string };
  assert.equal(text, '{"currency":"USD","value":"1"}');
});

test('ttsc plugin rewrites a qualified type argument that resolves to one model', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-qualified.ts'), readFixture("models/serde/ttsc-plugin-rewrites-a-qualified-type-argument-that-resolves-to-one-model/use-qualified.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-qualified.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("Money_[0-9a-f]{8}"\)\.stringify\(/);
  const { text } = await import(pathToFileURL(path.join(root, 'build/use-qualified.js')).href) as { text: string };
  assert.equal(text, '{"currency":"USD","value":"1"}');
});

test('ttsc plugin reports a source span for an unsupported serde type argument', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-unsupported.ts'), readFixture("models/serde/ttsc-plugin-reports-a-source-span-for-an-unsupported-serde-type-argument/use-unsupported.ts"));
  const result = await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ], { allowFailure: true, env: { NODE_PATH: path.join(workspace, 'node_modules') } });
  assert.notEqual(result.code, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /src\/use-unsupported\.ts:\d+:\d+:/);
  assert.match(output, /stringify type argument must be a single type name or typeof expression/);
  assert.equal(fs.existsSync(path.join(root, 'build/use-unsupported.js')), false);
});

test('ttsc plugin leaves an earlier unrelated parse call in the emitted JavaScript', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-unrelated-parse.ts'), readFixture("models/serde/ttsc-plugin-leaves-an-earlier-unrelated-parse-call-in-the-emitted-javascript/use-unrelated-parse.ts"));
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, 'build/use-unrelated-parse.js'), 'utf8');
  const kept = emitted.indexOf("parse('plain')");
  const rewritten = emitted.search(/requireObjectCodec\("Payment_[0-9a-f]{8}"\)\.parse\(/);
  assert.ok(kept >= 0, emitted);
  assert.ok(rewritten > kept, emitted);
  const loaded = await import(pathToFileURL(path.join(root, 'build/use-unrelated-parse.js')).href) as {
    parse: (value: string) => string;
    kept: string;
    parsed: object;
  };
  assert.equal(loaded.kept, 'plain');
  assert.equal(loaded.parse('plain'), 'plain');
  const { Payment } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Payment: new (values?: object) => object;
  };
  assert.ok(loaded.parsed instanceof Payment);
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
  const { Collection, Item } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as {
    Collection: new (values?: object) => object;
    Item: new (values?: object) => object;
  };
  assert.ok(new Collection({ id: '1', items: [new Item({ sku: 'a', quantity: 1 })] }) instanceof Collection);
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
  const { registerIModelClass } = await import('@exprtlabs/codegen/serde');
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
