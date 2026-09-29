import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFocused } from '../scripts/test-tier.js';

test('focused maps test sources to built files and keeps node --test flags', () => {
  assert.deepEqual(selectFocused(['tests/serde.test.ts', '--test-name-pattern', 'union']), {
    files: ['.build/tests/serde.test.js'],
    passThrough: ['--test-name-pattern', 'union'],
    needsPack: false,
  });
});

test('focused packs first when a packed or browser file is selected', () => {
  assert.equal(selectFocused(['tests/packed/consumers.test.ts']).needsPack, true);
  assert.equal(selectFocused(['.build/tests/browser/packed-runtime.test.js']).needsPack, true);
});

test('focused without a selection is a usage error', () => {
  assert.throws(() => selectFocused([]), /Select test files or --test-name-pattern/);
});

test('focused accepts a name pattern alone and runs it over the unit files', () => {
  const selection = selectFocused(['--test-name-pattern=codec']);
  assert.ok(selection.files.includes('.build/tests/*.test.js'));
  assert.equal(selection.needsPack, false);
});
