import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validationSchemaModuleNames } from '#openapi/schemas';

const root = 'urn:golem:openapi:t:0123abcd:schemas';
const entry = (name: string, direction: 'input' | 'output') => ({ id: `${root}:component:${name}:${direction}`, name, direction });

test('schema files are named by component and direction', () => {
  const names = validationSchemaModuleNames([entry('Money', 'output'), entry('Money', 'input')], root);
  assert.equal(names.get(`${root}:component:Money:output`), 'validation-schemas/Money.output.ts');
  assert.equal(names.get(`${root}:component:Money:input`), 'validation-schemas/Money.input.ts');
});

test('names that differ only by case both get a short id suffix', () => {
  const names = [...validationSchemaModuleNames([entry('Money', 'output'), entry('money', 'output')], root).values()];
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 2);
  for (const name of names) assert.match(name, /^validation-schemas\/[Mm]oney\.output-[0-9a-f]{6}\.ts$/);
});

test('awkward component names become short, legal file names', () => {
  const names = validationSchemaModuleNames([entry('Money/v2', 'output'), entry('a:b', 'input'), entry('X'.repeat(200), 'output')], root);
  for (const file of names.values()) {
    assert.match(file, /^validation-schemas\/[A-Za-z0-9_$-]+\.(input|output)(-[0-9a-f]{6})?\.ts$/);
    assert.ok(file.length <= 100, file);
  }
});

test('the document digest never appears in a schema file name', () => {
  const before = validationSchemaModuleNames([entry('Money', 'output')], root);
  const edited = 'urn:golem:openapi:t:ffff0000:schemas';
  const after = validationSchemaModuleNames([{ id: `${edited}:component:Money:output`, name: 'Money', direction: 'output' }], edited);
  assert.deepEqual([...before.values()], [...after.values()]);
});
