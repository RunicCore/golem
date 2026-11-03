
import assert from 'node:assert/strict';
import { ResourceGraphClient } from './index.js';

const wholeBody = { score: 42, nested: { name: 'nested' }, leaf: { label: 'leaf' } };
const nestedBody = { name: 'nested' };
let calls = 0;
const client = new ResourceGraphClient({
  baseUrl: 'https://example.test',
  fetchImpl: async (url, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    switch (new URL(String(url)).pathname) {
      case '/graph/whole': return Response.json(wholeBody);
      case '/graph/score': return Response.json(42);
      case '/graph/nested': return Response.json(nestedBody);
      default: throw new Error('unexpected graph route');
    }
  },
});
const whole = await client.getWhole().execute({});
assert.deepEqual(whole.body, wholeBody);
const score = await client.getScore().execute({});
const scoreValue: number = score.body;
assert.equal(scoreValue, 42);
const nested = await client.getNested().execute({});
const nestedValue: { name: string } = nested.body;
assert.deepEqual(nestedValue, nestedBody);
assert.equal(calls, 3);

const invalidScoreClient = new ResourceGraphClient({
  baseUrl: 'https://example.test',
  fetchImpl: async () => Response.json(wholeBody),
});
await assert.rejects(() => invalidScoreClient.getScore().execute({}), /validation/i);

const invalidNestedClient = new ResourceGraphClient({
  baseUrl: 'https://example.test',
  fetchImpl: async () => Response.json(42),
});
await assert.rejects(() => invalidNestedClient.getNested().execute({}), /validation/i);
