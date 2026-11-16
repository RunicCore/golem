import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { createExecutableValidationMemo, hasExecutableValidation, type ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { generate } from '#model/generator';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { command } from './support/process.js';

const profiles: readonly (readonly [string, GolemProfile])[] = [
  ['validation off', { validation: false }],
  // Models validate with the generated validators so one validating profile covers them.
  ['generated validators', { validation: true }],
];

function project(t: TestContext, prefix: string) {
  return createModelProject(t, { prefix, linkTypescript: true });
}

interface Chain {
  readonly kind: 'IModel' | 'IObject';
  /** Model name stem: item i is `${name}${i}` in `${name.toLowerCase()}-${i}.model.ts`. */
  readonly name: string;
  /** Shortest label the chain accepts; a chain of the other kind uses another length so its models never share a shape. */
  readonly minLabel: number;
}

const modelChain: Chain = { kind: 'IModel', name: 'Item', minLabel: 3 };
const objectChain: Chain = { kind: 'IObject', name: 'Row', minLabel: 2 };

/** Item i references item i-1 twice, so any per-path expansion grows exponentially. */
function chainSources(count: number, { kind, name, minLabel }: Chain = modelChain): Record<string, string> {
  const file = name.toLowerCase();
  const sources: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const previous = index > 0
      ? `import type { T${name}${index - 1} } from './${file}-${index - 1}.model.js';\n`
      : '';
    const fields = index > 0 ? `; prev: T${name}${index - 1}; prevs?: T${name}${index - 1}[]` : '';
    const base = kind === 'IModel' ? `import { T${name}${index}BaseModel } from './${file}-${index}.model.generated.js';\n` : '';
    const cls = kind === 'IModel' ? `export class ${name}${index} extends T${name}${index}BaseModel {}\n` : '';
    sources[`${file}-${index}.model.ts`] = `import type { ${kind} } from '@exprtlabs/golem/model';
import type { Discriminator, MinLength } from '@exprtlabs/golem/tags';
${previous}${base}export type T${name}${index} = ${kind}<{ label: string & MinLength<${minLabel}>; at: Date; kind: ({ k: 'a'; a: Date } | { k: 'b'; b: number }) & Discriminator<'k'>${fields} }>;
${cls}`;
  }
  return sources;
}

const chainVerifier = (last: number, name = 'Item') => `
const codecs = await import('./build/${name.toLowerCase()}-${last}.model.generated.js');
const item = (index) => ({ label: 'abc', at: '2024-01-01T00:00:00.000Z', kind: { k: 'a', a: '2024-01-02T00:00:00.000Z' }, ...(index > 0 ? { prev: item(index - 1), prevs: [item(index - 1)] } : {}) });
const wire = item(${last});
const model = codecs.fromWireFormatT${name}${last}(wire);
let deepest = model;
while (deepest.prev) deepest = deepest.prev;
const invalid = structuredClone(wire);
let leaf = invalid;
while (leaf.prev) leaf = leaf.prev;
leaf.label = 'x';
let rejected = null;
if (process.argv[2] === 'validate') {
  try { codecs.fromWireFormatT${name}${last}(invalid); rejected = false; } catch { rejected = true; }
}
console.log(JSON.stringify({
  date: deepest.at instanceof Date && deepest.kind.a instanceof Date,
  wire: JSON.stringify(codecs.toWireFormatT${name}${last}(model)) === JSON.stringify(wire),
  text: codecs.stringifyT${name}${last}(model) === JSON.stringify(wire),
  rejected,
}));
`;

for (const [label, profile] of profiles) for (const chain of [modelChain, objectChain]) {
  const { kind, name } = chain;
  test(`a companion emits only its own ${kind} models of a chained job and references the rest by codec id (${label})`, (t: TestContext) => {
    // protects: F-129 generated code is not duplicated, and a chain whose items reference the one before twice does not expand per path
    const count = 12;
    const last = count - 1;
    const { root, sourceRoot } = project(t, 'golem-model-chain-');
    writeModelSources(sourceRoot, chainSources(count, chain));
    const { artifacts } = generate({ root, profile });
    const companion = (index: number): string =>
      artifacts.find((artifact) => artifact.path.endsWith(`${name.toLowerCase()}-${index}.model.generated.ts`))?.content ?? '';
    const lastCompanion = companion(last);
    for (const index of [0, 5, last - 1]) {
      const owner = companion(index);
      const expectations: Readonly<Record<string, boolean>> = {
        [`function fillT${name}${index}(`]: true,
        [`function stringifyT${name}${index}Core(`]: true,
        [`class T${name}${index}BaseModel`]: kind === 'IModel',
        [`function decodeT${name}${index}(`]: kind === 'IObject',
      };
      for (const [owned, expected] of Object.entries(expectations)) {
        assert.equal(lastCompanion.includes(owned), false, `${name.toLowerCase()}-${last} does not emit ${owned}`);
        if (expected) assert.ok(owner.includes(owned), `${name.toLowerCase()}-${index} emits its own ${owned}`);
      }
    }
    // A companion imports the validators of its own models when the app validates, and no validator of another model.
    for (const index of [0, last]) {
      const imported = companion(index).match(/^import \{ ([^}]+) \} from "[^"]*models\.validators\.generated\.js";$/m)?.[1] ?? '';
      assert.equal(imported !== '', profile.validation === true, `${name.toLowerCase()}-${index} imports its validators only when the app validates`);
      for (const validator of imported.split(', ').filter((item) => item !== '')) {
        const codecId = validator.replace(/^(?:is|validate)_/, '').replace(/_(?:wire|model_only|wire_only)$/, '');
        assert.ok(companion(index).includes(`createObjectCodec("${codecId}", {`), `${name.toLowerCase()}-${index} imports only its own validators, not ${validator}`);
      }
    }
    assert.ok(lastCompanion.includes(kind === 'IModel' ? `class T${name}${last}BaseModel` : `function stringifyT${name}${last}Core(`));
    // Each companion carries its own model; its size does not grow with the chain behind it.
    assert.ok(lastCompanion.length < companion(1).length * 1.5, `${name.toLowerCase()}-${last} ${lastCompanion.length} B vs ${name.toLowerCase()}-1 ${companion(1).length} B`);
  });
}

const cycleSources = {
  'a.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { TB } from './b.model.js';
import { TABaseModel } from './a.model.generated.js';
export type TA = IModel<{ name: string & MinLength<2>; at: Date; b?: TB }>;
export class A extends TABaseModel {}
`,
  'b.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TA } from './a.model.js';
import { TBBaseModel } from './b.model.generated.js';
export type TB = IModel<{ at: Date; as: TA[] }>;
export class B extends TBBaseModel {}
`,
};

const cycleVerifier = `
const [first, validation] = process.argv.slice(2);
const loaded = {};
for (const name of first === 'a' ? ['a', 'b'] : ['b', 'a']) loaded[name] = await import('./build/' + name + '.model.generated.js');
const { a, b } = loaded;
const wireA = { name: 'aa', at: '2024-01-01T00:00:00.000Z', b: { at: '2024-01-02T00:00:00.000Z', as: [{ name: 'cc', at: '2024-01-03T00:00:00.000Z' }] } };
const wireB = { at: '2024-01-02T00:00:00.000Z', as: [wireA] };
const modelA = a.fromWireFormatTA(wireA);
const modelB = b.fromWireFormatTB(wireB);
let rejected = null;
if (validation === 'validate') {
  const invalid = structuredClone(wireB);
  invalid.as[0].b.as[0].name = 'x';
  try { b.fromWireFormatTB(invalid); rejected = false; } catch { rejected = true; }
}
console.log(JSON.stringify({
  a: modelA.b.as[0].at instanceof Date && a.stringifyTA(modelA) === JSON.stringify(wireA)
    && JSON.stringify(a.toWireFormatTA(modelA)) === JSON.stringify(wireA),
  b: modelB.as[0].b.as[0].at instanceof Date && b.stringifyTB(modelB) === JSON.stringify(wireB),
  rejected,
}));
`;

const leafEditVerifier = `
const { fromWireFormatTItem2 } = await import('./build/item-2.model.generated.js');
const item = (index) => ({ label: 'abc', at: '2024-01-01T00:00:00.000Z', kind: { k: 'a', a: '2024-01-02T00:00:00.000Z' }, ...(index > 0 ? { prev: item(index - 1), prevs: [item(index - 1)] } : { note: 'n' }) });
let deepest = fromWireFormatTItem2(item(2));
while (deepest.prev) deepest = deepest.prev;
console.log(JSON.stringify({ note: deepest.note }));
`;

test('a dependent of an edited leaf model decodes the new field of the leaf after the next build', async (t: TestContext) => {
  // protects: an edited model gets a new codec id; a dependent that kept the old id would not find the leaf codec
  const { root, sourceRoot } = project(t, 'golem-model-leaf-edit-');
  writeModelSources(sourceRoot, chainSources(3));
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const leaf = path.join(sourceRoot, 'item-0.model.ts');
  fs.writeFileSync(leaf, fs.readFileSync(leaf, 'utf8').replace('at: Date;', 'at: Date; note?: string;'));
  await buildModelProject(root);
  fs.writeFileSync(path.join(root, 'verify-leaf-edit.mjs'), leafEditVerifier);
  const result = await command(root, process.execPath, ['verify-leaf-edit.mjs']);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { note: 'n' });
});

const mixedCycleSources = {
  'order.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { TLine } from './line.model.js';
import { TOrderBaseModel } from './order.model.generated.js';
export type TOrder = IModel<{ id: string & MinLength<2>; at: Date; lines: TLine[] }>;
export class Order extends TOrderBaseModel {}
`,
  'line.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { TOrder } from './order.model.js';
export type TLine = IObject<{ at: Date; qty: number; parent?: TOrder }>;
`,
};

const mixedCycleVerifier = `
const [first, validation] = process.argv.slice(2);
const loaded = {};
for (const name of first === 'order' ? ['order', 'line'] : ['line', 'order']) loaded[name] = await import('./build/' + name + '.model.generated.js');
const { order, line } = loaded;
const wireOrder = { id: 'o1', at: '2024-01-01T00:00:00.000Z', lines: [{ at: '2024-01-02T00:00:00.000Z', qty: 1, parent: { id: 'o2', at: '2024-01-03T00:00:00.000Z', lines: [] } }] };
const model = order.fromWireFormatTOrder(wireOrder);
const wireLine = { at: '2024-01-04T00:00:00.000Z', qty: 2, parent: wireOrder };
const plain = line.fromWireFormatTLine(wireLine);
let rejected = null;
if (validation === 'validate') {
  const invalid = structuredClone(wireLine);
  invalid.parent.lines[0].parent.id = 'x';
  try { line.fromWireFormatTLine(invalid); rejected = false; } catch { rejected = true; }
}
console.log(JSON.stringify({
  order: model.lines[0].at instanceof Date && model.lines[0].parent.at instanceof Date
    && order.stringifyTOrder(model) === JSON.stringify(wireOrder),
  line: plain.parent.lines[0].parent.at instanceof Date && line.stringifyTLine(plain) === JSON.stringify(wireLine)
    && JSON.stringify(line.toWireFormatTLine(plain)) === JSON.stringify(wireLine),
  rejected,
}));
`;

const validationToggleSource = (type: string, options: string): string => `import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type ${type} = IModel<{ name: string & MinLength<3> }${options}>;
`;

const toggleVerifier = `
const { fromWireFormatTPlain } = await import('./build/plain.model.generated.js');
const { fromWireFormatTOpted } = await import('./build/opted.model.generated.js');
const accepts = (decode) => { try { decode({ name: 'x' }); return true; } catch { return false; } };
console.log(JSON.stringify({ plain: accepts(fromWireFormatTPlain), opted: accepts(fromWireFormatTOpted) }));
`;

// One project per profile holds a short chain of each kind and both cycles, so the profile compiles once.
for (const [label, profile] of profiles) {
  test(`chained, cyclic and mixed-kind jobs compile in one project (${label})`, async (t: TestContext) => {
    const { root, sourceRoot } = project(t, 'golem-model-job-graph-');
    writeModelSources(sourceRoot, {
      ...chainSources(3, modelChain),
      ...chainSources(3, objectChain),
      ...cycleSources,
      ...mixedCycleSources,
      'plain.model.ts': validationToggleSource('TPlain', ', { validation: false }'),
      'opted.model.ts': validationToggleSource('TOpted', ''),
    });
    writeModelGolemYaml(root, profile);
    await buildModelProject(root);
    const validation = profile.validation ? 'validate' : 'skip';

    for (const chain of [modelChain, objectChain]) {
      await t.test(`the ${chain.kind} models of a chained job convert, serialize and validate through their companions (${label})`, async () => {
        const verifier = `verify-${chain.name.toLowerCase()}-chain.mjs`;
        fs.writeFileSync(path.join(root, verifier), chainVerifier(2, chain.name));
        const result = await command(root, process.execPath, [verifier, validation]);
        assert.deepEqual(JSON.parse(result.stdout.trim()), {
          date: true, wire: true, text: true, rejected: profile.validation ? true : null,
        });
      });
    }

    await t.test(`a model that turns validation off accepts a value that the model beside it rejects (${label})`, async () => {
      // protects: R-77 a model at false gets no validators; with validation off in the project there is no validators file at all
      fs.writeFileSync(path.join(root, 'verify-toggle.mjs'), toggleVerifier);
      const result = await command(root, process.execPath, ['verify-toggle.mjs']);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { plain: true, opted: !profile.validation });
      assert.equal(generatedModelFiles(root).some((artifact) => artifact.path.endsWith('.validators.generated.ts')), profile.validation === true);
    });

    await t.test(`models of two sources that reference each other load in either import order (${label})`, async () => {
      fs.writeFileSync(path.join(root, 'verify-cycle.mjs'), cycleVerifier);
      for (const first of ['a', 'b']) {
        const result = await command(root, process.execPath, ['verify-cycle.mjs', first, validation]);
        assert.deepEqual(JSON.parse(result.stdout.trim()), { a: true, b: true, rejected: profile.validation ? true : null }, `${first} first`);
      }
    });

    await t.test(`an IModel and an IObject of two sources that reference each other load in either order (${label})`, async () => {
      fs.writeFileSync(path.join(root, 'verify-mixed-cycle.mjs'), mixedCycleVerifier);
      for (const first of ['order', 'line']) {
        const result = await command(root, process.execPath, ['verify-mixed-cycle.mjs', first, validation]);
        assert.deepEqual(JSON.parse(result.stdout.trim()), { order: true, line: true, rejected: profile.validation ? true : null }, `${first} first`);
      }
    });
  });
}

test('a job memo examines each referenced model once and never caches a result cut by a cycle', () => {
  const reference = (name: string): ModelTypeDescriptor => ({ kind: 'reference', name });
  const object = (properties: Record<string, ModelTypeDescriptor>): ModelTypeDescriptor =>
    ({ kind: 'object', properties, required: [], additionalProperties: false });
  const definitions: Record<string, ModelTypeDescriptor> = {
    // A reaches B before its own executable rule; B leads back to A.
    A: object({ b: reference('B'), rule: { kind: 'string', validations: ['rule'] } }),
    B: object({ a: reference('A') }),
    C: object({ x: reference('A') }),
    D: object({ y: reference('B') }),
  };
  for (let index = 0; index < 30; index++) {
    definitions[`Chain${index}`] = object(index === 0 ? { label: { kind: 'string' } } : { prev: reference(`Chain${index - 1}`), prevs: { kind: 'array', item: reference(`Chain${index - 1}`) } });
  }
  let resolved = 0;
  const executableMemo = createExecutableValidationMemo();
  const options = { executableMemo, resolveReference: (name: string) => { resolved++; return definitions[name]; } };
  assert.equal(hasExecutableValidation(definitions.C, options), true);
  assert.equal(hasExecutableValidation(definitions.D, options), true, 'B is not cached as false after the cycle cut');
  resolved = 0;
  for (let index = 1; index < 30; index++) assert.equal(hasExecutableValidation(definitions[`Chain${index}`], options), false);
  // Each walk resolves its own two references and those of the one model it examines; the rest are cached.
  assert.ok(resolved <= 4 * 30, `resolved ${resolved} references across 29 walks`);
  // Without a memo one walk still visits each shared model once, although the paths through the chain double per level.
  const depth = 20;
  resolved = 0;
  assert.equal(hasExecutableValidation(definitions[`Chain${depth - 1}`], { resolveReference: options.resolveReference }), false);
  assert.ok(resolved <= 2 * depth, `resolved ${resolved} references for ${depth} models`);
});
