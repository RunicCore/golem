import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { getValidator } from '@exprtlabs/codegen/validation';
import { generate } from '#model/generator';
import { command, workspace } from './support/process.js';
import { prototypeFieldsModelSource } from './fixture-templates/models/prototype-fields.js';

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

function fixture(t: TestContext, mobx: boolean): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runic-model-prototype-'));
  const sourceRoot = path.join(root, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  symlinkSync(path.join(workspace, 'packages/codegen'), path.join(root, 'node_modules/@exprtlabs/codegen'), 'dir');
  if (mobx) symlinkSync(path.join(workspace, 'node_modules/mobx'), path.join(root, 'node_modules/mobx'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'model-prototype', private: true, type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
      outDir: 'build',
      rootDir: 'src',
    },
    include: ['src/**/*.ts'],
  }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sourceRoot };
}

function materialize(result: ReturnType<typeof generate>): void {
  for (const artifact of result.artifacts) {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content);
  }
}

async function compile(root: string): Promise<void> {
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
}

for (const mobx of [false, true] as const) {
  for (const validation of [false, true] as const) {
    test(`dictionary data keys survive every generated profile (mobx=${mobx}, validation=${validation})`, async (t) => {
      const fixtureValue = fixture(t, mobx);
      const source = path.join(fixtureValue.sourceRoot, 'item.model.ts');
      writeFileSync(source, prototypeFieldsModelSource({ mobx }).text);
      const result = generate({ root: fixtureValue.root, profile: { mobx, validation } });
      materialize(result);
      const companion = result.artifacts.find((item) => item.path.endsWith('/item.model.generated.ts'))?.content ?? '';
      assert.match(companion, /defineModelProperty/);
      await compile(fixtureValue.root);
      const { Item } = await import(`${pathToFileURL(path.join(fixtureValue.root, 'build/item.model.js')).href}?${mobx}-${validation}`);
      const values = Object.fromEntries([
        ['label', 'own'],
        ['dictionary', Object.fromEntries([['__proto__', 'dictionary-own']])],
        ['nested', { value: 7 }],
      ]);
      const model = new Item(values);
      assert.equal(Object.hasOwn(model, 'label'), true);
      assert.equal(model.label, 'own');
      assert.equal(Object.hasOwn(model.dictionary, '__proto__'), true);
      assert.equal(model.dictionary['__proto__'], 'dictionary-own');
      assert.equal(Object.hasOwn(model.nested, 'value'), true);
      assert.equal(model.nested.value, 7);
      assert.equal(Object.getPrototypeOf(model), Item.prototype);
      if (mobx) {
        const { isObservableProp } = await import('mobx');
        assert.equal(isObservableProp(model, 'label'), true);
      }

      const decoded = decodeGeneratedModel(Item, values);
      assert.equal(Object.hasOwn(decoded, 'label'), true);
      assert.equal(decoded.label, 'own');
      assert.equal(Object.hasOwn(decoded.dictionary, '__proto__'), true);
      assert.equal(Object.hasOwn(decoded.nested, 'value'), true);
      const encoded = encodeGeneratedModel(model) as Record<string, unknown>;
      assert.equal(Object.hasOwn(encoded, 'label'), true);
      assert.equal(encoded.label, 'own');
      assert.equal(Object.hasOwn(encoded.dictionary as object, '__proto__'), true);
      assert.equal(Object.hasOwn(encoded.nested as object, 'value'), true);
      if (validation) {
        const invalid = new Item(JSON.parse('{"label":99,"dictionary":{"__proto__":"dictionary-own"},"nested":{"value":7}}') as Record<string, unknown>);
        assert.equal(await getValidator(invalid).validate(), false);
        assert.deepEqual(getValidator(invalid).issues[0]?.path, ['label']);
      }
    });
  }
}
