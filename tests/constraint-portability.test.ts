import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate as generateControllers } from '#controllers/generator';
import { command, workspace } from './support/process.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { compileSchema } from './support/compiled-validators.js';

const accepted = [
  { neg: -1 },
  { choice: 2 },
  { choice: -2 },
  { cond: { n: -1, code: 1 } },
  { counts: [2, -1, -1] },
  { annotated: { a: 2 } },
  { builtin: 'text' },
];
const rejected = [
  { neg: 2 },
  { choice: 0 },
  { cond: { n: 1, code: 1 } },
  { counts: [2, 3] },
  { builtin: 2 },
];

test('model predicates never strengthen wire or OpenAPI contracts', async t => {
  const { root } = createModelProject(t, {
    prefix: 'golem-portability-',
    name: null,
    linkTypescript: true,
    packages: {
      '@nestjs/common': path.join(workspace, 'node_modules/@nestjs/common'),
      '@types': path.join(workspace, 'node_modules/@types'),
    },
    compilerOptions: { experimentalDecorators: true, types: ['node'] },
  });
  writeGeneratedArtifacts([
    {
      path: path.join(root, 'src/rules.ts'),
      content: readFixture('models/constraint-portability/constraint-portability-rules/rules.ts'),
    },
    {
      path: path.join(root, 'src/a.model.ts'),
      content: readFixture('models/constraint-portability/constraint-portability-a-model/a.model.ts'),
    },
    {
      path: path.join(root, 'src/a.controller.ts'),
      content: readFixture('models/constraint-portability/constraint-portability-a-controller/a.controller.ts'),
    },
  ]);
  for (const openapiVersion of ['3.2.0', '3.1.2'] as const) {
    const result = await generateControllers({
      root, output: path.join(root, 'openapi.json'), openapiVersion,
      info: { title: 'Contracts', version: '1' },
      profile: { validation: true },
    });
    assert.ok(result.diagnostics?.some(item => item.code === 'NEST1502' && item.severity === 'warning'));
    const content = result.artifacts[0]!.content;
    assert.doesNotMatch(content, /exprtValidation|positive|negative|rules\.ts|rules\.js|validations/);
    const document = JSON.parse(content) as { components: Record<string, unknown>; paths: Record<string, { post: { requestBody: { content: { 'application/json': { schema: unknown } } } } }> };
    const schema = document.paths['/contracts']!.post.requestBody.content['application/json'].schema;
    const validate = await compileSchema({ allOf: [schema], components: document.components });
    for (const value of accepted) assert.deepEqual(validate(value, true), [], JSON.stringify(value));
    assert.notDeepEqual(validate({ builtin: 2 }, true), [], 'predicate-free Not remains exact');
  }
  writeGeneratedArtifacts([{
    path: path.join(root, 'src/verify.ts'),
    content: readFixture('models/constraint-portability/verifier/verify.ts'),
  }]);
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const aId = generatedCodecIdFromRoot(root, 'TA');
  await command(root, process.execPath, [
    path.join(root, 'build/verify.js'),
    JSON.stringify(aId),
    JSON.stringify(accepted),
    JSON.stringify(rejected),
  ]);
});
