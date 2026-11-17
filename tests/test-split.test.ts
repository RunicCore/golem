import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateWall, splitForCeiling, type CostedFile } from '../scripts/test-split.js';
import { groupArguments, selectFocused, splitTypescriptLane } from '../scripts/test-tier.js';

const costed = (...seconds: number[]): CostedFile[] => seconds.map((value, index) => ({ file: `.build/tests/f${String(index).padStart(2, '0')}.test.js`, seconds: value }));
const names = (groups: readonly (readonly CostedFile[])[]): string[] => groups.flat().map(item => item.file).sort();
const wall = (group: readonly CostedFile[], width: number): number => estimateWall(group.map(item => item.seconds), width);

test('a set that fits under the ceiling is one run', () => {
  const files = costed(60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60);
  const groups = splitForCeiling(files, { width: 8, ceiling: 180 });
  assert.equal(groups.length, 1);
  assert.deepEqual(names(groups), names([files]));
});

test('a set that would pass the ceiling (the 16 files that needed 254 s in one run, T-1073) runs as the fewest runs that fit, with every file once', () => {
  const files = costed(213.6, 150.6, 144.2, 142.8, 138.8, 134.9, 131.8, 114.1, 114, 108.5, 103.6, 99.1, 91.1, 81.4, 79.5, 65.4);
  const groups = splitForCeiling(files, { width: 8, ceiling: 180 });
  assert.equal(groups.length, 2);
  assert.deepEqual(names(groups), names([files]));
  for (const group of groups) assert.ok(wall(group, 8) <= 135, `a run of ${wall(group, 8)} s`);
});

test('a file that alone passes its share of the ceiling runs alone and does not cut the other files', () => {
  const files = costed(1200, 10, 10);
  const groups = splitForCeiling(files, { width: 8, ceiling: 180 });
  assert.deepEqual(groups.map(group => group.map(item => item.seconds)), [[1200], [10, 10]]);
});

test('the lane and the flags of a focused call go to each run, and the files of the run are the only files it selects', () => {
  const original = splitTypescriptLane(['--typescript', '6', '--test-name-pattern', 'rows', 'tests/a.test.ts', 'tests/b.test.ts']);
  assert.equal(original.lane6, true);
  const { files, passThrough } = selectFocused(original.rest, original.lane6);
  assert.deepEqual(files, ['.build/tests/a.test.js', '.build/tests/b.test.js']);

  const run = splitTypescriptLane(groupArguments(original.lane6, passThrough, ['.build/tests/b.test.js']));
  assert.equal(run.lane6, true);
  assert.deepEqual(selectFocused(run.rest, run.lane6), { files: ['.build/tests/b.test.js'], passThrough, needsPack: false });

  assert.equal(splitTypescriptLane(groupArguments(false, [], ['.build/tests/b.test.js'])).lane6, false);
});
