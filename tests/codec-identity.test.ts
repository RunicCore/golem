import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { codecPublicId } from '@exprtlabs/codegen/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/codegen/model';
import { runPipeline } from '#codegen/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { command, workspace } from './packed/helpers.js';
import { tscBin } from './openapi/helpers.js';

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

test('ids stay deterministic and keep the short-name prefix', () => {
  const id = codecPublicId('Payment', shape, undefined, { source: 'openapi', constructs: true });
  assert.equal(id, codecPublicId('Payment', shape, undefined, { source: 'openapi', constructs: true }));
  assert.match(id, /^Payment_[0-9a-f]{8}$/);
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
  const { getObjectCodec } = await import('@exprtlabs/codegen/serde');
  const codec = (id) => getObjectCodec(id)?.issueSource;
  console.log(JSON.stringify({ hand: codec(process.argv[1]), sdk: codec(process.argv[2]) }));
`;

test('a hand-written and an SDK model of the same name and shape keep their own codec in either import order', async (t) => {
  const root = createFixtureProject(t, 'runic-codec-identity-');
  linkProjectPackages(root, Object.fromEntries(
    ['codegen', 'model-codegen', 'openapi-to-ts'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"codec-identity-fixture","type":"module"}');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify(openApiDocument));
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/money.model.ts'), [
    "import type { IModel } from '@exprtlabs/codegen/model';",
    '',
    'export type TMoney = IModel<{ amount: string; currency: string }>;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'runic-codegen.yaml'), [
    'version: 1', 'mobx: false', 'validation: true', 'openapi:', '  - input: api.json', '    output: sdk', '    name: Identity', 'models:', '  root: .', '',
  ].join('\n'));
  await runPipeline(path.join(root, 'runic-codegen.yaml'));

  const keyOf = (file: string): string => {
    const match = fs.readFileSync(path.join(root, file), 'utf8').match(/#Money": "(Money_[0-9a-f]{8})"/);
    assert.ok(match, `${file} names the Money codec`);
    return match[1];
  };
  const handId = keyOf('src/generated/models/iobject-plugin-keys.ts');
  const sdkId = keyOf('sdk/iobject-plugin-keys.ts');
  assert.notEqual(handId, sdkId);

  await command(root, process.execPath, [tscBin(), '-p', path.join(root, 'tsconfig.json')]);
  for (const order of [['sdk/index.js', 'src/money.model.generated.js'], ['src/money.model.generated.js', 'sdk/index.js']]) {
    const run = await command(root, process.execPath, ['--input-type=module', '-e', registerBoth(order), handId, sdkId]);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { hand: 'typescript', sdk: 'openapi' }, order.join(' then '));
  }
});
