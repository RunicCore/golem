import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { copyFixture, copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { command, golem, workspace } from './support/process.js';

const GOLEM_YAML = ['version: 1', 'mobx: false', 'validation: true', 'openapi:', '  - input: api.json', '    output: sdk', '    name: LocaleOrder', 'models:', '  root: .', ''].join('\n');

/**
 * Runs `golem generate` on the fixture in a child process whose machine locale is `locale`. Returns the files the jobs wrote and the
 * two files the inventory keeps beside them, keyed by project-relative path. The fixture names its models, fields and tag values `aa`,
 * `b` and `z`: Danish collation puts `aa` after `z`, English before `b`.
 */
async function generateUnderLocale(t: TestContext, locale: string): Promise<ReadonlyMap<string, string>> {
  const root = createFixtureProject(t, 'golem-output-locale-');
  linkProjectPackages(root, {
    ...Object.fromEntries(['golem', 'golem-model', 'golem-openapi'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)])),
    typescript: path.join(workspace, 'node_modules/typescript'),
  });
  copyFixture(root, 'generated-output-locale');
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"generated-output-locale-fixture","type":"module"}');
  fs.writeFileSync(path.join(root, 'golem.yaml'), GOLEM_YAML);
  await command(root, process.execPath, [golem, 'generate'], { env: { LANG: locale, LC_ALL: locale } });
  const inventory = JSON.parse(fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8')) as { readonly files: Readonly<Record<string, unknown>> };
  // Sorted here, by code unit, so the list of names does not depend on the order under test.
  const names = [...new Set([...Object.keys(inventory.files), '.golem/outputs.json', '.golem/codec-keys.json'])].sort();
  return new Map(names.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
}

test('a models job and an openapi job write the same files under a Danish and an English machine locale', async t => {
  const danish = await generateUnderLocale(t, 'da_DK.UTF-8');
  const english = await generateUnderLocale(t, 'en_US.UTF-8');

  assert.ok([...english.keys()].some(name => name.startsWith('src/') && name.endsWith('.model.generated.ts')), 'the models job writes files');
  assert.ok([...english.keys()].some(name => name.startsWith('sdk/')), 'the openapi job writes files');
  assert.deepEqual([...danish.keys()], [...english.keys()], 'both locales write the same files');
  const differing = [...english].filter(([name, content]) => danish.get(name) !== content).map(([name]) => name);
  assert.deepEqual(differing, [], 'these files differ between the two locales');
});
