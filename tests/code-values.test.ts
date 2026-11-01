import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ImportSource, NameTable, aliased, bindRead, fileImports, code, helper, helperDefinitions, helperName, helperSet, selfPlacedHelper, identifier, importGroups, inputOf, isEmpty, inputSlot, join, literal,
  localCode, nameOf, nameSlot, propertyKey, render, runtimeImports, sameCode, nest, lineBreak, packageExport, placeHelpers, runtimeCode,
} from '#golem/code';
import { rt, rtType } from '#golem/rt';
import { runModule } from './support/run-module.js';

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

test('the import groups hold each runtime part once, grouped by specifier in the fixed module order', () => {
  // protects: an import is kept or dropped by the code that uses it, never by a name in a string, a comment or a field name
  const body = code`
    // assertModelValue appears in a comment only
    const note = ${literal('createObjectCodec appears in a string only')};
    const ${identifier('createObjectCodec')} = ${rt.serde.stringifyJsonString}(${rt.serde.parseJson}(input));
    ${rt.serde.parseJson}(${rt.conversion.decodeCheckedInput}(input));
    ${rt.model.registerGeneratedModel}(Order);
  `;
  assert.deepEqual(importGroups(body), [{
    specifier: '@exprtlabs/golem/internal/model-runtime',
    modules: ['conversion', 'model', 'serde'],
    names: [{ name: 'decodeCheckedInput' }, { name: 'registerGeneratedModel' }, { name: 'parseJson' }, { name: 'stringifyJsonString' }],
    types: [],
  }]);
  assert.equal(
    render(join(runtimeImports(body), code`\n`), new NameTable()),
    "import { decodeCheckedInput, registerGeneratedModel, parseJson, stringifyJsonString } from '@exprtlabs/golem/internal/model-runtime';",
  );
});

test('the helper set holds each named helper once with the helpers it names and the runtime parts of their bodies', () => {
  // protects: a helper is kept or dropped by the code that uses it, never by how often its name occurs
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
  assert.deepEqual(importGroups(body).map((group) => group.names), [[{ name: 'decodeCheckedInput' }]]);
});

test('a type name is imported with import type, and a file picks the specifier of each runtime module', () => {
  // protects: T-318 a type name never lands in a value import, and the runtime may be imported from a resolved URL
  const body = code`export function check(): readonly ${rtType.validation.SchemaIssue}[] { return ${rt['validation-runtime'].jsonEqual}(a, b) ? [] : []; }`;
  // @ts-expect-error a type name that the module does not export is a type error
  void rtType.validation.NoSuchType;
  assert.deepEqual(importGroups(body).map((group) => [group.specifier, group.names, group.types]), [
    ['@exprtlabs/golem/validation', [], [{ name: 'SchemaIssue', typeOnly: true }]],
    ['@exprtlabs/golem/internal/validation-runtime', [{ name: 'jsonEqual' }], []],
  ]);
  assert.equal(
    render(join(runtimeImports(body, { specifiers: { values: { 'validation-runtime': 'file:///runtime/validation-runtime.js' }, types: { validation: 'file:///runtime/types.js' } }, quote: '"' }), code`\n`)),
    'import type { SchemaIssue } from "file:///runtime/types.js";\nimport { jsonEqual } from "file:///runtime/validation-runtime.js";',
  );
  assert.equal(
    render(join(runtimeImports(body), code`\n`)),
    "import type { SchemaIssue } from '@exprtlabs/golem/validation';\nimport { jsonEqual } from '@exprtlabs/golem/internal/validation-runtime';",
  );
});

test('a file writes one statement for each specifier, a type under a local name, and in the order it lists', () => {
  // protects: T-288 the import lines of a model file hold each specifier once, values from the internal entry and types from the public subpath (SC-2)
  const options = { typeNames: 'inline', order: { serde: ['parseJson', 'IssueSource', 'assertModelValue'], model: ['GeneratedModel', 'generatedModelWireBrand'] } } as const;
  const body = code`${rt.serde.assertModelValue}(${rt.serde.IssueSource}, ${rt.serde.parseJson}) as ${aliased(rtType.serde.SerdeOptions, '__GolemSerdeOptions')} & ${rtType.model.generatedModelFieldsBrand} & ${rtType.model.generatedModelWireBrand} & ${rtType.model.GeneratedModel}`;
  assert.equal(
    render(join(runtimeImports(body, options), code`\n`)),
    "import type { GeneratedModel, generatedModelWireBrand, generatedModelFieldsBrand } from '@exprtlabs/golem/model';\n"
      + "import { parseJson, IssueSource, assertModelValue } from '@exprtlabs/golem/internal/model-runtime';\n"
      + "import type { SerdeOptions as __GolemSerdeOptions } from '@exprtlabs/golem/serde';",
  );
  assert.equal(render(body), 'assertModelValue(IssueSource, parseJson) as __GolemSerdeOptions & generatedModelFieldsBrand & generatedModelWireBrand & GeneratedModel');
  assert.throws(() => aliased(code`a ${rt.serde.parseJson}`, 'x'), /one runtime part/);
});

test('a file imports the names it uses from its own sources, in the order it declares them, and lists the runtime modules it writes', () => {
  // protects: T-288 the import of a companion or a handwritten class holds the names the code uses, in the order of the file (SC-2, SC-3)
  const companion = new ImportSource('./order.golem.ts');
  const orderBase = companion.name('OrderBaseModel');
  const orderJson = companion.name('OrderJSON', { typeOnly: true });
  const orderInit = companion.name('OrderInit', { typeOnly: true });
  const money = new ImportSource('./money.js', true);
  const moneyAlias = money.name('Money', { alias: '__golemClass0' });
  const unused = new ImportSource('./unused.js');
  unused.name('Never');
  const body = code`new ${orderBase}() as ${orderInit}; ${rt.serde.parseJson}(${rt.model.registerGeneratedModel}) as ${moneyAlias}`;
  assert.equal(
    render(join(fileImports(body, [money, unused, companion], { quote: '"' }), code`\n`)),
    'import type { Money as __golemClass0 } from "./money.js";\nimport { OrderBaseModel, type OrderInit } from "./order.golem.ts";',
  );
  assert.throws(() => fileImports(body, [companion]), /does not list among its import sources/);
  assert.equal(render(orderJson), 'OrderJSON');
  assert.equal(
    render(join(runtimeImports(body, { modules: ['serde', 'model'] }), code`\n`)),
    "import { parseJson, registerGeneratedModel } from '@exprtlabs/golem/internal/model-runtime';",
  );
  assert.throws(() => runtimeImports(body, { modules: ['serde'] }), /does not list in its module order/);
});

test('a helper that a file reads while it loads comes after the helper it names', () => {
  // protects: T-286 a helper used at load comes after its dependency
  const markKey: ReturnType<typeof helper> = helper('markKey', () => code`const markKey = Symbol.for('t286:mark');`);
  const checkedOptions: ReturnType<typeof helper> = helper('checkedOptions', () =>
    code`const checkedOptions = Object.freeze({ [${helperName(markKey)}]: true });`);
  const block = render(join(helperDefinitions(code`${helperName(checkedOptions)}`), code`\n\n`), new NameTable());
  assert.deepEqual(helperSet(code`${helperName(checkedOptions)}`).map((found) => found.id), ['markKey', 'checkedOptions']);
  // The file loads: the first constant would be read before it exists if the ids set the order.
  const loaded = runModule(block, {}, { exports: ['checkedOptions'] }).checkedOptions as Record<symbol, unknown>;
  assert.equal(loaded[Symbol.for('t286:mark')], true);
});

test('sameCode matches parts one by one by kind, so a runtime part is not the text of its name', () => {
  // protects: T-329 an emitter decides "unchanged" from Code parts; a local named like a runtime export is not that export
  const first = nameSlot('first');
  const second = nameSlot('second');
  const written = code`${rt.serde.stringifyJsonScalar}(item as never)`;
  assert.equal(sameCode(written, code`${rt.serde.stringifyJsonScalar}(item as never)`), true);
  assert.equal(sameCode(written, code`stringifyJsonScalar(item as never)`), false);
  assert.equal(sameCode(written, code`stringifyJsonString(item as never)`), false);
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

test('render writes no spaces on a blank line, and a line break that ends a nest is not indented as the nest', () => {
  // protects: rendered code has no trailing spaces on a blank line, and a closing brace is not indented as the nest it closes
  const block = code`{${nest(code`${lineBreak}a;${lineBreak}${lineBreak}b;${lineBreak}`)}}`;
  assert.equal(render(block), '{\n  a;\n\n  b;\n}');
});

test('a name that the code uses as a value and as a type is imported once, as the value', () => {
  // protects: a name used as a value and as a type is imported once, so the file has no duplicate identifier
  const source = new ImportSource('./shapes.js');
  const body = code`${source.name('Shape')} ${source.name('Shape', { typeOnly: true })} ${source.name('Size', { typeOnly: true })}`;
  assert.deepEqual(fileImports(body, [source]).map((line) => render(line)), ["import { Shape, type Size } from './shapes.js';"]);
  const groups = importGroups(code`${rt.serde.parseJson} ${rtType.serde.SerdeOptions} ${runtimeCode('serde', 'parseJson', true)}`);
  assert.deepEqual(groups.map((group) => [group.names, group.types]), [[[{ name: 'parseJson' }], []], [[], [{ name: 'SerdeOptions', typeOnly: true }]]]);
});

test('a name that two runtime modules of one specifier both use is imported once', () => {
  // protects: T-653 the serde and conversion keys share one entry, and a name both use is not imported twice
  const groups = importGroups(code`${runtimeCode('serde', 'IssueSource')} ${runtimeCode('conversion', 'IssueSource')} ${rt.serde.parseJson}`);
  assert.deepEqual(groups.map((group) => [group.specifier, group.modules, group.names]), [
    ['@exprtlabs/golem/internal/model-runtime', ['conversion', 'serde'], [{ name: 'IssueSource' }, { name: 'parseJson' }]],
  ]);
});

test('a helper that the code names and the file neither places nor writes into its code is an error', () => {
  // protects: a helper that the code calls but the file never places is an error, not a call of a missing function
  const lost = helper('lostHelper', () => code`function lostHelper() {}`);
  assert.throws(() => placeHelpers(code`${helperName(lost)}()`, []), /names the helper "lostHelper", which the file does not place/);
  assert.deepEqual(placeHelpers(code`${helperName(lost)}()`, [lost]).map((piece) => render(piece)), ['function lostHelper() {}']);
});

test('a chain of guards nested 20000 deep renders and tests for empty without a call per level', () => {
  // protects: rendering a deeply nested guard chain takes no call per level (the lazy flatten threw RangeError at depth 8000)
  const depth = 20000;
  let chain = code`fallback`;
  let expected = 'fallback';
  for (let level = 0; level < depth; level += 1) {
    chain = code`guard${literal(level)} ? (value${literal(level)}) : (${chain})`;
    expected = `guard${level} ? (value${level}) : (${expected})`;
  }
  assert.equal(render(chain), expected);
  assert.equal(isEmpty(chain), false);
  let nothing = code``;
  for (let level = 0; level < depth; level += 1) nothing = join([nothing, code``], code``);
  assert.equal(isEmpty(nothing), true);
});

test('two self-placed helpers of one id and one definition share it, and two that differ stop the file', () => {
  // protects: R-57 review finding 2 - a selector id is a hash of rendered text, so two selectors of one text but different imported classes must not share one definition
  const first = new ImportSource('./first.js').name('Shape');
  const second = new ImportSource('./second.js').name('Shape');
  const selector = (cls: typeof first) => selfPlacedHelper('__golemVariant_x', () => code`function __golemVariant_x(v) { return v instanceof ${cls} ? 0 : 1; }`);
  const same = code`${helperName(selector(first))}(a); ${helperName(selector(first))}(b);`;
  assert.deepEqual(placeHelpers(same, []).map((piece) => render(piece)), ['function __golemVariant_x(v) { return v instanceof Shape ? 0 : 1; }', '']);
  const different = code`${helperName(selector(first))}(a); ${helperName(selector(second))}(b);`;
  assert.throws(() => placeHelpers(different, []), /two different self-placed helpers are named "__golemVariant_x"/);
});

test('a local of generated code has a form that no other name can take, and a property key may hold it', () => {
  // protects: R-59 short locals cannot collide with a model, import, helper or parameter name
  assert.equal(render(code`${localCode('value', 3)} ${localCode('key')}`), '$v3 $k');
  assert.throws(() => identifier('$v3'), /form of a local of generated code/);
  assert.throws(() => new ImportSource('./user').name('$k'), /form of a local of generated code/);
  assert.throws(() => localCode('value3' as never), /needs one of the kinds/);
  assert.equal(render(propertyKey('$v3')), '$v3');
  assert.equal(render(identifier('$value')), '$value');
});

test('an export of a package module is imported from its own specifiers, in the code point order of the import keys', () => {
  // protects: T-801 core names no package: generated code reaches any package module through packageExport, and the import lines keep the order they had
  const wrap = packageExport({ key: 'extra', specifier: '@acme/pkg/internal/run', typeSpecifier: '@acme/pkg/api', name: 'wrap' });
  const wrapped = packageExport({ key: 'extra', specifier: '@acme/pkg/internal/run', typeSpecifier: '@acme/pkg/api', name: 'Wrapped', typeOnly: true });
  const body = code`${rt.model.registerGeneratedModel} ${wrap} ${wrapped} ${rt.client.ClientRuntime}`;
  assert.equal(
    render(join(runtimeImports(body), code`\n`)),
    "import { ClientRuntime } from '@exprtlabs/golem/internal/client-runtime';\n"
      + "import { wrap } from '@acme/pkg/internal/run';\nimport type { Wrapped } from '@acme/pkg/api';\n"
      + "import { registerGeneratedModel } from '@exprtlabs/golem/internal/model-runtime';",
  );
  assert.throws(() => packageExport({ key: 'model', specifier: '@acme/pkg', typeSpecifier: '@acme/pkg', name: 'wrap' }), /key of the golem runtime table/);
  assert.throws(() => runtimeImports(code`${wrap} ${packageExport({ key: 'extra', specifier: '@acme/other', typeSpecifier: '@acme/pkg/api', name: 'again' })}`), /two pairs of specifiers/);
});
