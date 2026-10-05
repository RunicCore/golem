import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { command } from './support/process.js';
import { companionModelProject, modelProject } from './support/model-companion-project.js';
import {
  buildModelProject,
  generatedModelFiles,
  writeModelGolemYaml,
  writeModelSources,
} from './model-project.js';
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { companionModelSource } from './fixture-templates/models/model-companions.js';

test('model companions compile with --noUnusedLocals for empty, scalar and nested models', async t => {
  const { root, sourceRoot } = modelProject(t);
  const modelNames = ['Empty', 'Scalar', 'Nested'] as const;
  for (const mobx of [false, true]) for (const validation of [false, true]) {
    const profile = { mobx, validation };
    for (const name of modelNames) {
      const stem = name.toLowerCase();
      writeModelSources(sourceRoot, { [`${stem}.model.ts`]: companionModelSource({ name, mobx }) });
    }
    writeModelGolemYaml(root, profile);
    await buildModelProject(root, ['--noUnusedLocals', '--noUnusedParameters']);
    for (const artifact of generatedModelFiles(root)) {
      const modelName = modelNames.find(name => path.basename(artifact.path) === `${name.toLowerCase()}.model.generated.ts`);
      if (!modelName) {
        const base = path.basename(artifact.path);
        assert.ok(base === 'models.generated.ts' || base === 'codec-keys.json', base);
        continue;
      }
      assert.match(artifact.content, new RegExp(`function fillT${modelName}\\(`), `${modelName}: shared fill`);
    }
    // Execution does not depend on the profile, so the verifier runs once.
    if (mobx && validation) {
      const verifier = copyFixtureFile(root, 'models/model-companions/verify-empty-scalar-nested.mjs', 'verify.mjs');
      await command(root, process.execPath, [verifier]);
    }
  }
});

test('golem build rewrites nested model serde calls and preserves class construction in CRLF source', async t => {
  const { root, sourceRoot } = companionModelProject(t, 'model-serde-edit');
  const source = readFixture('models/model-companions/serde-edit.model.ts').replaceAll('\n', '\r\n');
  const sourceFile = path.join(sourceRoot, 'item.model.ts');
  fs.writeFileSync(sourceFile, source);

  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);

  const emitted = fs.readFileSync(path.join(root, 'build/item.model.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("TItem_[0-9a-f]{8}"\)\.parse\(/);
  assert.match(emitted, /requireObjectCodec\("TItem_[0-9a-f]{8}"\)\.fromWireFormat\(/);
  assert.match(emitted, /construct: Item/);
  const firstEmit = emitted;
  await buildModelProject(root);
  assert.equal(fs.readFileSync(path.join(root, 'build/item.model.js'), 'utf8'), firstEmit);

  const loaded = await import(pathToFileURL(path.join(root, 'build/item.model.js')).href) as {
    readonly Item: new (values?: object) => object;
  };
  const item = new loaded.Item();
  const parsed = (item as { parseItem(text: string): object }).parseItem('{"title":"nested","value":7}');
  assert.ok(parsed instanceof loaded.Item);
  const wired = (item as { fromWireItem(value: unknown): object }).fromWireItem({ title: 'wire', value: 8 });
  assert.deepEqual({ ...wired }, { title: 'wire', value: 8 });
  assert.ok(wired instanceof loaded.Item);
});
