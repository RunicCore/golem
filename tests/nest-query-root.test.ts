import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller, Get, Module, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { nestModelCodec, NestModelInterceptor } from '@exprtlabs/golem/nest';
import { createObjectCodec } from '@exprtlabs/golem/serde';

const BASE_SCHEMA = {
  type: 'object',
  properties: { limit: { type: 'number' }, active: { type: 'boolean' }, name: { type: 'string' } },
};

/** A codec that checks nothing and hands the wire value on, so the test sees what the interceptor decoded. */
function register(id: string, schema: object): void {
  createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (wire) => wire as never,
    schema,
  });
}

/** Serves `GET /?<query>` through NestModelInterceptor for a whole @Query() model of codec `id`, and returns the query the handler received. */
async function queryReceived(id: string, query: string): Promise<unknown> {
  class QueryController {
    list(received: unknown) { return { received }; }
  }
  Controller()(QueryController);
  const descriptor = Object.getOwnPropertyDescriptor(QueryController.prototype, 'list');
  assert.ok(descriptor);
  Get()(QueryController.prototype, 'list', descriptor);
  Query()(QueryController.prototype, 'list', 0);
  nestModelCodec(id)(QueryController.prototype, 'list', 0);
  class AppModule {}
  Module({ controllers: [QueryController] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`${await application.getUrl()}/?${query}`);
    assert.equal(response.status, 200);
    return ((await response.json()) as { received: unknown }).received;
  } finally {
    await application.close();
  }
}

// protects: T-377 E-49 a whole @Query() model whose schema root is a $ref decoded nothing and handed the handler raw strings
const DECODED = { limit: 10, active: true, name: '7' };
const refRoots = [
  { name: 'a root $ref to another codec by its id', schema: { $ref: 'QueryRootBase_1' }, expected: { ...DECODED, page: '2' } },
  {
    name: 'a root $ref to a local definition that names a codec',
    schema: { $ref: '#/$defs/Base', $defs: { Base: { $ref: 'QueryRootBase_1' } } },
    expected: { ...DECODED, page: '2' },
  },
  {
    name: 'a root allOf branch that is a $ref',
    schema: { allOf: [{ $ref: 'QueryRootBase_1' }, { type: 'object', properties: { page: { type: 'integer' } } }] },
    expected: { ...DECODED, page: 2 },
  },
  {
    name: 'a root $ref that names the root itself, which ends without a loop',
    schema: { $ref: '#', properties: { page: { type: 'integer' } } },
    expected: { limit: '10', active: 'true', name: '7', page: 2 },
  },
] as const;
register('QueryRootBase_1', BASE_SCHEMA);
for (const [index, { name, schema, expected }] of refRoots.entries()) {
  test(`NestModelInterceptor decodes a whole @Query() model with ${name}`, async () => {
    register(`QueryRoot_${index}`, schema);
    assert.deepEqual(await queryReceived(`QueryRoot_${index}`, 'limit=10&active=true&name=7&page=2'), expected);
  });
}
