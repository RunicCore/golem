// lane: typescript6 ProgramSession: the manifest validation program is not opened again while the SDK it validates is unchanged
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { createProgram, loadModelManifests } from '@exprtlabs/golem/internal/type-analysis';
import { runPipeline } from '#golem/cli';
import { observeTooling } from '#golem/observe';
import { GeneratorSessionResources } from '#golem/pipeline';
import { createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { filesUnder, writeFixture } from './support/consumer.js';
import { workspace } from './support/process.js';

/** The project of a golem.yaml with an openapi job that writes the SDK and a models job that validates the SDK's manifest. */
function sdkProject(t: TestContext): { root: string; config: string; api: string; manifest: string } {
  const root = createFixtureProject(t, 'golem-validation-skip-');
  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"golem-validation-skip-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  return { root, config: path.join(root, 'golem.yaml'), api: path.join(root, 'api.json'), manifest: path.join(root, 'sdk/model-manifest.json') };
}

/** The manifest validation programs opened from now on; each one lists the SDK modules in its own configuration. */
function countValidationPrograms(t: TestContext): { readonly count: () => number } {
  let opened = 0;
  const observing = observeTooling({ programOpened: (_session, options) => { if (options.configFile?.endsWith('.golem-manifest-validation.json')) opened += 1; } });
  t.after(() => observing[Symbol.dispose]());
  return { count: () => opened };
}

// protects: T-470 a watch cycle with unchanged manifests and SDK opens no validation program; the openapi job's rewrite of the SDK opens one
test('the models job opens no manifest validation program in a cycle whose manifests and SDK are unchanged, and one after the openapi job rewrites the SDK', async (t: TestContext) => {
  const { root, config, api } = sdkProject(t);
  const opened = countValidationPrograms(t);
  using session = new GeneratorSessionResources();

  const first = await runPipeline(config, { session });
  assert.equal(opened.count(), 1);

  const model = path.join(root, 'src/cart.model.ts');
  fs.appendFileSync(model, '// edited\n');
  const second = await runPipeline(config, { session, previous: first, changedInputs: [model] });
  assert.equal(second.ran.size > 0, true, 'the edit reruns a job');
  assert.equal(opened.count(), 1);

  // The SDK entries stay as they were; only the files the openapi job writes change.
  const document = JSON.parse(fs.readFileSync(api, 'utf8')) as { components: { schemas: { Money: { properties: Record<string, unknown> } } } };
  document.components.schemas.Money.properties.memo = { type: 'string' };
  fs.writeFileSync(api, JSON.stringify(document));
  await runPipeline(config, { session, previous: second, changedInputs: [api] });
  assert.equal(opened.count(), 2);
  assert.match(filesUnder(path.join(root, 'sdk')).map((file) => fs.readFileSync(file, 'utf8')).join('\n'), /memo/);
});

/** Load the SDK manifest on one compiler session, as the models job of a watch does in each cycle. */
async function loadManifestOnSession(t: TestContext): Promise<{ load: () => void; manifest: string; count: () => number }> {
  const { root, config, manifest } = sdkProject(t);
  await runPipeline(config);
  const session = new ts.ProgramSession({ cwd: root });
  t.after(() => session[Symbol.dispose]());
  const opened = countValidationPrograms(t);
  const source = path.join(root, 'src/cart.model.ts');
  const advertised = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { profile: GolemProfile }).profile;
  return { load: () => { loadModelManifests(root, createProgram([source], root, undefined, session), [manifest], advertised); }, manifest, count: opened.count };
}

// protects: T-470 a manifest edit validates again
test('a cycle after a manifest edit opens the validation program again', async (t: TestContext) => {
  const { load, manifest, count } = await loadManifestOnSession(t);
  load();
  load();
  assert.equal(count(), 1);
  fs.appendFileSync(manifest, '\n');
  load();
  assert.equal(count(), 2);
});

// protects: T-470 a file that shadows what an SDK import resolved to validates again
test('a cycle after a new file shadows what an SDK import resolved to opens the validation program again', async (t: TestContext) => {
  const { load, manifest, count } = await loadManifestOnSession(t);
  const { models } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { models: { generated: { module: string } }[] };
  const module = path.resolve(path.dirname(manifest), models[0]!.generated.module.replace(/\.js$/, '.ts'));
  fs.writeFileSync(path.join(path.dirname(module), 'util.d.ts'), 'export declare const util: number;\n');
  fs.appendFileSync(module, "import './util.js';\n");
  load();
  load();
  assert.equal(count(), 1);
  // The compiler tries util.ts before util.d.ts, so the new file replaces the declaration that the import resolved to.
  fs.writeFileSync(path.join(path.dirname(module), 'util.ts'), 'export const util = 1;\n');
  load();
  assert.equal(count(), 2);
});

// protects: T-470 a failed validation is never taken for a pass
test('a manifest that failed validation reports its error again in the next unchanged cycle', async (t: TestContext) => {
  const { load, manifest, count } = await loadManifestOnSession(t);
  const valid = fs.readFileSync(manifest, 'utf8');
  const broken = JSON.parse(valid) as { models: { generated: { export: string } }[] };
  broken.models[0]!.generated.export = 'NoSuchExport';
  fs.writeFileSync(manifest, JSON.stringify(broken));
  assert.throws(load, /references missing runtime export NoSuchExport/);
  assert.throws(load, /references missing runtime export NoSuchExport/);
  assert.equal(count(), 2);
  fs.writeFileSync(manifest, `${valid}\n`);
  load();
  assert.equal(count(), 3);
});
