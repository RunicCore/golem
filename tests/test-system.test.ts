import assert from 'node:assert/strict';
import test from 'node:test';
import { imageMismatches, selectFocused } from '../scripts/test-tier.js';

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

test('image check passes when node, npm, playwright and browsers match', () => {
  const facts = { node: 'v22.12.0', npm: '10.9.8', playwright: '1.63.0', browsersPresent: true };
  assert.deepEqual(imageMismatches(facts, { node: 'v22.12.0', npm: '10.9.8', playwright: '1.63.0' }), []);
});

test('image check names each failed check', () => {
  const expected = { node: 'v22.12.0', npm: '10.9.8', playwright: '1.63.0' };
  const mismatches = imageMismatches({ node: 'v24.0.0', npm: '11.0.0', playwright: '1.60.0', browsersPresent: false }, expected);
  assert.equal(mismatches.length, 4);
  assert.match(mismatches[0], /^node is v24\.0\.0/);
  assert.match(mismatches[1], /^npm is 11\.0\.0/);
  assert.match(mismatches[2], /^@playwright\/test is 1\.60\.0, expected 1\.63\.0/);
  assert.match(mismatches[3], /browsers directory is missing/);
  assert.match(imageMismatches({ node: expected.node, npm: expected.npm, playwright: undefined, browsersPresent: true }, expected)[0], /not installed/);
});
