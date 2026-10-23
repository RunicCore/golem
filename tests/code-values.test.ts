import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NameTable, aliased, bindRead, code, helper, helperDefinitions, helperName, helperSet, identifier, importSet, inputOf, inputSlot, join, literal,
  nameOf, nameSlot, render, runtimeImports, sameCode, legacyText,
} from '#golem/code';
import { rt, rtType } from '#golem/rt';

test('render writes the parts once, in order, and fills each name from the table of the file', () => {
  // protects: T-281 render is the one place that makes text
  const decoder = nameSlot('decoder');
  const names = new NameTable();
  names.declare(decoder, 'decodeOrder');
  const call = code`const ${nameOf(decoder)} = ${rt.serde.parseJson}(${literal('a"b')}, ${identifier('field')});`;
  assert.equal(render(call, names), 'const decodeOrder = parseJson("a\\"b", field);');
  assert.equal(render(join([call, call], code`\n`), names), 'const decodeOrder = parseJson("a\\"b", field);\nconst decodeOrder = parseJson("a\\"b", field);');
  assert.throws(() => render(inputOf(inputSlot('value')), names), /input "value" is not bound/);
  assert.throws(() => render(nameOf(nameSlot('later')), names), /no name is decided for "later"/);
  // a Code in a string template would print "[object Object]"
  assert.throws(() => `${call}`, /put it in the code tag/);
});

test('the import set holds each runtime part once, grouped by module in the fixed order', () => {
  // protects: spec 2.1 kind 1 import cut fault (a name in a string, a comment or a field name keeps or drops an import)
  const body = code`
    // assertModelValue appears in a comment only
    const note = ${literal('createObjectCodec appears in a string only')};
    const ${identifier('createObjectCodec')} = ${rt.serde.stringifyJsonString}(${rt.serde.parseJson}(input));
    ${rt.serde.parseJson}(${rt.conversion.decodeCheckedInput}(input));
    ${rt.model.registerGeneratedModel}(Order);
  `;
  assert.deepEqual(importSet(body), [
    { module: 'conversion', names: ['decodeCheckedInput'], types: [] },
    { module: 'model', names: ['registerGeneratedModel'], types: [] },
    { module: 'serde', names: ['parseJson', 'stringifyJsonString'], types: [] },
  ]);
  assert.equal(
    render(join(runtimeImports(body), code`\n`), new NameTable()),
    "import { decodeCheckedInput } from '@exprtlabs/golem/conversion';\n"
      + "import { registerGeneratedModel } from '@exprtlabs/golem/model';\n"
      + "import { parseJson, stringifyJsonString } from '@exprtlabs/golem/serde';",
  );
});

test('the helper set holds each named helper once with the helpers it names and the runtime parts of their bodies', () => {
  // protects: spec 2.1 kind 2 helper cut fault (a helper kept or dropped by how often its name occurs)
  const decodeLeaf: ReturnType<typeof helper> = helper('decodeLeaf', () =>
    code`function decodeLeaf(v) { return ${rt.conversion.decodeCheckedInput}(v, ${helperName(decodeNode)}); }`);
  const decodeNode: ReturnType<typeof helper> = helper('decodeNode', () =>
    code`function decodeNode(v) { return ${helperName(decodeLeaf)}(v); }`);
  const body = code`${helperName(decodeNode)}(a); ${helperName(decodeNode)}(b);`;
  // The two functions name each other, so either order loads; a cycle is written from the first name met.
  assert.deepEqual(helperSet(body).map((found) => found.id), ['decodeNode', 'decodeLeaf']);
  assert.equal(
    render(join(helperDefinitions(body), code`\n\n`), new NameTable()),
    'function decodeNode(v) { return decodeLeaf(v); }\n\nfunction decodeLeaf(v) { return decodeCheckedInput(v, decodeNode); }',
  );
  assert.deepEqual(importSet(body), [{ module: 'conversion', names: ['decodeCheckedInput'], types: [] }]);
});

test('a type name is imported with import type, and a file picks the specifier of each runtime module', () => {
  // protects: T-318 a type name never lands in a value import, and the runtime may be imported from a resolved URL
  const body = code`export function check(): readonly ${rtType['validation-runtime'].SchemaIssue}[] { return ${rt['validation-runtime'].jsonEqual}(a, b) ? [] : []; }`;
  // @ts-expect-error a type name that the module does not export is a type error
  void rtType['validation-runtime'].NoSuchType;
  assert.deepEqual(importSet(body), [{ module: 'validation-runtime', names: ['jsonEqual'], types: ['SchemaIssue'] }]);
  assert.equal(
    render(join(runtimeImports(body, { specifiers: { 'validation-runtime': 'file:///runtime/validation-runtime.js' }, quote: '"' }), code`\n`)),
    'import type { SchemaIssue } from "file:///runtime/validation-runtime.js";\nimport { jsonEqual } from "file:///runtime/validation-runtime.js";',
  );
  assert.equal(
    render(join(runtimeImports(body), code`\n`)),
    "import type { SchemaIssue } from '@exprtlabs/golem/validation-runtime';\nimport { jsonEqual } from '@exprtlabs/golem/validation-runtime';",
  );
});

test('a file writes value and type names on one line, a type under a local name, and in the order it lists', () => {
  // protects: T-288 mixed value and type import lines of a model file stay byte-identical (SC-2)
  const options = { typeNames: 'inline', order: { serde: ['parseJson', 'IssueSource', 'assertModelValue'], model: ['GeneratedModel', 'generatedModelWireBrand'] } } as const;
  const body = code`${rt.serde.assertModelValue}(${rt.serde.IssueSource}, ${rt.serde.parseJson}) as ${aliased(rtType.serde.SerdeOptions, '__GolemSerdeOptions')} & ${rtType.model.generatedModelFieldsBrand} & ${rtType.model.generatedModelWireBrand} & ${rtType.model.GeneratedModel}`;
  assert.equal(
    render(join(runtimeImports(body, options), code`\n`)),
    "import { type GeneratedModel, type generatedModelWireBrand, type generatedModelFieldsBrand } from '@exprtlabs/golem/model';\n"
      + "import { parseJson, IssueSource, assertModelValue, type SerdeOptions as __GolemSerdeOptions } from '@exprtlabs/golem/serde';",
  );
  assert.equal(render(body), 'assertModelValue(IssueSource, parseJson) as __GolemSerdeOptions & generatedModelFieldsBrand & generatedModelWireBrand & GeneratedModel');
  assert.throws(() => aliased(code`a ${rt.serde.parseJson}`, 'x'), /one runtime part/);
});

test('a helper that a file reads while it loads comes after the helper it names', () => {
  // protects: T-286 a helper used at load comes after its dependency
  const markKey: ReturnType<typeof helper> = helper('markKey', () => code`const markKey = Symbol.for('t286:mark');`);
  const checkedOptions: ReturnType<typeof helper> = helper('checkedOptions', () =>
    code`const checkedOptions = Object.freeze({ [${helperName(markKey)}]: true });`);
  const block = render(join(helperDefinitions(code`${helperName(checkedOptions)}`), code`\n\n`), new NameTable());
  assert.deepEqual(helperSet(code`${helperName(checkedOptions)}`).map((found) => found.id), ['markKey', 'checkedOptions']);
  // The file loads: the first constant would be read before it exists if the ids set the order.
  const loaded = new Function(`${block}\nreturn checkedOptions;`)() as Record<symbol, unknown>;
  assert.equal(loaded[Symbol.for('t286:mark')], true);
});

test('sameCode matches parts one by one, and a runtime part equals the text of its name', () => {
  // protects: T-282 an emitter decides "unchanged" from Code, also against the text a caller still writes by hand
  const first = nameSlot('first');
  const second = nameSlot('second');
  const written = code`${rt.serde.stringifyJsonScalar}(item as never)`;
  assert.equal(sameCode(written, legacyText('stringifyJsonScalar(item as never)')), true);
  assert.equal(sameCode(written, legacyText('stringifyJsonString(item as never)')), false);
  assert.equal(sameCode(nameOf(first), nameOf(first)), true);
  assert.equal(sameCode(nameOf(first), nameOf(second)), false);
  assert.equal(sameCode(inputOf(inputSlot('value')), nameOf(first)), false);
  assert.equal(render(code`${rt.serde.parseJson}(x)`), 'parseJson(x)');
});

test('a piece that reads its input twice gets a local, and one that reads it once gets the expression', () => {
  // protects: T-283 an emitter counts the input parts of a piece and binds a local for more than one read
  const input = inputSlot('field');
  const local = identifier('__local');
  const once = code`${rt.serde.stringifyJsonString}(${inputOf(input)} as string)`;
  const twice = code`${inputOf(input)} === null ? 'null' : ${rt.serde.stringifyJsonNumber}(${inputOf(input)} as number)`;
  const bound = bindRead(once, input, code`value["a"]`, local);
  assert.deepEqual([render(bound.code), bound.local], ['stringifyJsonString(value["a"] as string)', false]);
  const repeated = bindRead(twice, input, code`value["a"]`, local);
  assert.deepEqual([render(repeated.code), repeated.local], ["__local === null ? 'null' : stringifyJsonNumber(__local as number)", true]);
  // an optional field also reads its input in the `!== undefined` check
  assert.equal(render(bindRead(once, input, code`value["a"]`, local, 1).code), 'stringifyJsonString(__local as string)');
});
