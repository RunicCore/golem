import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#openapi/generator';
import type { OpenApiContext } from '@exprtlabs/golem/generator-api';
import { createFixtureProject, linkGolemPackages } from '../fixture-project.js';
import { loadConfig } from '../support/load-config.js';
import { writeOpenApiDocument } from './helpers.js';

const PROFILE = { validation: true, allowAny: false } as const;
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Charges', version: '1' },
  paths: {
    '/charges': {
      post: {
        operationId: 'createCharge',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } },
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } } },
      },
    },
  },
  webhooks: {
    chargeUpdated: {
      post: {
        operationId: 'receiveChargeUpdated',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } },
        responses: { 204: { description: 'accepted' } },
      },
    },
  },
  components: { schemas: { Charge: { type: 'object', required: ['when'], properties: { when: { type: 'string', format: 'date-time' } } } } },
};

/** A project whose golem.yaml has a model block and an SDK of the given mode, and the job the config makes of it. */
async function project(t: test.TestContext, mode: 'golem' | 'standalone') {
  const directory = createFixtureProject(t, 'golem-mode-sdk-');
  writeOpenApiDocument(directory, DOCUMENT, 'api.json');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'golem-mode-sdk-fixture', private: true, type: 'module' }));
  linkGolemPackages(directory, ['golem', 'golem-model', 'golem-openapi-ts']);
  const config = path.join(directory, 'golem.yaml');
  fs.writeFileSync(config, `version: 1\nopenapi-ts:\n  sdks:\n    - input: api.json\n      output: sdk/charges\n      name: Charges\n      mode: ${mode}\nmodel: {}\n`);
  const job = (await loadConfig(config)).jobs.find(candidate => candidate.block === 'openapi-ts');
  assert.ok(job);
  return { directory, options: { ...(job.options as OpenApiContext), profile: PROFILE } };
}

test('an openapi job in golem mode writes types and the client, and imports its codecs from the file the models job writes', async t => {
  // protects: T-697 in golem mode the SDK writes types and the client only; the import path comes from models.output (F-779)
  const { directory, options } = await project(t, 'golem');
  const sdk = path.join(directory, 'sdk/charges');
  const codecsFile = path.join(directory, 'src/generated/models/sdk/charges.sdk.generated.ts');
  assert.equal(options.codecsFile, codecsFile);

  const result = await generate(options);
  const files = new Map(result.artifacts.map(artifact => [path.relative(sdk, artifact.path), artifact.content]));
  assert.deepEqual([...files.keys()].sort(), [
    'client.ts', 'index.ts', 'input-schemas.ts', 'model-manifest.json', 'operations/createCharge.ts', 'output-schemas.ts', 'types.ts',
  ]);
  const operation = files.get('operations/createCharge.ts') ?? '';
  assert.match(operation, /^import \{ sdkCodecs as __golemSdkCodecs \} from '\.\.\/\.\.\/\.\.\/src\/generated\/models\/sdk\/charges\.sdk\.generated\.js';$/m);
  assert.match(operation, /^const __operationCodecs: .* = __golemSdkCodecs\["createCharge"\];$/m);
  assert.match(operation, /from '@exprtlabs\/golem\/client'/);

  const again = await generate(options);
  assert.deepEqual(again.artifacts, result.artifacts);
});

test('an openapi job in golem mode needs a SDK folder inside the golem.yaml folder and the codecs file', async t => {
  // protects: T-697 one rule names the codecs file; an SDK it cannot name is refused where the key is set
  const { directory, options } = await project(t, 'golem');
  const { codecsFile: _codecsFile, ...withoutFile } = options;
  await assert.rejects(generate(withoutFile), /context\.codecsFile must be an absolute path when mode is "golem"/);
  fs.writeFileSync(path.join(directory, 'outside.yaml'), 'version: 1\nopenapi-ts:\n  sdks:\n    - input: api.json\n      output: ../sdk\n      mode: golem\nmodel: {}\n');
  await assert.rejects(() => loadConfig(path.join(directory, 'outside.yaml')), /An SDK of mode golem lies in a folder below the golem\.yaml folder/);
});
