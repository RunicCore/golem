
import assert from 'node:assert/strict';
import { ResourceProjectionClient } from './index.js';

const requestBody = {
  root: { value: 'root', children: [{ value: 'child', children: [] }] },
  embedded: { code: 'embedded', child: { value: 7 } },
  anchored: { name: 'top', again: { name: 'nested' } },
  treeAlias: { value: 'alias', children: [] },
  clientSecret: 'client-secret',
  literal: {},
};
const responseBody = {
  root: { value: 'root', serverValue: 'server-root', children: [{ value: 'child', serverValue: 'server-child', children: [] }] },
  embedded: { code: 'embedded', child: { value: 7, serverValue: 'server-child' } },
  anchored: { name: 'top', serverValue: 'server-top', again: { name: 'nested', serverValue: 'server-nested' } },
  treeAlias: { value: 'alias', serverValue: 'server-alias', children: [] },
  serverValue: 'server-value',
  literal: {},
};
let calls = 0;
const client = new ResourceProjectionClient({
  baseUrl: 'https://example.test',
  fetchImpl: async (url, init) => {
    calls += 1;
    const request = new Request(url, init);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, 'https://example.test/trees/tree-1');
    assert.deepEqual(await request.json(), requestBody);
    return Response.json(responseBody);
  },
});
const result = await client.saveTree().execute({ path: { id: 'tree-1' }, body: requestBody });
assert.deepEqual(result.body, responseBody);
assert.equal(calls, 1);

const invalidResponseClient = new ResourceProjectionClient({
  baseUrl: 'https://example.test',
  fetchImpl: async () => Response.json({ ...responseBody, clientSecret: 'must-not-be-output' }),
});
await assert.rejects(
  () => invalidResponseClient.saveTree().execute({ path: { id: 'tree-1' }, body: requestBody }),
  /validation/i,
);
