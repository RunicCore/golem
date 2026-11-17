import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { loadFunctions, loadModelClasses, requireRecord } from './openapi/helpers.js';
import { valueAt } from './support/json.js';
import { buildRecursiveProject, json } from './support/recursive-fixtures.js';

const profiles: readonly (readonly [string, GolemProfile])[] = [
  ['validation off', { validation: false }],
  ['validation on', { validation: true }],
];

const sources = {
  'alias.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TJsonHolderBaseModel, TStampsBaseModel } from './alias.model.generated.js';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Stamped = { at: Date; next: Stamped[] };
export type DateTree = string | { at: Date; kids: DateTree[] };
export type TJsonHolder = IModel<{ value: JsonValue; many: JsonValue[] }>;
export type TStamps = IModel<{ list: Stamped[]; one: Stamped | null; tree: DateTree[] }>;
export class JsonHolder extends TJsonHolderBaseModel {}
export class Stamps extends TStampsBaseModel {}
`,
};

const iso = (day: number): string => `2024-01-0${day}T00:00:00.000Z`;

for (const [label, profile] of profiles) {
  test(`a JsonValue field converts nothing, and a recursive alias that holds a date decodes it at every depth (${label})`, async (t: TestContext) => {
    // protects: T-221 an alias that reaches no date, serde value or model has no conversion call; one that holds a date converts
    const { root } = await buildRecursiveProject(t, 'golem-recursive-alias-conversion-', sources, profile);
    const generated = fs.readFileSync(path.join(root, 'src/alias.model.generated.ts'), 'utf8');
    const codecs = await loadFunctions(path.join(root, 'build/alias.model.generated.js'), ['fromWireFormatTJsonHolder', 'toWireFormatTJsonHolder', 'fromWireFormatTStamps', 'toWireFormatTStamps', 'stringifyTStamps', ...(profile.validation ? ['validateTStamps'] : [])]);
    const { JsonHolder } = await loadModelClasses(path.join(root, 'build/alias.model.js'), ['JsonHolder']);

    assert.equal(/(decode|init|encode)JsonValue\b/.test(generated), false, 'a JsonValue field has no conversion call');
    const value = { text: 'a', count: 3, list: [1, 'two', [null, true]], nested: { deep: { deeper: ['x'] } } };
    const holder = new JsonHolder({ value, many: [value, 'b', 4] });
    assert.deepEqual(json(requireRecord(holder, 'holder').value), value);
    const wire = { value, many: [value, 'b', 4] };
    assert.deepEqual(json(codecs.fromWireFormatTJsonHolder(wire)), wire);
    assert.deepEqual(json(codecs.toWireFormatTJsonHolder(holder)), wire);

    const stampsWire = {
      list: [{ at: iso(1), next: [{ at: iso(2), next: [{ at: iso(3), next: [] }] }] }],
      one: { at: iso(4), next: [{ at: iso(5), next: [] }] },
      tree: ['plain', { at: iso(1), kids: ['x', { at: iso(2), kids: [] }] }],
    };
    const stamps = codecs.fromWireFormatTStamps(stampsWire);
    assert.ok(valueAt(stamps, 'list', 0, 'at') instanceof Date, 'the date of a T[] item');
    assert.ok(valueAt(stamps, 'list', 0, 'next', 0, 'next', 0, 'at') instanceof Date, 'the date three levels deep');
    assert.ok(valueAt(stamps, 'one', 'next', 0, 'at') instanceof Date, 'the date of a T | null field');
    assert.ok(valueAt(stamps, 'tree', 1, 'kids', 1, 'at') instanceof Date, 'the date of a recursive union branch');
    assert.deepEqual(json(codecs.toWireFormatTStamps(stamps)), stampsWire);
    assert.equal(codecs.stringifyTStamps(stamps), JSON.stringify(stampsWire));
    if (profile.validation) {
      assert.equal(codecs.validateTStamps(stamps), true, 'the model plane holds a Date');
      assert.throws(() => codecs.fromWireFormatTStamps({ ...stampsWire, tree: [{ at: 5, kids: [] }] }), 'the wire plane holds a string');
    }
  });
}
