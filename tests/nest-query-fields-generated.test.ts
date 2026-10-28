import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { command, golem, workspace } from './support/process.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'QueryFields', version: '1' },
  paths: Object.fromEntries(['Page', 'Page2'].map((name) => [`/${name}`, {
    get: { operationId: `get${name}`, responses: { '200': { description: name, content: { 'application/json': { schema: ref(name) } } } } },
  }])),
  components: {
    schemas: {
      Level: { type: 'integer', enum: [1, 2, 3] },
      Flag: { type: 'boolean', enum: [true, false] },
      IntLimit: { type: 'integer' },
      Tags: { type: 'array', items: { type: 'integer' } },
      Page: {
        type: 'object',
        properties: { level: ref('Level'), flags: { type: 'array', items: ref('Flag') }, limit: ref('IntLimit'), tags: ref('Tags'), name: { type: 'string' } },
      },
      Page2: { allOf: [ref('Page'), { type: 'object', properties: { page: { type: 'integer' } } }] },
    },
  },
};

/** Builds the project and returns the `queryFields` of each codec the script loads, by the name of its model. */
async function queryFieldsOf(root: string, modules: readonly string[], ids: readonly string[]): Promise<Record<string, unknown>> {
  await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  const script = `
    for (const file of ${JSON.stringify(modules)}) await import(file);
    const { getObjectCodec } = await import('@exprtlabs/golem/serde');
    const ids = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(Object.fromEntries(ids.map((id) => [id.replace(/_[0-9a-f]{8}$/, ''), getObjectCodec(id)?.queryFields ?? null]))));`;
  return JSON.parse((await command(root, process.execPath, ['--input-type=module', '-e', script, JSON.stringify(ids)])).stdout.trim()) as Record<string, unknown>;
}

function project(t: test.TestContext, prefix: string, yaml: readonly string[], document: object = openApiDocument): string {
  const root = createFixtureProject(t, prefix);
  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), `{"name":"${prefix}fixture","type":"module"}`);
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify(document));
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'golem.yaml'), ['version: 1', 'mobx: false', 'validation: true', ...yaml, ''].join('\n'));
  return root;
}

// protects: T-549 I-42 a query field typed by a named alias, and the fields of an allOf base, stayed raw strings
test('a model that golem-openapi generates lists the query fields of its aliases and its allOf base', async (t) => {
  const root = project(t, 'golem-query-fields-', ['openapi:', '  - input: api.json', '    output: sdk', '    name: QueryFields']);
  await runPipeline(path.join(root, 'golem.yaml'));
  const ids = (JSON.parse(fs.readFileSync(path.join(root, 'sdk/model-manifest.json'), 'utf8')) as { models: { codecId: string }[] }).models.map((model) => model.codecId);
  const tables = await queryFieldsOf(root, ['./build/sdk/index.js'], ids);
  const page = {
    flags: { types: [], item: { types: ['boolean'] } },
    level: { types: ['number', 'integer'] },
    limit: { types: ['number', 'integer'] },
    tags: { types: [], item: { types: ['number', 'integer'] } },
  };
  assert.deepEqual(tables.Page, page);
  assert.deepEqual(tables.Page2, { ...page, page: { types: ['number', 'integer'] } });
});

// protects: T-549 I-42 a golem-model @Query() model field typed by a named alias, also a recursive one, stayed a raw string
test('a model that golem-model generates lists the query fields of its named and recursive aliases', async (t) => {
  const root = project(t, 'golem-query-fields-model-', ['models:', '  root: .']);
  fs.writeFileSync(path.join(root, 'src/filter.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    '',
    'export type Level = 1 | 2;',
    'export type Loop = 1 | 2 | Loop[];',
    'export type TFilter = IModel<{ level: Level; loop?: Loop; limit: number; name: string }>;',
    '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));
  const id = (JSON.parse(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8')) as { keys: Record<string, string> }).keys['src/filter.model.ts#TFilter'];
  const tables = await queryFieldsOf(root, ['./build/src/filter.model.generated.js'], [id]);
  const table = tables.TFilter as Record<string, { literals?: unknown; item?: { literals?: unknown } }>;
  assert.deepEqual(table.level, { types: [], literals: [1, 2] });
  assert.deepEqual(table.limit, { types: ['number'] });
  // The recursion through the array ends at a second visit of Loop; the levels that decode hold the literals.
  assert.deepEqual(table.loop?.literals, [1, 2]);
  assert.deepEqual(table.loop?.item?.literals, [1, 2]);
});

// protects: T-640 a golem-model @Query() field typed by an SDK alias or an SDK model needs the SDK's wire schema at build time
test('a model that golem-model generates lists the query fields of an SDK alias and ignores an SDK object', async (t) => {
  const sdkDocument = {
    openapi: '3.1.0',
    info: { title: 'QuerySdkFields', version: '1' },
    paths: Object.fromEntries(['Level', 'Range'].map((name) => [`/${name}`, {
      get: { operationId: `get${name}`, responses: { '200': { description: name, content: { 'application/json': { schema: ref(name) } } } } },
    }])),
    components: {
      schemas: {
        Level: { type: 'integer', enum: [1, 2, 3] },
        Range: { type: 'object', required: ['min'], properties: { min: { type: 'integer' } } },
      },
    },
  };
  const root = project(t, 'golem-query-fields-sdk-', ['openapi:', '  - input: api.json', '    output: sdk', '    name: QuerySdkFields', 'models:', '  root: .'], sdkDocument);
  fs.writeFileSync(path.join(root, 'src/filter.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Level, Range } from '../sdk/index.js';",
    '',
    'export type TFilter = IModel<{ lv: Level; r: Range; name: string }>;',
    '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));
  const id = (JSON.parse(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8')) as { keys: Record<string, string> }).keys['src/filter.model.ts#TFilter'];
  const tables = await queryFieldsOf(root, ['./build/src/filter.model.generated.js'], [id]);
  assert.deepEqual(tables.TFilter, { lv: { types: [], literals: [1, 2, 3] } });
});
