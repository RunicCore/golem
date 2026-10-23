import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NameTable, bindRead, code, helper, helperBlock, helperName, helperSet, identifier, importSet, inputOf, inputSlot, join, literal,
  nameOf, nameSlot, render, runtimeImports, sameCode, legacyText,
} from '#golem/code';
import { rt } from '#golem/rt';

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
    { module: 'conversion', names: ['decodeCheckedInput'] },
    { module: 'model', names: ['registerGeneratedModel'] },
    { module: 'serde', names: ['parseJson', 'stringifyJsonString'] },
  ]);
  assert.equal(
    render(runtimeImports(body), new NameTable()),
    "import { decodeCheckedInput } from '@exprtlabs/golem/conversion';\n"
      + "import { registerGeneratedModel } from '@exprtlabs/golem/model';\n"
      + "import { parseJson, stringifyJsonString } from '@exprtlabs/golem/serde';\n",
  );
});

test('the helper set holds each named helper once with the helpers it names and the runtime parts of their bodies', () => {
  // protects: spec 2.1 kind 2 helper cut fault (a helper kept or dropped by how often its name occurs)
  const decodeLeaf: ReturnType<typeof helper> = helper('decodeLeaf', () =>
    code`function decodeLeaf(v) { return ${rt.conversion.decodeCheckedInput}(v, ${helperName(decodeNode)}); }`);
  const decodeNode: ReturnType<typeof helper> = helper('decodeNode', () =>
    code`function decodeNode(v) { return ${helperName(decodeLeaf)}(v); }`);
  const body = code`${helperName(decodeNode)}(a); ${helperName(decodeNode)}(b);`;
  assert.deepEqual(helperSet(body).map((found) => found.id), ['decodeLeaf', 'decodeNode']);
  assert.equal(
    render(helperBlock(body), new NameTable()),
    'function decodeLeaf(v) { return decodeCheckedInput(v, decodeNode); }\n\nfunction decodeNode(v) { return decodeLeaf(v); }',
  );
  assert.deepEqual(importSet(body), [{ module: 'conversion', names: ['decodeCheckedInput'] }]);
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
