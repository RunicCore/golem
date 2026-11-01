import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { buildEditorSchema, editorSchemaPath, writeEditorSchema } from '#golem/editor-schema';
import { loadPackageRegistry, type PackageRegistration, type PackageRegistry } from '#golem/package-registry';
import { runPipeline } from '#golem/cli';
import { copyFixture, copyFixtureFile, createFixtureProject, linkGolemPackages } from './fixture-project.js';

const ROOT_KEYS = ['version', 'tsconfig', 'validation', 'allowAny', 'exact', 'unknownFormats'];

/** A registry of hand-made packages: `parts` maps a block to the text of its schema part file, or to undefined for a package that declares none. */
function registryOf(t: TestContext, parts: Readonly<Record<string, string | undefined>>): PackageRegistry {
  const root = createFixtureProject(t, 'golem-editor-schema-');
  const packages = Object.entries(parts).map(([block, text]): PackageRegistration => {
    const file = path.join(root, `${block}.json`);
    if (text !== undefined) fs.writeFileSync(file, text);
    return { name: `@fixture/${block}`, directory: root, block, plan: undefined, generator: undefined, extensions: new Map(), schema: block === 'bare' ? undefined : file };
  });
  return { packages, blocks: new Map(packages.map((entry) => [entry.block, entry])), files: [] };
}

test('the editor schema holds the core keys and, under its block name, the part of each package', (t) => {
  // protects: page Registration, editor schema: .golem/schema.json merges the core keys and each package's schema part
  const registry = registryOf(t, { alpha: '{"type":"object","properties":{"size":{"type":"integer"}}}', bare: undefined });

  const { text, warnings } = buildEditorSchema(registry);

  assert.deepEqual(warnings, []);
  assert.deepEqual(JSON.parse(text), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'golem.yaml',
    type: 'object',
    required: ['version'],
    additionalProperties: false,
    properties: {
      version: { const: 1, description: 'The configuration format version. It is independent of the package release.' },
      tsconfig: { type: 'string', minLength: 1, default: 'tsconfig.json', description: "The project's tsconfig, relative to golem.yaml." },
      validation: { enum: [true, false, 'sanity'], default: true, description: 'The level of the generated run-time checks.' },
      allowAny: { type: 'boolean', default: false, description: 'Permit fields typed any or unknown in models.' },
      exact: { type: 'boolean', default: true, description: 'Reject extra properties in models.' },
      unknownFormats: { enum: ['warn', 'error'], default: 'error', description: 'The action for a schema format that golem does not check.' },
      alpha: { type: 'object', properties: { size: { type: 'integer' } } },
      bare: {},
    },
  });
});

const MALFORMED = [
  ['a part file that is missing', undefined, 'does not exist'],
  ['a part that is not JSON', '{ "type": ', 'is not valid JSON'],
  ['a part that is no object', '[1]', 'must hold a JSON Schema object'],
] as const;

for (const [name, content, cause] of MALFORMED) {
  test(`${name} gives a warning that names the package and is left out, and the other parts stay`, (t) => {
    // protects: page "When something fails": a malformed schema part gives a warning; the part is left out of .golem/schema.json
    const registry = registryOf(t, { alpha: '{"type":"object"}', broken: content });

    const { text, warnings } = buildEditorSchema(registry);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', new RegExp(`^golem: the schema part of @fixture/broken is left out of ${path.join('.golem', 'schema.json')}: .*${cause}.*\\. The editor does not complete the "broken" block\\.$`));
    const { properties } = JSON.parse(text) as { properties: Record<string, unknown> };
    assert.deepEqual(properties.alpha, { type: 'object' });
    assert.deepEqual(properties.broken, {}, 'the block stays allowed, with no completion');
    assert.deepEqual(Object.keys(properties), [...ROOT_KEYS, 'alpha', 'broken']);
  });
}

test('a schema part that is missing or broken does not stop the registry from loading', (t) => {
  // protects: page "When something fails": a malformed schema part never stops loading (the registry no longer reads the part)
  const root = createFixtureProject(t, 'golem-editor-schema-');
  const installed = path.join(root, 'node_modules/@fixture/block-a');
  copyFixture(installed, 'registry/block-a');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@fixture/block-a': '1.0.0' } }));
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, 'version: 1\n');
  fs.rmSync(path.join(installed, 'golem-schema.json'));

  const registry = loadPackageRegistry(config);

  assert.deepEqual(registry.packages.map(({ block, schema }) => ({ block, schema })), [{ block: 'alpha', schema: path.join(installed, 'golem-schema.json') }]);
  const written = writeEditorSchema(root, registry);
  assert.equal(written.length, 1);
  assert.deepEqual((JSON.parse(fs.readFileSync(editorSchemaPath(root), 'utf8')) as { properties: Record<string, unknown> }).properties.alpha, {});
});

test('a pipeline run writes .golem/schema.json with the schema part of the installed model package', async (t) => {
  // protects: page Registration, editor schema: golem writes .golem/schema.json at the pipeline's write point
  const root = createFixtureProject(t, 'golem-editor-schema-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"editor-schema-fixture","type":"module"}');
  linkGolemPackages(root, ['golem', 'golem-model']);
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmodel: {}\n');

  await runPipeline(path.join(root, 'golem.yaml'));

  const schema = JSON.parse(fs.readFileSync(path.join(root, '.golem/schema.json'), 'utf8')) as { properties: Record<string, { properties?: Record<string, unknown> }> };
  assert.deepEqual(Object.keys(schema.properties), [...ROOT_KEYS, 'model']);
  assert.deepEqual(Object.keys(schema.properties.model?.properties ?? {}), ['sources', 'suffixes', 'output']);
});
