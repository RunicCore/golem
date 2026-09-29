import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { identifier, joinSource, literal, tsSource } from './source-template.js';

test('typed source templates preserve literal values without executing their contents', () => {
  const values = ['quote\" and \'', '\\n versus\nnewline', '` ${globalThis.injected = true}', '\u2028\u2029', '雪', null, undefined, true, false, 12.5, -0, NaN, Infinity, -Infinity, 19n];
  for (const value of values) {
    const context = { injected: false };
    const source = tsSource`(() => { const ${identifier('value')} = ${literal(value)}; return value; })()`;
    assert.ok(Object.is(runInNewContext(source.text, context), value));
    assert.equal(context.injected, false);
  }
});

test('identifier interpolation accepts valid names and rejects invalid or reserved bindings', () => {
  for (const name of ['Item0', '_value', '$value', 'élève', '雪']) {
    const source = tsSource`(() => { const ${identifier(name)} = 3; return ${identifier(name)}; })()`;
    assert.equal(runInNewContext(source.text), 3);
  }
  for (const name of ['', '1item', 'item-name', 'a.b', 'x; throw Error()', 'class', 'await', 'eval', 'arguments']) {
    assert.throws(() => identifier(name), /Invalid source identifier/);
  }
});

test('identifier rejects runtime non-strings without coercing them', () => {
  let coercions = 0;
  const hostile = {
    toString() {
      coercions++;
      return coercions === 1 ? 'safeName' : 'injected; throw Error("executed")';
    },
  };
  assert.throws(() => Reflect.apply(identifier, undefined, [hostile]), TypeError);
  assert.equal(coercions, 0);
});

test('source fragments compose while untyped raw interpolation is rejected', () => {
  const declarations = joinSource([tsSource`const first = ${literal('one')};`, tsSource`const second = ${literal('two')};`]);
  const source = tsSource`(() => { ${declarations} return first + second; })()`;
  assert.equal(runInNewContext(source.text), 'onetwo');
  assert.throws(() => Reflect.apply(tsSource, undefined, [['const x = ', ';'], 'unwrapped']), /Source interpolation requires/);
});
