import { createFixtureProject, linkProjectPackages, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { generate as generateModels } from '#model/generator';
import { generate as generateControllers } from '#controllers/generator';
import { command, workspace } from './support/process.js';
import { generatedCodecId } from './support/consumer.js';

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

for (const ajvStandalone of [false, true]) {
  test(`model predicates never strengthen wire or OpenAPI contracts with standalone=${ajvStandalone}`, async t => {
    const root = createFixtureProject(t, 'runic-portability-');
    linkProjectPackages(root, {
      '@exprtlabs/codegen': path.join(workspace, 'packages/codegen'),
      '@nestjs/common': path.join(workspace, 'node_modules/@nestjs/common'),
      '@types': path.join(workspace, 'node_modules/@types'),
    });
    writeGeneratedArtifacts([
      {
        path: path.join(root, 'package.json'),
        content: JSON.stringify({ private: true, type: 'module' }),
      },
      {
        path: path.join(root, 'tsconfig.json'),
        content: JSON.stringify({
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            experimentalDecorators: true,
            skipLibCheck: true,
            outDir: 'build',
            rootDir: 'src',
            types: ['node'],
          },
          include: ['src/**/*.ts'],
        }),
      },
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
    // Controller output never reads the Ajv mode, so only the runtime-Ajv run checks the OpenAPI contracts.
    for (const openapiVersion of ajvStandalone ? [] : ['3.2.0', '3.1.2'] as const) {
      const result = await generateControllers({
        root, output: path.join(root, 'openapi.json'), openapiVersion,
        info: { title: 'Contracts', version: '1' },
        profile: { mobx: false, validation: true, ajvStandalone },
      });
      assert.ok(result.diagnostics?.some(item => item.code === 'NEST1502' && item.severity === 'warning'));
      const content = result.artifacts[0]!.content;
      assert.doesNotMatch(content, /exprtValidation|positive|negative|rules\.ts|rules\.js|validations/);
      const document = JSON.parse(content) as { components: Record<string, unknown>; paths: Record<string, { post: { requestBody: { content: { 'application/json': { schema: unknown } } } } }> };
      const schema = document.paths['/contracts']!.post.requestBody.content['application/json'].schema;
      const validate = new Ajv2020({ strict: false, validateSchema: false }).compile({ allOf: [schema], components: document.components } as AnySchema);
      for (const value of accepted) assert.equal(validate(value), true, JSON.stringify(validate.errors));
      assert.equal(validate({ builtin: 2 }), false, 'predicate-free Not remains exact');
    }
    const modelResult = generateModels({ root, profile: { mobx: false, validation: true, ajvStandalone } });
    writeGeneratedArtifacts(modelResult.artifacts);
    for (const artifact of modelResult.artifacts) {
      if (artifact.path.endsWith('.generated.js')) {
        const built = path.join(root, 'build', path.relative(path.join(root, 'src'), artifact.path));
        fs.mkdirSync(path.dirname(built), { recursive: true });
        fs.copyFileSync(artifact.path, built);
      }
    }
    const aId = generatedCodecId(modelResult.artifacts.map((artifact) => artifact.content).join('\n'), 'A');
    writeGeneratedArtifacts([{
      path: path.join(root, 'src/verify.ts'),
      content: readFixture('models/constraint-portability/verifier/verify.ts'),
    }]);
    await command(root, process.execPath, [path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'), '-p', '.']);
    await command(root, process.execPath, [
      path.join(root, 'build/verify.js'),
      JSON.stringify(aId),
      JSON.stringify(accepted),
      JSON.stringify(rejected),
    ]);
  });
}
