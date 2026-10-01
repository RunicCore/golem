import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';

import { LibErrorKind } from '@exprtlabs/golem/errors';
import { generate } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import { command, ttscEnv, workspace } from './support/process.js';
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

function enableSerdePlugin(root: string): void {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.plugins = [{ transform: '@exprtlabs/golem/ttsc-plugin' }];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
}


test('ttsc plugin rewrites serde calls in one project compiled once', async (t) => {
  const { root } = fixture(t);
  enableSerdePlugin(root);
  const write = (file: string, text: string): void => fs.writeFileSync(path.join(root, 'src', file), text);
  write('use-stringify.ts', readFixture("models/serde/ttsc-plugin-rewrites-stringify-tmoney-to-the-generated-codec/use-stringify.ts"));
  write('use-parse-class.ts', readFixture("models/serde/ttsc-plugin-rewrites-parse-payment-to-construct-the-handwritten-class/use-parse-class.ts"));
  write('use-from-wire.ts', readFixture("models/serde/ttsc-plugin-does-not-rewrite-validation-validate-between-fromwireformat-t-ca/use-from-wire.ts"));
  write('use-comment.ts', readFixture("models/serde/ttsc-plugin-ignores-a-comment-and-string-that-look-like-serde-calls/use-comment.ts"));
  write('ns.ts', 'export class Thing { readonly kind = "thing"; }\n');
  write('use-heritage.ts', `import { parse, stringify } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
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
  write('use-type-only.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { TPayment } from './money.model.js';
export function run(): unknown { return parse<TPayment>('{"id":"p","amount":{"currency":"USD","value":"1"},"note":"n"}'); }
`);
  write('use-multiline.ts', readFixture("models/serde/ttsc-plugin-rewrites-a-serde-call-whose-type-argument-is-split-across-lines/use-multiline.ts"));
  write('use-qualified.ts', readFixture("models/serde/ttsc-plugin-rewrites-a-qualified-type-argument-that-resolves-to-one-model/use-qualified.ts"));
  write('use-unrelated-parse.ts', readFixture("models/serde/ttsc-plugin-leaves-an-earlier-unrelated-parse-call-in-the-emitted-javascript/use-unrelated-parse.ts"));
  await compile(root);
  const emittedOf = (file: string): string => fs.readFileSync(path.join(root, 'build', file), 'utf8');
  const importBuilt = (file: string): Promise<unknown> => import(pathToFileURL(path.join(root, 'build', file)).href);

  await t.test('ttsc plugin rewrites stringify<TMoney> to the generated codec', async () => {
    const emitted = emittedOf('use-stringify.js');
    assert.match(emitted, /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
    assert.doesNotMatch(emitted, /construct:/);
    const { text } = await importBuilt('use-stringify.js') as { text: string };
    assert.equal(text, '{"currency":"USD","value":"1"}');
  });

  await t.test('ttsc plugin rewrites parse<Payment> to construct the handwritten class', async () => {
    const emitted = emittedOf('use-parse-class.js');
    assert.match(emitted, /requireObjectCodec\("TPayment_[0-9a-f]{8}"\)\.parse\([^;]+construct: Payment/);
    assert.match(emitted, /\.\.\.\{ validate: false \}, construct: Payment/);
    assert.doesNotMatch(emitted.split('typed')[1]?.split('\n')[0] ?? '', /construct:/);
    const modelJs = emittedOf('money.model.js');
    assert.match(modelJs, /registerIModelClass\("TPayment_[0-9a-f]{8}", Payment\)/);
    const { parsed, trusted, typed, wrapped, wire } = await importBuilt('use-parse-class.js') as {
      parsed: object;
      trusted: object;
      typed: object;
      wrapped: object;
      wire: object;
    };
    const { Payment } = await importBuilt('money.model.js') as {
      Payment: new (values?: object) => object;
    };
    assert.ok(parsed instanceof Payment);
    assert.ok(trusted instanceof Payment);
    assert.equal(Object.getPrototypeOf(typed), Object.prototype);
    assert.ok(wrapped instanceof Payment);
    assert.ok(wire instanceof Payment);
  });

  await t.test('ttsc plugin does not rewrite validation validate between fromWireFormat<T> calls', async () => {
    const emitted = emittedOf('use-from-wire.js');
    assert.equal([...emitted.matchAll(/requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.fromWireFormat\(/g)].length, 2);
    assert.match(emitted, /validateInstance\(value\)/);
    assert.doesNotMatch(emitted, /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.validate\(/);
    const { first, second } = await importBuilt('use-from-wire.js') as {
      first: { currency: string; value: string };
      second: { currency: string; value: string };
    };
    assert.equal(first.currency, 'USD');
    assert.equal(second.currency, 'EUR');
  });

  await t.test('ttsc plugin ignores a comment and string that look like serde calls', async () => {
    const emitted = emittedOf('use-comment.js');
    assert.match(emitted, /parse<Foo>\(/);
    assert.match(emitted, /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
    const { text } = await importBuilt('use-comment.js') as { text: string };
    assert.equal(text, '{"currency":"USD","value":"1"}');
  });

  await t.test('ttsc plugin compiles classes that extend non-generated bases next to serde calls', async () => {
    const emitted = emittedOf('use-heritage.js');
    assert.match(emitted, /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
    assert.match(emitted, /requireObjectCodec\("TPayment_[0-9a-f]{8}"\)\.parse\([\s\S]*construct: Payment/);
    const module = await importBuilt('use-heritage.js') as Record<string, unknown>;
    assert.deepEqual(
      [module.errorName, module.kind, module.mixed, module.libError, module.text, module.isPayment],
      [true, 'thing', true, true, '{"currency":"USD","value":"1"}', true],
    );
  });

  await t.test('a serde call behind a type-only import names the model and the generated file to import', async () => {
    // A fresh process: nothing else has loaded the companion that registers the codec.
    const probe = `import(${JSON.stringify(pathToFileURL(path.join(root, 'build/use-type-only.js')).href)}).then((m) => m.run()).catch((error) => { console.log(JSON.stringify({ kind: error.kind, message: error.message })); });`;
    const result = await command(root, process.execPath, ['--input-type=module', '-e', probe]);
    const failure = JSON.parse(result.stdout.trim()) as { kind: string; message: string };
    assert.equal(failure.kind, LibErrorKind.ValidationUnavailable);
    assert.match(failure.message, /IObject codec "TPayment_[0-9a-f]{8}" for model TPayment is not registered\./);
    assert.match(failure.message, /type-only import such as `import type \{ TPayment \}` does not load it/);
    assert.match(failure.message, /\.model\.generated\.js/);
    assert.match(failure.message, /Import the model's \.model\.generated\.js file, or a value from its model file,/);
    assert.doesNotMatch(failure.message, /companion/i);
  });

  await t.test('ttsc plugin rewrites a serde call whose type argument is split across lines', async () => {
    assert.match(emittedOf('use-multiline.js'), /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
    const { text } = await importBuilt('use-multiline.js') as { text: string };
    assert.equal(text, '{"currency":"USD","value":"1"}');
  });

  await t.test('ttsc plugin rewrites a qualified type argument that resolves to one model', async () => {
    assert.match(emittedOf('use-qualified.js'), /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
    const { text } = await importBuilt('use-qualified.js') as { text: string };
    assert.equal(text, '{"currency":"USD","value":"1"}');
  });

  await t.test('ttsc plugin leaves an earlier unrelated parse call in the emitted JavaScript', async () => {
    const emitted = emittedOf('use-unrelated-parse.js');
    const kept = emitted.indexOf("parse('plain')");
    const rewritten = emitted.search(/requireObjectCodec\("TPayment_[0-9a-f]{8}"\)\.parse\(/);
    assert.ok(kept >= 0, emitted);
    assert.ok(rewritten > kept, emitted);
    const loaded = await importBuilt('use-unrelated-parse.js') as {
      parse: (value: string) => string;
      kept: string;
      parsed: object;
    };
    assert.equal(loaded.kept, 'plain');
    assert.equal(loaded.parse('plain'), 'plain');
    const { Payment } = await importBuilt('money.model.js') as {
      Payment: new (values?: object) => object;
    };
    assert.ok(loaded.parsed instanceof Payment);
  });
});

test('ttsc plugin links a class to its model through extends when the class name differs from the alias', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-serde-',
    name: 'serde-class-link',
    linkTypescript: true,
    linkTtsc: true,
  });
  const fixtureDirectory = 'models/serde/a-class-named-apart-from-its-alias-registers-and-parses';
  copyFixtureFile(root, `${fixtureDirectory}/order.model.ts`, 'src/order.model.ts');
  copyFixtureFile(root, `${fixtureDirectory}/use-order.ts`, 'src/use-order.ts');
  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(artifacts);
  const keys = artifacts.find((artifact) => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
  assert.match(keys, /order\.model\.ts#TOrder": "TOrder_[0-9a-f]{8}"/);
  assert.match(keys, /order\.model\.ts#PurchaseOrder": "TOrder_[0-9a-f]{8}"/);
  assert.doesNotMatch(keys, /#RushOrder/, 'a subclass of the model class is not the model class');
  enableSerdePlugin(root);
  await compile(root);
  const emittedOf = (file: string): string => fs.readFileSync(path.join(root, 'build', file), 'utf8');
  assert.match(emittedOf('order.model.js'), /registerIModelClass\("TOrder_[0-9a-f]{8}", PurchaseOrder\)/);
  assert.match(emittedOf('use-order.js'), /requireObjectCodec\("TOrder_[0-9a-f]{8}"\)\.parse\([^;]+construct: PurchaseOrder/);
  const { PurchaseOrder } = await import(pathToFileURL(path.join(root, 'build/order.model.js')).href) as {
    PurchaseOrder: new (values?: object) => object;
  };
  const { order } = await import(pathToFileURL(path.join(root, 'build/use-order.js')).href) as { order: object };
  assert.ok(order instanceof PurchaseOrder);
  assert.deepEqual({ ...order }, { id: 'o-1', total: 3 });
});

test('every class that extends a generated base links to its model and parses to itself', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-serde-', name: 'serde-class-link-many', linkTypescript: true, linkTtsc: true });
  const directory = 'models/serde/two-classes-link-to-one-model';
  copyFixtureFile(root, `${directory}/payment.model.ts`, 'src/payment.model.ts');
  copyFixtureFile(root, `${directory}/use-payment.ts`, 'src/use-payment.ts');
  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(artifacts);
  const keys = artifacts.find((artifact) => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
  for (const name of ['TPayment', 'Payment', 'AdminPayment']) {
    assert.match(keys, new RegExp(`payment\\.model\\.ts#${name}": "TPayment_[0-9a-f]{8}"`), `${name} has a key`);
  }
  assert.doesNotMatch(keys, /#RushPayment/, 'a subclass of a linked class is not linked');
  enableSerdePlugin(root);
  await compile(root);
  const emittedModel = fs.readFileSync(path.join(root, 'build/payment.model.js'), 'utf8');
  assert.match(emittedModel, /registerIModelClass\("TPayment_[0-9a-f]{8}#Payment", Payment\)/);
  assert.match(emittedModel, /registerIModelClass\("TPayment_[0-9a-f]{8}#AdminPayment", AdminPayment\)/);
  assert.doesNotMatch(emittedModel, /registerIModelClass\("TPayment_[0-9a-f]{8}", /, 'a model with several classes has no default class');
  const load = (file: string): Promise<Record<string, unknown>> => import(pathToFileURL(path.join(root, 'build', file)).href) as Promise<Record<string, unknown>>;
  const models = await load('payment.model.js') as { Payment: new () => object; AdminPayment: new () => object };
  const used = await load('use-payment.js') as { plain: object; admin: object; ledger: { first: object; second: object; third: object }; base: new () => object };
  assert.ok(used.plain instanceof models.Payment && !(used.plain instanceof models.AdminPayment));
  assert.ok(used.admin instanceof models.AdminPayment && !(used.admin instanceof models.Payment));
  assert.ok(used.ledger.first instanceof models.Payment && !(used.ledger.first instanceof models.AdminPayment), 'a field typed by one class constructs it');
  assert.ok(used.ledger.second instanceof models.AdminPayment, 'a field typed by the other class constructs that one');
  assert.ok(used.ledger.third instanceof used.base, 'a field typed by the alias constructs the generated base');
  assert.ok(!(used.ledger.third instanceof models.Payment) && !(used.ledger.third instanceof models.AdminPayment));
});

test('ttsc plugin resolves OpenAPI codecs through SDK facades without crossing SDK identities and for Model-suffixed class names', async (t) => {
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

  // A third SDK whose class names carry the Model suffix. Its Money has its own shape: an SDK Money identical to
  // sdk-first's would share its codec id and break the SDK identity checks below.
  const object = (property: string, type: string) => ({ type: 'object', required: [property], properties: { [property]: { type } } });
  const suffixed = writeSdk({
    openapi: '3.1.0',
    info: { title: 'Suffixed', version: '1' },
    components: {
      schemas: {
        PaymentModel: object('id', 'string'),
        TPayment: object('amount', 'number'),
        'Pay$ment': object('flag', 'boolean'),
        Money: object('units', 'integer'),
      },
    },
  }, { output: path.join(root, 'sdk'), name: 'Suffixed', profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(suffixed.artifacts);

  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.rootDir = '.';
  tsconfig.include = ['src/**/*.ts', 'sdk-first/**/*.ts', 'sdk-second/**/*.ts', 'sdk/**/*.ts'];
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  enableSerdePlugin(root);
  fs.writeFileSync(path.join(root, 'src/use-openapi-codecs.ts'), readFixture("models/serde/ttsc-plugin-resolves-openapi-codecs-through-modular-sdk-facades-without-cros/use-openapi-codecs.ts"));
  fs.writeFileSync(path.join(root, 'src/use-suffixed.ts'), `import { fromWireFormat, parse, stringify } from '@exprtlabs/golem/serde';
import type { MoneyModel, PaymentModelModel, Pay$mentModel, TPaymentModel } from '../sdk/index.js';
export const payment = fromWireFormat<PaymentModelModel>({ id: 'a' });
export const tpayment = fromWireFormat<TPaymentModel>({ amount: 3 });
export const dollar = fromWireFormat<Pay$mentModel>({ flag: true });
export const money = fromWireFormat<MoneyModel>({ units: 5 });
export const texts = [stringify<PaymentModelModel>(payment), stringify<TPaymentModel>(tpayment), stringify<Pay$mentModel>(dollar), stringify<MoneyModel>(money)];
export const parsed = [parse<PaymentModelModel>(texts[0]!), parse<TPaymentModel>(texts[1]!), parse<Pay$mentModel>(texts[2]!), parse<MoneyModel>(texts[3]!)];
`);

  await compile(root);

  await t.test('OpenAPI codecs resolve through modular SDK facades without crossing SDK identities', async () => {
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

  await t.test('OpenAPI codecs resolve for schemas whose class names carry the Model suffix', async () => {
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
    assert.deepEqual(consumer.texts.map((text) => JSON.parse(text) as unknown), [{ id: 'a' }, { amount: 3 }, { flag: true }, { units: 5 }]);
    assert.deepEqual(consumer.parsed.map((item) => JSON.parse(JSON.stringify(item)) as unknown), [{ id: 'a' }, { amount: 3 }, { flag: true }, { units: 5 }]);
  });
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
