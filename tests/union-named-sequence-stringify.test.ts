import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { identifier } from '@exprtlabs/golem/internal/emitter';
import { emitCodecRuntimeText, instantiateRuntime } from './emitted-runtime.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { DATE_FIELD, DATE_SERDE } from './support/date-field.js';
import { closedObject } from './support/schema-nodes.js';

// A named array (a recursive array alias) beside a string in an untagged union, written as JSON text. The text must be the JSON of the
// wire value with each date written once, whether the call validates (the wire writer reads the encoded value) or not.

const instant = '2025-01-02T03:04:05.000Z';
const at = new Date(instant);
const nodes = [{ label: 'a', at, children: [{ label: 'b', at }] }];
const wireNodes = [{ label: 'a', at: instant, children: [{ label: 'b', at: instant }] }];

type Stringify = (value: unknown, options?: { validate?: boolean }) => string;

const tree = (item: string) => `export type TTree = { label: string; ${item}; children?: TTree }[];`;

/** A model project of one `TBox` that holds `items: TTree | string` and a date, built with the project `validation`; its `stringifyTBox`. */
async function stringifyBox(t: Parameters<typeof createModelProject>[0], declaration: string, validation: boolean): Promise<Stringify> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-union-named-sequence-', name: 'union-named-sequence', linkTypescript: true });
  writeModelGolemYaml(root, { validation });
  writeModelSources(sourceRoot, {
    'box.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
${declaration}
export type TBox = IObject<{ items: TTree | string; when: Date }>;
`,
  });
  await buildModelProject(root);
  const generated = await import(pathToFileURL(path.join(root, 'build/box.model.generated.js')).href) as { stringifyTBox: Stringify };
  return generated.stringifyTBox;
}

const withDates = tree('at: Date');
const withoutDates = tree('at: string');

for (const [what, declaration, items, wireItems] of [
  ['whose items hold a date', withDates, nodes, wireNodes],
  ['whose items hold no date', withoutDates, [{ label: 'a', at: instant, children: [{ label: 'b', at: instant }] }], wireNodes],
] as const) {
  test(`a recursive array ${what} beside a string is written as JSON when the call validates`, async (t) => {
    // protects: T-905 the join of the array and the string had no parentheses, so the text lost its "items" key and was no JSON
    const stringify = await stringifyBox(t, declaration, true);
    assert.deepEqual(JSON.parse(stringify({ items, when: at })), { items: wireItems, when: instant }, 'array');
    assert.deepEqual(JSON.parse(stringify({ items: 'text', when: at })), { items: 'text', when: instant }, 'string');
  });
}

test('a recursive array whose items hold a date beside a string is written as JSON when the call does not validate', async (t) => {
  // protects: T-905 the lenient write of the union stays the JSON of the wire value
  const stringify = await stringifyBox(t, withDates, true);
  assert.deepEqual(JSON.parse(stringify({ items: nodes, when: at }, { validate: false })), { items: wireNodes, when: instant });
});

test('a recursive array whose items hold a date beside a string is written as JSON when the project turns validation off', async (t) => {
  // protects: T-905 the lenient write of the union stays the JSON of the wire value
  const stringify = await stringifyBox(t, withDates, false);
  assert.deepEqual(JSON.parse(stringify({ items: nodes, when: at })), { items: wireNodes, when: instant });
});

/** The `stringifyBox` of a box that holds a date and `items`, a union of a generated model whose node is an array of dated items, and a string. */
function generatedModelBox(): Stringify {
  const graph = createSchemaGraph();
  const treeNode = graph.intern({ kind: 'array', item: closedObject({ label: { kind: 'string' }, at: DATE_FIELD }) }, 'Tree');
  graph.intern(closedObject({ items: { kind: 'union', variants: [{ kind: 'generated-model', id: treeNode.codecId }, { kind: 'string' }] }, when: DATE_FIELD }), 'Box');
  graph.seal();
  const source = emitCodecRuntimeText(graph, { serde: DATE_SERDE, validatorName: (id) => identifier(`validate_${id.replace(/[^\w$]/g, '_')}`) });
  // The validators and checks of the module are not under test: each name the module does not define answers no issue.
  const scope: Record<string, unknown> = {};
  for (const [name] of source.matchAll(/\b(?:validate_\w+|__golem\w+)\b/g)) {
    if (!new RegExp(`(?:function|const|let|class) ${name.replaceAll('$', '\\$')}\\b`).test(source)) scope[name] = () => [];
  }
  return instantiateRuntime(source, scope).stringifyBox as Stringify;
}

test('a generated model that holds an array of dated items beside a string writes each date once when the call validates', () => {
  // protects: T-905 the wire writer of the box called the model writer of the array, which wrote the date strings of the wire value again
  const stringify = generatedModelBox();
  assert.deepEqual(JSON.parse(stringify({ items: [{ label: 'a', at }], when: at })), { items: [{ label: 'a', at: instant }], when: instant });
  assert.deepEqual(JSON.parse(stringify({ items: 'text', when: at })), { items: 'text', when: instant });
});

test('a generated model that holds an array of dated items beside a string is written as JSON when the call does not validate', () => {
  // protects: T-905 the lenient write of the union stays the JSON of the wire value
  assert.deepEqual(JSON.parse(generatedModelBox()({ items: [{ label: 'a', at }], when: at }, { validate: false })), { items: [{ label: 'a', at: instant }], when: instant });
});
