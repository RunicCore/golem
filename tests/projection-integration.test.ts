import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generate } from '@exprtlabs/golem-openapi/generator';
import { command, workspace } from './support/process.js';
import { buildModelProject } from './model-project.js';

test('public directional projection handles repeated aliases and allOf requirements without weakening neutral or required-only schemas', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-projection-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const input = path.join(root, 'api.json');
  const user = {
    type: 'object',
    required: ['first', 'second', 'secretOne', 'secretTwo', 'name'],
    additionalProperties: false,
    properties: {
      first: { $ref: '#/components/schemas/ReadOnlyText' },
      second: { $ref: '#/components/schemas/ReadOnlyText' },
      secretOne: { $ref: '#/components/schemas/WriteOnlyText' },
      secretTwo: { $ref: '#/components/schemas/WriteOnlyText' },
      name: { type: 'string', minLength: 1 },
    },
  };
  fs.writeFileSync(input, JSON.stringify({
    openapi: '3.1.0', info: { title: 'Projection', version: '1' },
    paths: {
      '/user': {
        post: {
          operationId: 'createUser',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          responses: { '200': { description: 'User', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } },
        },
      },
      '/control': {
        post: {
          operationId: 'control',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RequiredOnly' } } } },
          responses: { '204': { description: 'Accepted' } },
        },
      },
    },
    components: { schemas: {
      ReadOnlyText: { type: 'string', readOnly: true },
      WriteOnlyText: { type: 'string', writeOnly: true },
      UserBase: user,
      User: { allOf: [{ $ref: '#/components/schemas/UserBase' }, { required: ['first', 'second', 'secretOne', 'secretTwo'] }] },
      RequiredOnly: { type: 'object', required: ['token'], additionalProperties: { type: 'string' } },
    } },
  }));
  const result = await generate({ input, output: path.join(root, 'sdk'), name: 'Projection', profile: { mobx: false, validation: true } });
  assert.equal(fs.existsSync(path.join(root, 'sdk')), false, 'public generation remains pure');
  for (const artifact of result.artifacts) {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.content);
  }
  fs.writeFileSync(path.join(root, 'consumer.ts'), readFixture("models/projection-integration/public-directional-projection-handles-repeated-aliases-and-allof-requirement/consumer.ts"));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: true,
      rootDir: '.', outDir: 'build', types: ['node'], lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    },
    include: ['sdk/**/*.ts', 'consumer.ts'],
  }));
  await buildModelProject(root);
  await command(root, process.execPath, ['build/consumer.js']);
});
