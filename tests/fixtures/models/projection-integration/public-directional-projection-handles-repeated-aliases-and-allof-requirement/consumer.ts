
import assert from 'node:assert/strict';
import { ProjectionClient, UserBaseModel, type InputSchemas, type OutputSchemas } from './sdk/index.js';
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
const input: InputSchemas.User = { name: 'Ada', secretOne: 'one', secretTwo: 'two' };
const output: OutputSchemas.User = { name: 'Ada', first: 'id-1', second: 'id-2' };
let calls = 0;
const client = new ProjectionClient({ baseUrl: 'https://example.test', fetchImpl: async (url, init) => {
  calls += 1;
  const request = new Request(url, init);
  if (request.url.endsWith('/control')) return new Response(null, { status: 204 });
  assert.deepEqual(await request.json(), input);
  return Response.json(output);
} });
await assert.rejects(client.control().execute({ body: {} }), /validation/i);
assert.equal(calls, 0);
assert.deepEqual((await client.createUser().execute({ body: input })).body, output);
assert.equal(calls, 1);
assert.equal((await client.control().execute({ body: { token: 'present' } })).status, 204);
assert.equal(await getValidator(fromWireFormat<UserBaseModel>({ name: 'Ada' }, { validate: false })).validate(), false);
assert.equal(await getValidator(fromWireFormat<UserBaseModel>({ ...input, ...output })).validate(), true);
