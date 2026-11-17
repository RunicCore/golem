import assert from 'node:assert/strict';
import { test } from 'node:test';

import { steps, type Tier } from '../scripts/test-tier.js';

// Building the steps starts none of them; the lane's step only needs the variable that the container sets.
process.env.GOLEM_TYPESCRIPT6_ROOT ??= '/typescript6';

const runs: readonly Tier[] = ['acceptance', 'acceptance-rest'];
const chainsOf = (tier: Tier) => steps(tier, []).flat();
const readerCount = runs.flatMap(tier => chainsOf(tier).flat()).filter(step => step.readsPacked).length;

test('in each acceptance run, pack comes before every step that reads the packed set, in the same chain', () => {
  const withoutPack = runs.flatMap(tier => chainsOf(tier).flatMap(chain => chain.flatMap((step, index) =>
    step.readsPacked && !chain.slice(0, index).some(before => before.label === 'pack') ? [`${tier}: ${step.label}`] : [])));
  assert.ok(readerCount > 0, 'no step of Acceptance reads the packed set, so this check proves nothing');
  assert.deepEqual(withoutPack, []);
});

test('no step but pack runs in both acceptance runs, and the TypeScript 6 lane is alone in its chain', () => {
  const labels = runs.flatMap(tier => chainsOf(tier).flat().map(step => step.label)).filter(label => label !== 'pack');
  assert.equal(new Set(labels).size, labels.length);
  const laneChain = chainsOf('acceptance-rest').find(chain => chain.some(step => step.label === 'typescript 6'));
  assert.deepEqual(laneChain?.map(step => step.label), ['typescript 6']);
});
