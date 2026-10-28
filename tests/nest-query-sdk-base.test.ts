import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { command, golem, workspace } from './support/process.js';

const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'QuerySdk', version: '1' },
  paths: {
    '/page': {
      get: {
        operationId: 'getPage',
        responses: { '200': { description: 'Page', content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Page: {
        type: 'object',
        required: ['limit'],
        additionalProperties: false,
        properties: { limit: { type: 'number' }, label: { type: 'string' } },
      },
    },
  },
};

test('a @Query() model built on an SDK model has the query fields of that SDK model', async (t) => {
  // protects: T-640 a field that only the SDK base declares as a number arrived at the handler as a string
  const root = createFixtureProject(t, 'golem-query-sdk-base-');
  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"query-sdk-base-fixture","type":"module"}');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify(openApiDocument));
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/filter.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Page } from '../sdk/index.js';",
    '',
    'export type TFilter = IModel<Page & { name: string; active: boolean }>;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'golem.yaml'), [
    'version: 1', 'mobx: false', 'validation: true', 'openapi:', '  - input: api.json', '    output: sdk', '    name: QuerySdk', 'models:', '  root: .', '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));
  const filterId = (JSON.parse(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8')) as { keys: Record<string, string> }).keys['src/filter.model.ts#TFilter'];
  await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  const script = `
    await import('./build/src/filter.model.generated.js');
    const { getObjectCodec } = await import('@exprtlabs/golem/serde');
    console.log(JSON.stringify(getObjectCodec(process.argv[1]).queryFields));`;
  const run = await command(root, process.execPath, ['--input-type=module', '-e', script, filterId]);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { active: { types: ['boolean'] }, limit: { types: ['number'] } });
});
