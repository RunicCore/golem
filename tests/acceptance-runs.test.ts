import assert from 'node:assert/strict';
import { test } from 'node:test';

import { steps, type Tier } from '../scripts/test-tier.js';

// Building the steps starts none of them; the lane's step only needs the variable that the container sets.
process.env.GOLEM_TYPESCRIPT6_ROOT ??= '/typescript6';

const labels = (tier: Tier): string[] => steps(tier, []).flat(2).map(step => step.label);

test('the two runs of acceptance hold each step of the gate once, pack comes before each step that reads the packed set, and the TypeScript 6 lane is alone in its chain', () => {
  assert.deepEqual(labels('acceptance'), ['public source', 'OpenAPI compliance', 'unit', 'pack', 'packed smoke', 'lint', 'examples']);
  assert.deepEqual(labels('acceptance-rest'), ['typescript 6', 'pack', 'packed', 'browser', 'acceptance unit']);
  const laneChain = steps('acceptance-rest', []).flat().find(chain => chain.some(step => step.label === 'typescript 6'));
  assert.deepEqual(laneChain?.map(step => step.label), ['typescript 6']);
});
