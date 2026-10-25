import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { codecPublicId } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { command, golem, workspace } from './support/process.js';

const shape: ModelTypeDescriptor = {
  kind: 'object',
  properties: { id: { kind: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

test('the same shape gets different ids for a plain object and a class', () => {
  assert.notEqual(
    codecPublicId('Payment', shape, undefined, { source: 'typescript', constructs: false }),
    codecPublicId('Payment', shape, undefined, { source: 'typescript', constructs: true }),
  );
});

test('the same shape gets different ids from TypeScript and OpenAPI sources', () => {
  assert.notEqual(
    codecPublicId('Payment', shape, undefined, { source: 'typescript', constructs: true }),
    codecPublicId('Payment', shape, undefined, { source: 'openapi', constructs: true }),
  );
});

const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Identity', version: '1' },
  paths: {
    '/money': {
      get: {
        operationId: 'getMoney',
        responses: { '200': { description: 'Money', content: { 'application/json': { schema: { $ref: '#/components/schemas/Money' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Money: {
        type: 'object',
        required: ['amount', 'currency'],
        additionalProperties: false,
        properties: { amount: { type: 'string' }, currency: { type: 'string' } },
      },
    },
  },
};

const registerBoth = (order: readonly string[]): string => `
  ${order.map((file) => `await import('./build/${file}');`).join('\n  ')}
  const { getObjectCodec } = await import('@exprtlabs/golem/serde');
  const codec = (id) => getObjectCodec(id)?.issueSource;
  console.log(JSON.stringify({ hand: codec(process.argv[1]), sdk: codec(process.argv[2]) }));
`;

test('a hand-written and an SDK model of the same name and shape keep their own codec in either import order', async (t) => {
  const root = createFixtureProject(t, 'golem-codec-identity-');
  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"codec-identity-fixture","type":"module"}');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify(openApiDocument));
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    '',
    'export type TMoney = IModel<{ amount: string; currency: string }>;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'golem.yaml'), [
    'version: 1', 'mobx: false', 'validation: true', 'openapi:', '  - input: api.json', '    output: sdk', '    name: Identity', 'models:', '  root: .', '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));

  const keyOf = (file: string, key: RegExp): string => {
    const match = fs.readFileSync(path.join(root, file), 'utf8').match(key);
    assert.ok(match, `${file} names the Money codec`);
    return match[1];
  };
  const handId = keyOf('.golem/codec-keys.json', /#TMoney": "(TMoney_[0-9a-f]{8})"/);
  const sdkId = keyOf('sdk/model-manifest.json', /"codecId": "(Money_[0-9a-f]{8})"/);
  assert.notEqual(handId, sdkId);

  await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  for (const order of [['sdk/index.js', 'src/money.model.generated.js'], ['src/money.model.generated.js', 'sdk/index.js']]) {
    const run = await command(root, process.execPath, ['--input-type=module', '-e', registerBoth(order), handId, sdkId]);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { hand: 'typescript', sdk: 'openapi' }, order.join(' then '));
  }
});

test('a model that nests an SDK model with validation off resolves its schema reference by the codec id of the SDK model', async (t) => {
  // protects: T-444 the schema placeholder names the codec id, so the exact-id lookup finds the SDK codec
  const root = createFixtureProject(t, 'golem-codec-schema-ref-');
  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"codec-schema-ref-fixture","type":"module"}');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify(openApiDocument));
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/cart.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Money } from '../sdk/index.js';",
    '',
    'export type TCart = IModel<{ money: Money }>;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'golem.yaml'), [
    'version: 1', 'mobx: false', 'validation: false', 'openapi:', '  - input: api.json', '    output: sdk', '    name: Identity', 'models:', '  root: .', '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));
  const cartId = (JSON.parse(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8')) as { keys: Record<string, string> }).keys['src/cart.model.ts#TCart'];
  const moneyId = (JSON.parse(fs.readFileSync(path.join(root, 'sdk/model-manifest.json'), 'utf8')) as { models: { codecId: string }[] }).models[0]!.codecId;
  await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  const script = `
    await import('./build/src/cart.model.generated.js');
    const { getObjectCodec } = await import('@exprtlabs/golem/serde');
    console.log(JSON.stringify(getObjectCodec(process.argv[1]).schema.properties.money));`;
  const run = await command(root, process.execPath, ['--input-type=module', '-e', script, cartId]);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { $ref: moneyId });
});
