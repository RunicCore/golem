import { fixturePath, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { compositionProject as fixture } from './support/model-composition-project.js';
import { buildModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { discardedProjectionCodecsSource, discardedProjectionMetadataSource } from './fixture-templates/models/model-composition.js';
import { generate } from '#model/generator';

test('an unrelated same-name class does not become a model constructor', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/an-unrelated-same-name-class-does-not-become-a-model-constructor/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
  const authored = await import(`${path.join(root, 'build/item.model.js')}?${Date.now()}`);
  const parent = new generated.TParentBaseModel({ child: { id: 'child' } });
  assert.ok(parent.child instanceof generated.TItemBaseModel);
  assert.equal(parent.child instanceof authored.Item, false);
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'child' } });
});

test('first generation resolves model class bases through project path aliases', async t => {
  const { root, sourceRoot } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', imports: { '#generated/*': './build/*.model.generated.js' } }));
  config.compilerOptions.paths = { '#generated/*': ['./src/*.model.generated.ts'] };
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/item.model.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'parent.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/parent.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/parent.model.generated.js')}?${Date.now()}`);
  const authored = await import(path.join(root, 'build/item.model.js'));
  const parent = new generated.TParentBaseModel({ child: { id: 'nested' } });
  assert.ok(parent.child instanceof authored.Item);
  assert.equal(parent.child.label, 'nested');
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'nested' } });
});


test('IModel exposes fields and rejects root unions before emitting artifacts', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'keys.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/keys.ts"));
  await buildModelProject(root);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/item.model.ts"));
  for (const validation of [true, false]) {
    assert.throws(() => generate({ root, profile: { mobx: false, validation } }), /RUNM1052.*The IModel fields type must be an object type, but TItem has a union/);
  }
  assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
});

// protects: T-425 a non-object IModel root stops with RUNM1052 (Date[] once generated an invalid file, string[] a false RUNM1004)
const nonObjectRoots = [
  { name: 'an array of dates with validation off', declaration: 'IModel', fields: 'Date[]', validation: false, found: 'an array' },
  { name: 'an array of strings with validation on', declaration: 'IModel', fields: 'string[]', validation: true, found: 'an array' },
  { name: 'an array in an IObject', declaration: 'IObject', fields: 'string[]', validation: true, found: 'an array' },
  { name: 'a tuple', declaration: 'IModel', fields: '[string, Date]', validation: true, found: 'a tuple' },
  { name: 'a scalar', declaration: 'IModel', fields: 'string', validation: true, found: 'a scalar' },
  { name: 'any', declaration: 'IModel', fields: 'any', validation: false, found: 'any' },
  { name: 'the object keyword', declaration: 'IModel', fields: 'object', validation: false, found: 'the object keyword' },
  { name: 'an object intersected with a scalar', declaration: 'IModel', fields: '{ a: string } & string', validation: false, found: 'an intersection with a scalar' },
] as const;
for (const { name, declaration, fields, validation, found } of nonObjectRoots) {
  test(`${declaration} with ${name} as its fields type stops with RUNM1052`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { ${declaration} } from '@exprtlabs/golem/model';\nexport type TItem = ${declaration}<${fields}>;\n`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      new RegExp(`RUNM1052: The ${declaration} fields type must be an object type, but TItem has ${found}\\.`),
    );
    assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
  });
}

// protects: T-425 an unresolved fields type keeps RUNM1058 (it once read as the unknown root of RUNM1052)
for (const validation of [true, false]) {
  test(`an IModel whose fields type does not resolve stops with RUNM1058 with validation ${validation ? 'on' : 'off'}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';\nimport type { Missing } from './missing.js';\nexport type TItem = IModel<Missing>;\n`);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      /RUNM1058: The fields type of TItem could not be resolved\. Fix its declaration or import\./,
    );
  });
}

// protects: T-425 a whole-object TSerde root stops with RUNM1052 (it once wrote a file that did not compile); an SDK model's fields stay a valid root
test('an IModel over a type that a TSerde converts as a whole stops with RUNM1052', async t => {
  const { root, sourceRoot } = fixture(t);
  writeModelSources(sourceRoot, {
    'box.ts': `export class Box { constructor(public amount: number = 0) {} }
export function boxToJson(value: Box): string { return String(value.amount); }
export function boxFromJson(text: string): Box { return new Box(Number(text)); }
`,
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { Box, boxToJson, boxFromJson } from './box.js';
export type TItem = IModel<Box & TSerde<typeof boxToJson, typeof boxFromJson>>;
`,
  });
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1052: The IModel fields type must be an object type, but TItem has a type that a TSerde converts as a whole\./,
  );
});

test('an IModel over an SDK model generates a class with the fields of that model', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.copyFileSync(fixturePath('wire-format/sdk-money/money.yaml'), path.join(sourceRoot, 'money.yaml'));
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sourceRoot, 'money.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Payments',
    profile: { mobx: false, validation: true },
  })).artifacts);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/index.js';
export type TItem = IModel<Money>;
`,
  });
  const generated = generate({ root, profile: { mobx: false, validation: true } }).artifacts.find(artifact => artifact.path.endsWith('item.model.generated.ts'));
  assert.ok(generated);
  assert.match(generated.content, /declare amount: TItemFields\["amount"\];\s+declare currency: TItemFields\["currency"\];/);
});

test('an IModel over an SDK model keeps a field spelled like a brand key and drops the real brand keys', async t => {
  // protects: F-213 a generated-model brand key is found by its symbol, so a string key spelled like one stays a field
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'odd.yaml'), `openapi: 3.1.0
info: { title: Odd, version: "1" }
paths: {}
components:
  schemas:
    Odd:
      type: object
      required: [amount, "__@generatedModelWireBrand@1"]
      additionalProperties: false
      properties:
        amount: { type: number }
        "__@generatedModelWireBrand@1": { type: string }
`);
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sourceRoot, 'odd.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Odd',
    profile: { mobx: false, validation: true },
  })).artifacts);
  writeModelSources(sourceRoot, {
    'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Odd } from './sdk/index.js';
export type TItem = IModel<Odd>;
`,
  });
  const generated = generate({ root, profile: { mobx: false, validation: true } }).artifacts.find(artifact => artifact.path.endsWith('item.model.generated.ts'));
  assert.ok(generated);
  const declared = [...generated.content.matchAll(/^\s*declare (\S+?): TItemFields\[/gm)].map(match => match[1]);
  assert.deepEqual(declared, ['amount', '"__@generatedModelWireBrand@1"']);
});

for (const [place, fields] of [['a field of the model', 'name: string; [sym]: string'], ['a field of a nested object', 'inner: { name: string; [sym]: string }']] as const) {
  test(`a symbol-keyed property in ${place} stops generation with RUNM1070`, t => {
    // protects: F-39 golem rejects a property that JSON cannot carry; a symbol key once became a field named __@sym@N
    const { root, sourceRoot } = fixture(t);
    writeModelSources(sourceRoot, {
      'item.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
declare const sym: unique symbol;
export type TItem = IModel<{ ${fields} }>;
`,
    });
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /item\.model\.ts:\d+:\d+ RUNM1070: Model TItem has the property \[sym\] with a symbol key\. JSON cannot carry a symbol key\. Use a string key, or remove the property\./,
    );
  });
}

test('generated readonly fields remain readonly to TypeScript consumers', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  fs.writeFileSync(path.join(sourceRoot, 'readonly-consumer.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/readonly-consumer.ts"));
  await buildModelProject(root);
});

test('anonymous nested IModel declarations fail with an actionable diagnostic', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/anonymous-nested-imodel-declarations-fail-with-an-actionable-diagnostic/item.model.ts"));
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1053.*named, exported declaration/,
  );
});

for (const tag of ['serde', 'validation'] as const) {
  test(`projection rejects discarded whole-object ${tag} metadata`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), discardedProjectionCodecsSource({ metadata: tag }).text);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), discardedProjectionMetadataSource({ metadata: tag }).text);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /RUNM1055.*whole-object constraints or serialization/,
    );
  });
}

test('generic model templates require a concrete named declaration', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generic-model-templates-require-a-concrete-named-declaration/item.model.ts"));
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1057.*concrete fields/);
});

test('MobX projections retain nested observability', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/model-composition-item-model/item.model.ts"));
  writeModelGolemYaml(root, { mobx: true, validation: true });
  await buildModelProject(root);
  const { Parent, Child } = await import(path.join(root, 'build/item.model.js'));
  const { autorun, isObservableObject, runInAction } = await import('mobx');
  const parent = decodeGeneratedModel(Parent, { projected: { child: { name: 'First' } } });
  assert.ok(parent.projected.child instanceof Child);
  assert.equal(Object.getPrototypeOf(parent.projected), Object.prototype);
  assert.ok(isObservableObject(parent.projected.child));
  const seen: string[] = [];
  const dispose = autorun(() => { seen.push(parent.projected.child.name); });
  try {
    runInAction(() => { parent.projected.child.name = 'Next'; });
    assert.deepEqual(seen, ['First', 'Next']);
    assert.deepEqual(encodeGeneratedModel(parent), { projected: { child: { name: 'Next' } } });
    runInAction(() => { parent.projected.child.name = 'x'; });
    assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'Parent')).assert( encodeGeneratedModel(parent)));
  } finally { dispose(); }
});
