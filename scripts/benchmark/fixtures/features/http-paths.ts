import assert from 'node:assert/strict';
import { nestQueryDecoder } from '@exprtlabs/golem-ts-openapi/nest';
import { nestModelCodec } from '@exprtlabs/golem-ts-openapi/internal/nest-runtime';
import { LibError } from '@exprtlabs/golem/errors';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import 'reflect-metadata';
import { codecIdOf } from './codec-id.js';
import type { ComparisonFixture } from './fixture-contract.js';
import { NestQuery } from './http-paths.model.js';
import { PaymentsClient } from './sdk/index.js';

registerIModelClass(codecIdOf('TNestQuery'), NestQuery);

export type HttpPathName = 'nest-query' | 'client-call';

const consume = (value: unknown): number => typeof value === 'object' && value !== null ? 1 : 0;

/** The query object that Express gives a handler for `?limit=25&active=true&ids=1&ids=2&ids=3&tags=a&tags=b&q=shoes&since=...`: strings, and a repeated key as an array of strings. */
const queryWire = () => ({ limit: '25', active: 'true', ids: ['1', '2', '3'], tags: ['a', 'b'], q: 'shoes', since: '2026-01-01T00:00:00.000Z' });

/**
 * The token that a `@Query()` parameter of this model carries, built as the nest rewrite builds it: `nestModelCodec` binds the codec id
 * to the parameter's `design:paramtypes` entry, and `nestQueryDecoder` reads it from there.
 */
function queryToken(codecId: string): unknown {
  class Handler {}
  nestModelCodec(codecId)(Handler.prototype, 'handle', 0);
  return (Reflect as unknown as { getMetadata(key: string, target: object, property: string): unknown[] }).getMetadata('design:paramtypes', Handler.prototype, 'handle')[0];
}

/**
 * `nest-query`: the decode a NestJS handler does on its query. The query-field table (`codec.data.nest`) comes from the nest extension's
 * `model.codecData` hook, which project.ts turns on for the generated models, as a Nest app's build does.
 */
function nestQueryFixture(validation: boolean): ComparisonFixture {
  const codecId = codecIdOf('TNestQuery');
  const codec = requireObjectCodec(codecId);
  const decodeQuery = nestQueryDecoder(queryToken(codecId));
  assert.ok(decodeQuery, 'nestQueryDecoder found no codec for the query model');
  const payload = queryWire();
  const decodeOptions = { ...(validation ? {} : { validate: false as const }), construct: NestQuery };
  return {
    name: 'nest-query', payload, consume,
    operations: { 'object-to-model': () => codec.fromWireFormat(decodeQuery(payload), decodeOptions) },
    verify: async () => {
      const original = structuredClone(payload);
      const decoded = codec.fromWireFormat(decodeQuery(payload), decodeOptions) as NestQuery;
      assert.ok(decoded instanceof NestQuery);
      assert.deepEqual([decoded.limit, decoded.active, decoded.ids, decoded.tags, decoded.q], [25, true, [1, 2, 3], ['a', 'b'], 'shoes']);
      assert.ok(decoded.since instanceof Date);
      assert.deepEqual(payload, original);
      if (!validation) return;
      // A query that does not fit its type stays a string, so the validator rejects it, and the error blames the input.
      assert.throws(() => codec.fromWireFormat(decodeQuery({ ...queryWire(), limit: 'many' }), decodeOptions), (error: unknown) => error instanceof LibError && error.causedByInput);
    },
  };
}

const MONEY = { amount: 12.5, currency: 'USD' };

/**
 * `client-call`: one call of the generated Money client (`createPayment`, a POST with a JSON body) on a fetch stub. No network. A body can be read
 * once, so the stub builds a new `Response` for each call; its constructor is part of the timed work. The stub keeps the request body it got.
 */
function clientCallFixture(): ComparisonFixture {
  const text = JSON.stringify(MONEY);
  const responseInit = { status: 201, headers: { 'content-type': 'application/json' } };
  let sent: unknown;
  const fetchImpl: typeof fetch = async (_url, init) => { sent = init?.body; return new Response(text, responseInit); };
  const createPayment = new PaymentsClient({ baseUrl: 'http://bench.invalid', fetchImpl }).createPayment();
  const input = { body: MONEY };
  return {
    name: 'client-call', payload: MONEY, consume,
    operations: { call: () => createPayment.execute(input) },
    verify: async () => {
      const original = structuredClone(MONEY);
      const response = await createPayment.execute(input);
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, MONEY);
      assert.equal(sent, text, 'the request body is the expected wire text');
      assert.deepEqual(MONEY, original);
    },
  };
}

/** The HTTP-edge payloads of the golem cost table: the NestJS query decode and a generated client call. */
export function createHttpPathFixtures(validation: boolean): readonly ComparisonFixture[] {
  return [nestQueryFixture(validation), clientCallFixture()];
}
