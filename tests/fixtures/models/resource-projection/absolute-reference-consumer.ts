
import assert from 'node:assert/strict';
import { AbsoluteResourceReferenceClient } from './index.js';

let calls = 0;
const client = new AbsoluteResourceReferenceClient({
  baseUrl: 'https://example.test',
  fetchImpl: async (url, init) => {
    calls += 1;
    assert.equal(new URL(String(url)).pathname, '/value');
    assert.equal(init?.method, 'GET');
    return Response.json({ value: 'resolved' });
  },
});
const response = await client.getValue().execute({});
assert.deepEqual(response.body, { value: 'resolved' });
assert.equal(calls, 1);

const invalidResponseClient = new AbsoluteResourceReferenceClient({
  baseUrl: 'https://example.test',
  fetchImpl: async () => Response.json({ value: 42 }),
});
await assert.rejects(() => invalidResponseClient.getValue().execute({}), /validation/i);
