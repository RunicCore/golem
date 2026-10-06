import { createFixtureProject, linkProjectPackages, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { schemaForDescriptor } from '@exprtlabs/golem/schema';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { getValidator } from '@exprtlabs/golem/validation';
import { analyzeSourceGraph } from '#model/emit';
import { generate } from '#model/generator';
import { collectSpecifications } from '@exprtlabs/golem/type-analysis';
import { loadModelManifests } from '@exprtlabs/golem/type-analysis';
import { createProgram, generatedFilename } from '@exprtlabs/golem/type-analysis';
import { generate as generateControllers } from '#controllers/generator';
import { workspace } from './support/process.js';
import { buildModelProject, generatedModelFiles, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { compileSchema } from './support/compiled-validators.js';
import { containsSiblingConstraintSource } from './fixture-templates/models/constraint-parity.js';

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

function fixture(t: TestContext): Fixture {
  const root = createFixtureProject(t, 'golem-constraint-parity-');
  const sourceRoot = path.join(root, 'src');
  linkProjectPackages(root, {
    '@exprtlabs/golem': path.join(workspace, 'packages/golem'),
    typescript: path.join(workspace, 'node_modules/typescript'),
  });
  writeGeneratedArtifacts([
    {
      path: path.join(root, 'package.json'),
      content: JSON.stringify({ name: 'constraint-parity', private: true, type: 'module' }),
    },
    {
      path: path.join(root, 'tsconfig.json'),
      content: JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          experimentalDecorators: true,
          outDir: 'build',
          rootDir: 'src',
        },
        include: ['src/**/*.ts'],
      }),
    },
  ]);
  return { root, sourceRoot };
}

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

async function controllerValidators(root: string): Promise<readonly Validator[]> {
  linkProjectPackages(root, {
    '@nestjs/common': path.join(workspace, 'node_modules/@nestjs/common'),
  });
  writeGeneratedArtifacts([{
    path: path.join(root, 'src/a.controller.ts'),
    content: readFixture('models/constraint-parity/constraint-parity-a-controller/a.controller.ts'),
  }]);
  const validators: Validator[] = [];
  for (const openapiVersion of ['3.2.0', '3.1.2'] as const) {
    const result = await generateControllers({
      root, output: path.join(root, `openapi-${openapiVersion}.json`), openapiVersion,
      info: { title: 'Constraint parity', version: '1' },
      profile: { mobx: false, validation: true },
    });
    const document: {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, { post: { requestBody: { content: Record<string, { schema: unknown }> } } }>;
    } = JSON.parse(result.artifacts[0].content);
    const schema = document.paths['/constraints'].post.requestBody.content['application/json'].schema;
    const schemaDocument = {
      components: document.components,
      allOf: [schema],
    };
    validators.push(await compileSchema(schemaDocument));
  }
  return validators;
}

function canonicalModelSchema(root: string, sourceRoot: string): unknown {
  const source = path.join(sourceRoot, 'a.model.ts');
  const profile = { mobx: false, validation: true } as const;
  const programInfo = createProgram([source], root);
  const { checker, specifications } = collectSpecifications(programInfo.program, [source]);
  const manifestIndex = loadModelManifests(
    root,
    programInfo,
    [],
    profile,
  );
  const graph = analyzeSourceGraph(
    source,
    generatedFilename(source),
    checker,
    specifications,
    manifestIndex,
    profile,
    root,
    programInfo.options,
  );
  assert.ok(graph, 'model source graph');
  const descriptor = graph.definitions.TA;
  assert.ok(descriptor, 'generated root descriptor');
  const schema = schemaForDescriptor(descriptor, { definitions: graph.definitions });
  return schema;
}

const cases = {
  valid: {
    counts: { one: 'a', two: 'b' },
    contains: ['miss', 'hit', 'hit'],
    containsPattern: ['skip', 'ok'],
    names: { first: 'ok', second: 'ok' },
    patterns: { known: 'ok', x_count: 2, z_flag: true },
    additional: { known: 'ok', extra: 2 },
    unevaluated: { known: 'ok', secondary: 3 },
    required: { card: '123', cvv: '999' },
    schemas: { kind: 'full', detail: 'present' },
    oneOf: { a: 'chosen' },
    not: { allowed: 'yes' },
    conditional: { kind: 'yes', value: 'then' },
    tuple: ['name', 2],
    booleanContains: [true, false],
    booleanNot: false,
    literalAdditional: { known: 'ok', flag: false },
  },
  boundaries: {
    counts: { one: 'a' },
    contains: ['hit', 'miss'],
    containsPattern: ['ok', 'ok'],
    names: {},
    patterns: { known: 'ok' },
    additional: { known: 'ok' },
    unevaluated: {},
    required: {},
    schemas: {},
    oneOf: { b: 2 },
    not: {},
    conditional: { fallback: 2 },
    tuple: ['name', 2],
    booleanContains: [false],
    booleanNot: false,
    literalAdditional: { known: 'ok' },
  },
} as const;

type FixtureValues = typeof cases.valid;

function validModelValues(): FixtureValues {
  return structuredClone(cases.valid);
}

function assertParity(
  model: object,
  canonical: Validator,
  value: FixtureValues,
  expected: boolean,
): Promise<void> {
  assert.equal(canonical(value, true).length === 0, expected, `canonical schema mismatch: ${JSON.stringify(canonical(value, true))}`);
  const validator = getValidator(model);
  return validator.validate().then((actual) => {
    assert.equal(actual, expected, `generated validator mismatch: ${JSON.stringify(validator)}`);
  });
}

test('generated extended constraints accept and reject the same wire values as the emitted schemas', async t => {
  const { root, sourceRoot } = fixture(t);
  writeGeneratedArtifacts([{
    path: path.join(sourceRoot, 'a.model.ts'),
    content: readFixture('models/constraint-parity/extended-constraints/a.model.ts'),
  }]);

  // Read the same authored contract before model companions exist. Each
  // document dialect must accept and reject exactly the same wire values.
  const openApiValidators = await controllerValidators(root);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await compile(root);

  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TA'));
  const canonical = await compileSchema(canonicalModelSchema(root, sourceRoot));
  const valid = validModelValues();
  assert.equal(codec.validate(valid), true);
  for (const validate of openApiValidators) assert.deepEqual(validate(valid, true), []);
  await assertParity(new A(valid), canonical, valid, true);

  const boundary = { ...valid, ...cases.boundaries } as unknown as FixtureValues;
  for (const validate of openApiValidators) assert.deepEqual(validate(boundary, true), []);
  await assertParity(new A(boundary), canonical, boundary, true);

  const invalidCases: readonly [keyof FixtureValues, unknown][] = [
    ['counts', {}],
    ['counts', { one: 'a', two: 'b', three: 'c' }],
    ['contains', ['miss', 'miss']],
    ['contains', ['hit', 'hit', 'hit']],
    ['containsPattern', ['bad']],
    ['containsPattern', []],
    ['containsPattern', ['ok', 'ok', 'ok']],
    ['names', { Good: 'bad' }],
    ['patterns', { known: 'ok', x_count: 'bad' }],
    ['patterns', { known: 'ok', z_flag: 'bad' }],
    ['patterns', { known: 'ok', other: true }],
    ['additional', { known: 'ok', extra: 'bad' }],
    ['unevaluated', { known: 'ok', extra: true }],
    ['required', { card: '123' }],
    ['schemas', { kind: 'full' }],
    ['oneOf', {}],
    ['oneOf', { a: 'chosen', b: 2 }],
    ['not', { forbidden: 'blocked' }],
    ['conditional', { kind: 'yes', fallback: 2 }],
    ['conditional', { kind: 'no', value: 'wrong-branch' }],
    ['tuple', ['name', 2, true]],
    ['booleanContains', [true, true]],
    ['booleanNot', true],
    ['literalAdditional', { known: 'ok', flag: true }],
  ];
  for (const [field, fieldValue] of invalidCases) {
    const candidate = { ...valid, [field]: fieldValue } as FixtureValues;
    for (const validate of openApiValidators) assert.notDeepEqual(validate(candidate, true), [], `OpenAPI accepts ${field}`);
    assert.notDeepEqual(canonical(candidate, true), [], `canonical accepts ${field}`);
    assert.equal(codec.validate(candidate), false, `generated validate accepts ${field}`);
    assert.throws(() => codec.parse(JSON.stringify(candidate)), field);
    assert.throws(() => codec.fromWireFormat(candidate), field);
  }
});

for (const validation of [true, false] as const) {
  for (const tag of ['MinContains', 'MaxContains'] as const) {
    test(`${tag} requires a Contains sibling before artifacts with validation=${validation}`, t => {
      const { root, sourceRoot } = fixture(t);
      writeGeneratedArtifacts([{
        path: path.join(sourceRoot, 'a.model.ts'),
        content: containsSiblingConstraintSource({ tag }).text,
      }]);
      assert.throws(
        () => generate({ root, profile: { mobx: false, validation } }),
        /(?:MinContains|MaxContains)[\s\S]*(?:Contains|requires)/,
      );
    });
  }
}
