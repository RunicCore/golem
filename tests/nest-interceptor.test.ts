import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { defaultIfEmpty, firstValueFrom, map, of, type Observable } from 'rxjs';
import { NestModelInterceptor, type NestModelInterceptorOptions, nestModelStringifyInterceptor, nestUnionFromMetatype, objectCodecFromMetatype } from '@exprtlabs/golem-ts-openapi/nest';
import { nestModelCodec, nestModelReturn, nestModelUnion } from '@exprtlabs/golem-ts-openapi/internal/nest-runtime';
import { LibError, type LibErrorKind } from '@exprtlabs/golem/errors';
import { deserializeDate, unknownDiscriminatorValue, assertModelValue, isValidModelValue } from '@exprtlabs/golem/internal/model-runtime';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { schemaForDescriptor } from '@exprtlabs/golem/internal/schema';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { nodeQueryFields } from '#golem/query-fields';
import { getObjectCodec, IssueRepresentation, IssueSource, type QueryFieldTable } from '@exprtlabs/golem/serde';

import { readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { compileSchema } from './support/compiled-validators.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { decorateQueryModel, startNestApp } from './support/nest-app.js';
import { registerPassThroughCodec } from './support/pass-through-codec.js';
import { modelCodec } from './support/model-codec.js';

function markerCodec(id: string) {
  return registerPassThroughCodec(id, { fromWireFormat: () => ({ converted: true }) });
}

/** Registers the codec of `id` with the schema of `descriptor`. Its wire values are validated and then handed to `convert`. */
async function registerValidatingCodec(id: string, descriptor: ModelTypeDescriptor, convert: (wire: unknown) => unknown = (wire) => wire): Promise<void> {
  const assembled = schemaForDescriptor(descriptor, { representation: 'model' });
  assert.ok(typeof assembled === 'object');
  const schema = { $id: id, ...assembled };
  const validate = await compileSchema(schema);
  const graph = createSchemaGraph();
  graph.intern(descriptor, id);
  graph.seal();
  const node = graph.nodeFor(descriptor, id);
  assert.ok(node);
  const queryFields = nodeQueryFields(graph, node);
  registerPassThroughCodec(id, {
    ...(queryFields ? { queryFields } : {}),
    validate: (value) => isValidModelValue(value, undefined, validate, id),
    fromWireFormat: (wire) => {
      assertModelValue(wire, undefined, validate, id, IssueRepresentation.Wire, IssueSource.OpenAPI);
      return convert(wire) as never;
    },
  });
}

function decorateCreate(klass: new () => { create(input: unknown): unknown }, id: string): void {
  Controller()(klass);
  const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, 'create');
  assert.ok(descriptor);
  Post()(klass.prototype, 'create', descriptor);
  Body()(klass.prototype, 'create', 0);
  nestModelCodec(id)(klass.prototype, 'create', 0);
}

type ResponseProbe = {
  readonly headers: Map<string, string>;
  /** Interceptors never write the body; Nest writes the value they yield. */
  body: string | undefined;
}

function adapterResponse(
  adapter: 'express' | 'fastify',
  probe: ResponseProbe,
): object {
  const send = (body: string) => { probe.body = body; };
  if (adapter === 'express') {
    return {
      setHeader(name: string, value: string) { probe.headers.set(name, value); },
      send,
    };
  }
  return {
    header(name: string, value: string) { probe.headers.set(name, value); },
    send,
  };
}

function httpContext(klass: Function, handler: Function, request: object = {}, response: object = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => klass,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

async function runInterceptor(
  interceptor: NestInterceptor,
  response: object,
  value: unknown,
): Promise<unknown> {
  const context = httpContext(AdapterWriterController, AdapterWriterController.prototype.write, {}, response);
  const next: CallHandler<unknown> = { handle: () => of(value) };
  const result = await interceptor.intercept(context, next);
  return firstValueFrom(result.pipe(defaultIfEmpty(undefined)));
}

function interceptResponse(
  interceptor: NestInterceptor,
  response: object,
  values: readonly unknown[],
  target: { readonly klass: Function; readonly handler: Function } = {
    klass: AdapterWriterController,
    handler: AdapterWriterController.prototype.write,
  },
): Observable<unknown> {
  const context = httpContext(target.klass, target.handler, {}, response);
  const next: CallHandler<unknown> = { handle: () => of(...values) };
  const result = interceptor.intercept(context, next);
  if (result instanceof Promise) throw new Error('Nest model interceptors return their response Observable synchronously.');
  return result;
}

class AdapterWriterController {
  write(): unknown { return undefined; }
}

function decorateReturn(klass: Function, name: string, id: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, name);
  assert.ok(descriptor);
  nestModelReturn(id)(klass.prototype, name, descriptor);
}

test('nestModelCodec binds the registered codec instance at decorate', () => {
  const id = 'Bound_aaaaaaaa';
  const codec = markerCodec(id);
  class BoundController {
    create(input: unknown) {
      return input;
    }
  }
  decorateCreate(BoundController, id);
  const types = Reflect.getOwnMetadata('design:paramtypes', BoundController.prototype, 'create') as unknown[];
  assert.equal(objectCodecFromMetatype(types[0]), codec);
  assert.equal(objectCodecFromMetatype(types[0]), getObjectCodec(id));
});

test('Nest JSON writers write independently to each adapter response across interceptor and adapter variants', async () => {
  const id = 'AdapterWriter_cccccccc';
  const codec = markerCodec(id);
  decorateReturn(AdapterWriterController, 'write', id);

  const exercises: readonly [string, NestInterceptor, 'express' | 'fastify'][] = [
    ['model-express', new NestModelInterceptor(), 'express'],
    ['model-fastify', new NestModelInterceptor(), 'fastify'],
    ['stringify-express', nestModelStringifyInterceptor(codec), 'express'],
    ['stringify-fastify', nestModelStringifyInterceptor(codec), 'fastify'],
  ];
  for (const [label, interceptor, adapter] of exercises) {
    const first: ResponseProbe = { headers: new Map(), body: undefined };
    const second: ResponseProbe = { headers: new Map(), body: undefined };
    const firstResult = await runInterceptor(interceptor, adapterResponse(adapter, first), { id: `${label}-first` });
    const secondResult = await runInterceptor(interceptor, adapterResponse(adapter, second), { id: `${label}-second` });
    assert.equal(first.headers.get('Content-Type'), 'application/json; charset=utf-8', `${label} first response header`);
    assert.equal(second.headers.get('Content-Type'), 'application/json; charset=utf-8', `${label} second response header`);
    // The serialized JSON is the route result that Nest writes; the interceptor sends nothing itself.
    assert.equal(firstResult, JSON.stringify({ id: `${label}-first` }), `${label} first result`);
    assert.equal(secondResult, JSON.stringify({ id: `${label}-second` }), `${label} second result`);
    assert.equal(first.body, undefined, `${label} does not write the first response`);
    assert.equal(second.body, undefined, `${label} does not write the second response`);
  }
});

test('Nest model interceptors keep shared nullish forwarding scoped to each async request and cancellable', async () => {
  const id = 'NullAsyncContext_aaaaaaaa';
  const codec = markerCodec(id);
  decorateReturn(AdapterWriterController, 'write', id);
  const exercises: readonly [string, NestInterceptor][] = [
    ['class', new NestModelInterceptor()],
    ['factory', nestModelStringifyInterceptor(codec)],
  ];

  for (const [label, interceptor] of exercises) {
    const storage = new AsyncLocalStorage<{ readonly requestId: string }>();
    const request = (requestId: string): Promise<{
      readonly values: unknown[];
      readonly requestIds: (string | undefined)[];
      readonly probe: ResponseProbe;
    }> => new Promise((resolve, reject) => {
      const probe: ResponseProbe = { headers: new Map(), body: undefined };
      const values: unknown[] = [];
      const requestIds: (string | undefined)[] = [];
      storage.run({ requestId }, () => {
        interceptResponse(interceptor, adapterResponse('express', probe), [null, undefined]).subscribe({
          next: (value) => {
            values.push(value);
            requestIds.push(storage.getStore()?.requestId);
          },
          error: reject,
          complete: () => resolve({ values, requestIds, probe }),
        });
      });
    });
    const [first, second] = await Promise.all([
      request(`${label}-first`),
      request(`${label}-second`),
    ]);
    assert.deepEqual(first.values, [null, undefined]);
    assert.deepEqual(second.values, [null, undefined]);
    assert.deepEqual(first.requestIds, [`${label}-first`, `${label}-first`]);
    assert.deepEqual(second.requestIds, [`${label}-second`, `${label}-second`]);
    assert.equal(first.probe.headers.size, 0);
    assert.equal(first.probe.body, undefined);
    assert.equal(second.probe.headers.size, 0);
    assert.equal(second.probe.body, undefined);

    let cancelledEmissions = 0;
    let cancelledCompletion = false;
    const cancelled = interceptResponse(
      interceptor,
      adapterResponse('express', { headers: new Map(), body: undefined }),
      [null, undefined],
    ).subscribe({
      next: () => { cancelledEmissions += 1; },
      complete: () => { cancelledCompletion = true; },
    });
    cancelled.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelledEmissions, 0, `${label} cancellation prevents forwarded emissions`);
    assert.equal(cancelledCompletion, false, `${label} cancellation prevents completion`);
  }
});

test('Nest model interceptors serialize mixed values and preserve nullish emission order', async () => {
  const id = 'MixedTiming_eeeeeeee';
  const codec = markerCodec(id);
  decorateReturn(AdapterWriterController, 'write', id);

  for (const interceptor of [new NestModelInterceptor(), nestModelStringifyInterceptor(codec)]) {
    const probe: ResponseProbe = { headers: new Map(), body: undefined };
    const response$ = interceptResponse(
      interceptor,
      adapterResponse('express', probe),
      [null, { id: 'middle' }, undefined],
    );
    const emissions: unknown[] = [];
    const completion = new Promise<void>((resolve, reject) => {
      response$.subscribe({
        next: (value) => emissions.push(value),
        error: reject,
        complete: resolve,
      });
    });
    assert.deepEqual(emissions, [], 'every value remains deferred until a Promise microtask');
    assert.equal(probe.headers.get('Content-Type'), 'application/json; charset=utf-8', 'the model value marks the response as JSON');
    await completion;
    assert.deepEqual(emissions, [null, JSON.stringify({ id: 'middle' }), undefined], 'values retain their source order');
    assert.equal(probe.body, undefined);
  }
});

test('Nest model interceptors expose stringify and response-writer throws as observable errors', async () => {
  const id = 'Throwing_eeeeeeee';
  const throwingCodec = registerPassThroughCodec(id, { stringify: () => { throw new Error('codec stringify failed'); } });
  decorateReturn(AdapterWriterController, 'write', id);
  const stringifyCases: readonly [string, NestInterceptor][] = [
    ['model interceptor', new NestModelInterceptor()],
    ['factory interceptor', nestModelStringifyInterceptor(throwingCodec)],
  ];
  for (const [label, interceptor] of stringifyCases) {
    const probe: ResponseProbe = { headers: new Map(), body: undefined };
    await assert.rejects(
      firstValueFrom(interceptResponse(interceptor, adapterResponse('express', probe), [{ id: label }])),
      /codec stringify failed/,
      `${label} codec failure remains observable`,
    );
    assert.equal(probe.headers.size, 0, 'a failed codec does not invoke the response writer');
  }

  const writerCodec = markerCodec('WriterThrow_ffffffff');
  decorateReturn(AdapterWriterController, 'write', 'WriterThrow_ffffffff');
  const writerCases: readonly [string, NestInterceptor][] = [
    ['model response writer', new NestModelInterceptor()],
    ['factory response writer', nestModelStringifyInterceptor(writerCodec)],
  ];
  for (const [label, interceptor] of writerCases) {
    const response = { setHeader() { throw new Error('response header failed'); } };
    await assert.rejects(
      firstValueFrom(interceptResponse(interceptor, response, [{ id: label }])),
      /response header failed/,
      `${label} failure remains observable`,
    );
  }
});

test('Nest return metadata cache is per controller and handler and codec lookup stays live', async () => {
  const firstId = 'CachedFirst_11111111';
  const secondId = 'CachedSecond_22222222';
  const otherControllerId = 'CachedOther_33333333';
  registerPassThroughCodec(firstId, { stringify: (value) => JSON.stringify({ first: value }) });
  registerPassThroughCodec(secondId, { stringify: (value) => JSON.stringify({ second: value }) });
  registerPassThroughCodec(otherControllerId, { stringify: (value) => JSON.stringify({ other: value }) });
  const sharedWrite = function write() { return undefined; };
  const secondWrite = function writeSecond() { return undefined; };
  const plainWrite = function plainWrite() { return undefined; };
  class FirstController {}
  class SecondController {}
  Object.defineProperty(FirstController.prototype, 'write', { value: sharedWrite });
  Object.defineProperty(FirstController.prototype, 'writeSecond', { value: secondWrite });
  Object.defineProperty(FirstController.prototype, 'plainWrite', { value: plainWrite });
  Object.defineProperty(SecondController.prototype, 'write', { value: sharedWrite });
  const firstDescriptor = Object.getOwnPropertyDescriptor(FirstController.prototype, 'write');
  const secondDescriptor = Object.getOwnPropertyDescriptor(FirstController.prototype, 'writeSecond');
  const otherDescriptor = Object.getOwnPropertyDescriptor(SecondController.prototype, 'write');
  assert.ok(firstDescriptor && secondDescriptor && otherDescriptor);
  nestModelReturn(firstId)(FirstController.prototype, 'write', firstDescriptor);
  nestModelReturn(secondId, true)(FirstController.prototype, 'writeSecond', secondDescriptor);
  nestModelReturn(otherControllerId)(SecondController.prototype, 'write', otherDescriptor);

  const interceptor = new NestModelInterceptor();
  const firstProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const secondProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const otherProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const plainProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const plainValue = { id: 'plain' };
  const plainSecondProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const plainSecondValue = { id: 'plain-second' };
  assert.equal(await firstValueFrom(interceptResponse(
    interceptor,
    adapterResponse('express', plainProbe),
    [plainValue],
    { klass: FirstController, handler: plainWrite },
  )), plainValue, 'an unannotated method continues to pass through unchanged');
  assert.equal(plainProbe.body, undefined, 'an unannotated method does not write a model response');
  assert.equal(await firstValueFrom(interceptResponse(
    interceptor,
    adapterResponse('express', plainSecondProbe),
    [plainSecondValue],
    { klass: FirstController, handler: plainWrite },
  )), plainSecondValue, 'repeated unannotated calls pass through the current value');
  assert.equal(plainSecondProbe.body, undefined, 'repeated unannotated calls still do not write');
  const firstResult = await firstValueFrom(interceptResponse(
    interceptor,
    adapterResponse('express', firstProbe),
    [{ id: 'first' }],
    { klass: FirstController, handler: sharedWrite },
  ));
  const secondResult = await firstValueFrom(interceptResponse(
    interceptor,
    adapterResponse('express', secondProbe),
    [[{ id: 'second' }]],
    { klass: FirstController, handler: secondWrite },
  ));
  const otherResult = await firstValueFrom(interceptResponse(
    interceptor,
    adapterResponse('express', otherProbe),
    [{ id: 'other' }],
    { klass: SecondController, handler: sharedWrite },
  ));
  assert.equal(firstResult, JSON.stringify({ first: { id: 'first' } }));
  assert.equal(secondResult, JSON.stringify([{ second: { id: 'second' } }]));
  assert.equal(otherResult, JSON.stringify({ other: { id: 'other' } }));

  const lateId = 'CachedLate_44444444';
  class LateController {}
  const lateHandler = function write() { return undefined; };
  Object.defineProperty(LateController.prototype, 'write', { value: lateHandler });
  decorateReturn(LateController, 'write', lateId);
  const lateProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const lateResponse = adapterResponse('express', lateProbe);
  const lateInterceptor = new NestModelInterceptor();
  const unregistered = { id: 'late' };
  assert.throws(() => interceptResponse(
    lateInterceptor,
    lateResponse,
    [unregistered],
    { klass: LateController, handler: lateHandler },
  ), TypeError);
  markerCodec(lateId);
  assert.equal(await firstValueFrom(interceptResponse(
    lateInterceptor,
    lateResponse,
    [unregistered],
    { klass: LateController, handler: lateHandler },
  )), JSON.stringify(unregistered));
});

test('nestModelCodec before register leaves the parameter without a codec, so the interceptor answers 500', async () => {
  const id = 'Late_bbbbbbbb';
  class LateController {
    create(input: unknown) {
      return input;
    }
  }
  decorateCreate(LateController, id);
  markerCodec(id);
  const errors: string[] = [];
  const application = await startNestApp([LateController], { errors });
  try {
    const response = await fetch(`${await application.getUrl()}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'raw' }),
    });
    assert.equal(response.status, 500);
    // Nest reports an unhandled error after the response settles; let it flush.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(errors.join('\n'), /found no registered codec "Late_bbbbbbbb" for @Body\(\) parameter 0 of LateController\.create/);
  } finally {
    await application.close();
  }
});

/** A controller with one parameter the way TypeScript emits it: `metatype` is the `design:paramtypes` entry. */
function inputController(
  name: string,
  decorator: typeof Body | typeof Query,
  field: string | undefined,
  metatype: unknown,
  respond: (input: unknown) => unknown = (input) => input,
): Function {
  class InputController {
    handle(input: unknown) {
      return respond(input);
    }
  }
  Object.defineProperty(InputController, 'name', { value: name });
  Controller(name)(InputController);
  const descriptor = Object.getOwnPropertyDescriptor(InputController.prototype, 'handle');
  assert.ok(descriptor);
  Post()(InputController.prototype, 'handle', descriptor);
  (field === undefined ? decorator() : decorator(field))(InputController.prototype, 'handle', 0);
  Reflect.defineMetadata('design:paramtypes', [metatype], InputController.prototype, 'handle');
  return InputController;
}

class PlainClassInput {
  note = '';
}

const inputWithoutModel: readonly [string, typeof Body | typeof Query, string | undefined, unknown, string][] = [
  ['a plain interface or an untyped @Body()', Body, undefined, Object, 'PlainBody'],
  ['a plain class @Body()', Body, undefined, PlainClassInput, 'PlainClassBody'],
  ['a primitive @Body()', Body, undefined, String, 'PrimitiveBody'],
  ['a one-field @Body()', Body, 'name', String, 'FieldBody'],
  ['a plain @Query()', Query, undefined, Object, 'PlainQuery'],
  ['a one-field @Query()', Query, 'page', Number, 'FieldQuery'],
];
const namedParameter: Record<string, string> = {
  PlainBody: '@Body()',
  PlainClassBody: '@Body()',
  PrimitiveBody: '@Body()',
  FieldBody: "@Body('name')",
  PlainQuery: '@Query()',
  FieldQuery: "@Query('page')",
};

for (const [label, decorator, field, metatype, name] of inputWithoutModel) {
  test(`NestModelInterceptor throws a TypeError naming the parameter for ${label}`, () => {
    // protects: R-93 page failure row: a parameter with no stamp says to add the nest extension to the ts-openapi block
    const klass = inputController(name, decorator, field, metatype);
    const context = httpContext(klass, klass.prototype.handle, { body: { note: 'raw' }, query: {} });
    assert.throws(
      () => new NestModelInterceptor().intercept(context, { handle: () => of(undefined) }),
      new TypeError(`NestModelInterceptor needs an IModel or IObject type for ${namedParameter[name]} parameter 0 of ${name}.handle. Declare the input as an IModel or IObject. If it is a model, add extensions: { nest: {} } to the ts-openapi block in golem.yaml, so the build stamps the codec. Or write your own interceptor.`),
    );
  });
}

test('NestModelInterceptor converts a model-typed one-field @Body() and @Query() and answers 400 for an invalid field', async () => {
  const id = 'FieldModel_34343434';
  registerPassThroughCodec(id, {
    fromWireFormat: (wire) => ({ at: deserializeDate((wire as { at?: unknown } | undefined)?.at, ['at']) }) as never,
  });
  const received = (input: unknown) => ({ atIsDate: (input as { at?: unknown }).at instanceof Date });
  const bodyController = inputController('FieldModelBody', Body, 'addr', Object, received);
  nestModelCodec(id)(bodyController.prototype, 'handle', 0);
  const queryController = inputController('FieldModelQuery', Query, 'addr', Object, received);
  nestModelCodec(id)(queryController.prototype, 'handle', 0);
  const application = await startNestApp([bodyController, queryController], { nestedQuery: true });
  try {
    const base = await application.getUrl();
    const postBody = (body: unknown) => fetch(`${base}/FieldModelBody`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const valid = await postBody({ addr: { at: '2020-01-01T00:00:00.000Z' }, other: 1 });
    assert.equal(valid.status, 201);
    assert.deepEqual(await valid.json(), { atIsDate: true });
    const invalid = await postBody({ addr: { at: 'not a date' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(((await invalid.json()) as { issues: { path: unknown[] }[] }).issues.map((issue) => issue.path), [['addr', 'at']]);
    assert.equal((await postBody({ other: 1 })).status, 400, 'a missing field is rejected by the model');

    const query = (text: string) => fetch(`${base}/FieldModelQuery?${text}`, { method: 'POST' });
    const validQuery = await query('addr[at]=2020-01-01T00:00:00.000Z');
    assert.equal(validQuery.status, 201);
    assert.deepEqual(await validQuery.json(), { atIsDate: true });
    assert.equal((await query('addr[at]=not+a+date')).status, 400);
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor converts an array @Body() and a one-field array item by item and answers 400 with the item index', async () => {
  const id = 'ArrayItem_78787878';
  const descriptor: ModelTypeDescriptor = {
    kind: 'object',
    properties: { name: { kind: 'string' }, at: { kind: 'string' } },
    required: ['name'],
    additionalProperties: false,
  };
  await registerValidatingCodec(id, descriptor, (wire) => ({ ...(wire as object), converted: true }));
  const received = (input: unknown) => input;
  const wholeController = inputController('ArrayWhole', Body, undefined, Object, received);
  nestModelCodec(id, true)(wholeController.prototype, 'handle', 0);
  const fieldController = inputController('ArrayField', Body, 'items', Object, received);
  nestModelCodec(id, true)(fieldController.prototype, 'handle', 0);
  const application = await startNestApp([wholeController, fieldController]);
  try {
    const base = await application.getUrl();
    const post = (path: string, body: unknown) => fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const items = [{ name: 'a' }, { name: 'b' }];
    const whole = await post('ArrayWhole', items);
    assert.equal(whole.status, 201);
    assert.deepEqual(await whole.json(), [{ name: 'a', converted: true }, { name: 'b', converted: true }]);
    const field = await post('ArrayField', { items });
    assert.equal(field.status, 201);
    assert.deepEqual(await field.json(), [{ name: 'a', converted: true }, { name: 'b', converted: true }]);

    type WireIssue = { code: string; path: unknown[]; expected?: string[] };
    const issuesOf = async (response: Response) => ((await response.json()) as { issues: WireIssue[] }).issues;
    const issuePaths = async (response: Response) => (await issuesOf(response)).map((issue) => [issue.code, issue.path]);
    const invalid = await post('ArrayWhole', [{ name: 'a' }, { at: 'x' }]);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await issuePaths(invalid), [['required', [1, 'name']]]);
    const invalidField = await post('ArrayField', { items: [{ name: 'a' }, { at: 'x' }] });
    assert.equal(invalidField.status, 400);
    assert.deepEqual(await issuePaths(invalidField), [['required', ['items', 1, 'name']]]);
    const notArrayWhole = await post('ArrayWhole', { name: 'a' });
    assert.equal(notArrayWhole.status, 400, 'an object is not an array');
    assert.deepEqual((await issuesOf(notArrayWhole)).map(({ code, path, expected }) => ({ code, path, expected })), [{ code: 'type', path: [], expected: ['array'] }]);
    assert.deepEqual(await issuePaths(await post('ArrayField', { items: {} })), [['type', ['items']]]);
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor leaves a non-HTTP handler alone, even when its parameter type is not a model', () => {
  // A Nest RPC @Payload() shares the paramtype number of @Body().
  const klass = inputController('RpcPayload', Body, undefined, Object);
  const context = {
    getType: () => 'rpc',
    getHandler: () => klass.prototype.handle,
    getClass: () => klass,
  } as unknown as ExecutionContext;
  const handled = of('handled');
  assert.equal(new NestModelInterceptor().intercept(context, { handle: () => handled }), handled);
});

test('NestModelInterceptor throws a TypeError for a whole and a one-field @Body() of one handler', () => {
  const id = 'MixedModel_56565656';
  markerCodec(id);
  class MixedController {
    handle(_whole: unknown, _field: unknown) {
      return undefined;
    }
  }
  Body()(MixedController.prototype, 'handle', 0);
  nestModelCodec(id)(MixedController.prototype, 'handle', 0);
  Body('addr')(MixedController.prototype, 'handle', 1);
  nestModelCodec(id)(MixedController.prototype, 'handle', 1);
  const context = httpContext(MixedController, MixedController.prototype.handle, { body: { addr: {} } });
  assert.throws(
    () => new NestModelInterceptor().intercept(context, { handle: () => of(undefined) }),
    new TypeError('NestModelInterceptor cannot convert a whole and a one-field @Body() of MixedController.handle together. Declare the whole input as one model, or use one-field parameters only.'),
  );
});

test('NestModelInterceptor sends a declared null return as an empty body', async () => {
  const id = 'Returned_cccccccc';
  registerPassThroughCodec(id, { stringify: (value) => JSON.stringify({ wire: value }) });
  class ReturnController {
    empty() {
      return null;
    }
  }
  Controller('returns')(ReturnController);
  const emptyDescriptor = Object.getOwnPropertyDescriptor(ReturnController.prototype, 'empty');
  assert.ok(emptyDescriptor);
  Post('empty')(ReturnController.prototype, 'empty', emptyDescriptor);
  nestModelReturn(id)(ReturnController.prototype, 'empty', emptyDescriptor);
  const application = await startNestApp([ReturnController]);
  try {
    const base = await application.getUrl();
    const empty = await fetch(`${base}/returns/empty`, { method: 'POST' });
    assert.equal(empty.status, 201);
    assert.equal(await empty.text(), '');
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor decodes whole @Query() strings to the declared scalar and array types', async () => {
  const id = 'QueryFilter_dddddddd';
  const filter: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      limit: { kind: 'number' },
      page: { kind: 'number', constraints: [{ kind: 'integer' }] },
      active: { kind: 'boolean' },
      level: { kind: 'union', variants: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }] },
      status: { kind: 'union', variants: [{ kind: 'literal', value: 'paid' }, { kind: 'literal', value: 'pending' }] },
      name: { kind: 'string' },
      ids: { kind: 'array', item: { kind: 'number' } },
      amount: { kind: 'union', variants: [{ kind: 'string' }, { kind: 'number' }] },
      tags: { kind: 'array', item: { kind: 'union', variants: [{ kind: 'literal', value: 'x' }, { kind: 'literal', value: 'y' }] } },
    },
    required: [],
    additionalProperties: false,
  };
  await registerValidatingCodec(id, filter);
  class QueryController {
    list(query: unknown) {
      return { query };
    }
  }
  decorateQueryModel(QueryController, 'list', id, 'query');
  const application = await startNestApp([QueryController]);
  try {
    const base = `${await application.getUrl()}/query`;
    const accepted = await fetch(`${base}?limit=10&page=2&active=false&level=2&status=paid&name=42&ids=1&ids=2.5`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      query: { limit: 10, page: 2, active: false, level: 2, status: 'paid', name: '42', ids: [1, 2.5] },
    });
    const single = await fetch(`${base}?ids=7`);
    assert.equal(single.status, 200);
    assert.deepEqual(await single.json(), { query: { ids: [7] } }, 'one value for an array field is a one-item array');
    const mixed = await fetch(`${base}?page=1e3&amount=42&tags=x&tags=y`);
    assert.equal(mixed.status, 200);
    assert.deepEqual(await mixed.json(), { query: { page: 1000, amount: '42', tags: ['x', 'y'] } },
      'a string|number field keeps the string; an integer accepts JSON exponent notation');
    for (const invalid of [
      'limit=abc', 'limit=', 'page=1.5', 'page=9007199254740993', 'active=yes', 'level=3', 'status=other', 'ids=x',
      'tags=x&tags=z',
    ]) {
      const rejected = await fetch(`${base}?${invalid}`);
      assert.equal(rejected.status, 400, invalid);
    }
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor passes @Query() through unchanged unless a present field decodes', () => {
  const received: unknown[] = [];
  const register = (id: string, queryFields?: QueryFieldTable) => registerPassThroughCodec(id, {
    fromWireFormat: (wire) => {
      received.push(wire);
      return wire as never;
    },
    ...(queryFields ? { queryFields } : {}),
  });
  // A model with only string fields has no table.
  register('QueryStrings_ffffffff');
  register('QueryMixed_ffffffff', Object.defineProperty({ limit: { types: ['integer'] } }, '__proto__', { value: { types: ['number'] }, enumerable: true }));
  const interceptor = new NestModelInterceptor();
  const intercept = (id: string, query: unknown) => {
    class QueryController {
      list(value: unknown) {
        return value;
      }
    }
    Query()(QueryController.prototype, 'list', 0);
    nestModelCodec(id)(QueryController.prototype, 'list', 0);
    const request = { query };
    const context = httpContext(QueryController, QueryController.prototype.list, request);
    received.length = 0;
    interceptor.intercept(context, { handle: () => of(undefined) });
    assert.equal(received.length, 1);
    return received[0];
  };

  const strings = { q: 'a', either: 'y' };
  assert.equal(intercept('QueryStrings_ffffffff', strings), strings, 'string-only fields need no copy');
  const nameOnly = { name: '7', extra: '1' };
  assert.equal(intercept('QueryMixed_ffffffff', nameOnly), nameOnly, 'no decodable field is present');

  const mixed = { name: '7', limit: '3', extra: '1' };
  const decoded = intercept('QueryMixed_ffffffff', mixed);
  assert.notEqual(decoded, mixed);
  assert.deepEqual(decoded, { name: '7', limit: 3, extra: '1' });
  assert.deepEqual(mixed, { name: '7', limit: '3', extra: '1' }, 'the incoming query is not mutated');

  const proto = intercept('QueryMixed_ffffffff', JSON.parse('{"__proto__":"5"}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(proto, '__proto__')?.value, 5, '__proto__ stays an own data field');
});

test('NestModelInterceptor answers 400 for request input the decoder rejects and 500 for server faults', async () => {
  // protects: T-686 the interceptor sees a LibError from a second golem copy as bad input
  const secondCopy = await import(`${import.meta.resolve('@exprtlabs/golem/errors')}?second-copy`) as { LibError: typeof LibError; LibErrorKind: typeof LibErrorKind };
  class UnregisteredModel {}
  const decoders: Record<string, (wire: Record<string, unknown>) => unknown> = {
    unknownTag: (wire) => unknownDiscriminatorValue('kind', wire.kind, 'deserialize'),
    invalidDate: (wire) => ({ at: deserializeDate(wire.at) }),
    // A LibError from another golem copy (a standalone SDK) is bad input too.
    foreignCopy: () => { throw new (secondCopy.LibError)(secondCopy.LibErrorKind.Validation, 'from the SDK'); },
    // Missing conversion metadata is a program fault, not bad input.
    serverFault: (wire) => modelCodec(UnregisteredModel).fromWireFormat(wire),
    // A validator that cannot report a result is a program fault too.
    brokenValidator: (wire) => isValidModelValue(wire, undefined, (() => ({
      get then(): never { throw new Error('validator failure'); },
    })) as never, 'InputFaultbrokenValidator'),
  };
  const controllers: Function[] = [];
  for (const [name, decode] of Object.entries(decoders)) {
    const id = `InputFault${name}_eeeeeeee`;
    registerPassThroughCodec(id, { fromWireFormat: (wire) => decode(wire as Record<string, unknown>) as never });
    class InputController {
      create(input: unknown) {
        return input;
      }
    }
    decorateCreate(InputController, id);
    Controller(name)(InputController);
    controllers.push(InputController);
  }
  const application = await startNestApp(controllers);
  try {
    const base = await application.getUrl();
    const post = (name: string, body: unknown) => fetch(`${base}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const unknownTag = await post('unknownTag', { kind: 'bird' });
    assert.equal(unknownTag.status, 400);
    assert.match(JSON.stringify(await unknownTag.json()), /Unknown kind discriminator value/);
    assert.equal((await post('invalidDate', { at: 'not a date' })).status, 400);
    assert.equal((await post('invalidDate', { at: 1 })).status, 400, 'a date must be text');
    assert.equal((await post('foreignCopy', {})).status, 400);
    assert.equal((await post('serverFault', {})).status, 500);
    assert.equal((await post('brokenValidator', {})).status, 500);
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor model returns reach the client without an ExceptionsHandler error; real faults are still logged', async () => {
  // IObject: a plain object codec. IModel: a class instance serialized through its codec.
  const objectId = 'LoggedObject_abababab';
  const modelId = 'LoggedModel_cdcdcdcd';
  class AccountModel {
    constructor(readonly id: string) {}
  }
  registerPassThroughCodec(objectId, { stringify: (value) => JSON.stringify({ object: value }) });
  registerPassThroughCodec(modelId, {
    stringify: (value) => {
      if (!(value instanceof AccountModel)) throw new Error('model codec received a non-model value');
      return JSON.stringify({ model: value.id });
    },
  });
  class LoggedController {
    objectDirect() { return { id: 'o1' }; }
    modelDirect() { return new AccountModel('m1'); }
    async modelPromise() { return new AccountModel('m2'); }
    modelObservable() { return of(new AccountModel('m3')); }
    modelList() { return [new AccountModel('a'), new AccountModel('b')]; }
    fault() { throw new Error('handler fault'); }
    codecFault() { return { id: 'not a model' }; }
  }
  Controller('logged')(LoggedController);
  const routes: readonly [keyof LoggedController, string, boolean][] = [
    ['objectDirect', objectId, false],
    ['modelDirect', modelId, false],
    ['modelPromise', modelId, false],
    ['modelObservable', modelId, false],
    ['modelList', modelId, true],
    ['fault', modelId, false],
    ['codecFault', modelId, false],
  ];
  for (const [name, id, array] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(LoggedController.prototype, name);
    assert.ok(descriptor);
    Get(name)(LoggedController.prototype, name, descriptor);
    nestModelReturn(id, array)(LoggedController.prototype, name, descriptor);
  }
  const errors: string[] = [];
  const application = await startNestApp([LoggedController], { errors });
  try {
    const base = await application.getUrl();
    const expected: readonly [string, unknown][] = [
      ['objectDirect', { object: { id: 'o1' } }],
      ['modelDirect', { model: 'm1' }],
      ['modelPromise', { model: 'm2' }],
      ['modelObservable', { model: 'm3' }],
      ['modelList', [{ model: 'a' }, { model: 'b' }]],
    ];
    for (const [name, body] of expected) {
      const response = await fetch(`${base}/logged/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/, name);
      assert.deepEqual(await response.json(), body, name);
    }
    // Nest reports an unhandled error after the response settles; let it flush.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, [], 'successful model returns log no ExceptionsHandler error');

    assert.equal((await fetch(`${base}/logged/fault`)).status, 500);
    assert.equal((await fetch(`${base}/logged/codecFault`)).status, 500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.match(errors[0] ?? '', /handler fault/);
    assert.match(errors[1] ?? '', /model codec received a non-model value/);
    assert.doesNotMatch(errors.join('\n'), /EmptyError|no elements in sequence/);
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor answers 200 with the declared fields of a returned model instance that holds its own state', async (t) => {
  // protects: bug T-148 a handler that returns a model instance with program state answered 500
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-nest-instance-state-', name: 'nest-instance-state', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'state.model.ts'), readFixture('models/model-instance-state/own-state/state.model.ts'));
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const { Task } = await import(pathToFileURL(path.join(root, 'build/state.model.js')).href) as { Task: new (values: object) => object };
  const id = generatedCodecIdFromRoot(root, 'TTask');
  class StateController {
    one() { return new Task({ title: 'a', done: true }); }
    list() { return [new Task({ title: 'b' }), new Task({ title: 'c', done: false })]; }
  }
  Controller('state')(StateController);
  for (const [name, array] of [['one', false], ['list', true]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(StateController.prototype, name);
    assert.ok(descriptor);
    Get(name)(StateController.prototype, name, descriptor);
    nestModelReturn(id, array)(StateController.prototype, name, descriptor);
  }
  const application = await startNestApp([StateController]);
  try {
    const base = await application.getUrl();
    const one = await fetch(`${base}/state/one`);
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { title: 'a', done: true });
    const list = await fetch(`${base}/state/list`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [{ title: 'b' }, { title: 'c', done: false }]);
  } finally {
    await application.close();
  }
});

test('NestModelInterceptor answers 500 for a marked return with no codec and passes an unmarked return through', async () => {
  // protects: bug T-166 a marked return whose codec never loaded was sent as plain Nest JSON
  const id = 'NeverLoaded_cccccccc';
  let markedRuns = 0;
  class UnloadedController {
    marked() { markedRuns += 1; return { secret: 'raw' }; }
    plain() { return { note: 'raw' }; }
  }
  Controller('unloaded')(UnloadedController);
  for (const name of ['marked', 'plain'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(UnloadedController.prototype, name);
    assert.ok(descriptor);
    Get(name)(UnloadedController.prototype, name, descriptor);
  }
  nestModelReturn(id)(UnloadedController.prototype, 'marked', Object.getOwnPropertyDescriptor(UnloadedController.prototype, 'marked')!);
  const errors: string[] = [];
  const application = await startNestApp([UnloadedController], { errors });
  try {
    const base = await application.getUrl();
    const plain = await fetch(`${base}/unloaded/plain`);
    assert.equal(plain.status, 200);
    assert.deepEqual(await plain.json(), { note: 'raw' });
    const marked = await fetch(`${base}/unloaded/marked`);
    assert.equal(marked.status, 500);
    assert.doesNotMatch(await marked.text(), /secret/);
    assert.equal(markedRuns, 0, 'the handler does not run when its return codec is missing');
    // Nest reports an unhandled error after the response settles; let it flush.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0] ?? '', /^TypeError: golem fault: the build marked the return of UnloadedController\.marked with model "NeverLoaded_cccccccc", but the generated module of that model did not load/);
  } finally {
    await application.close();
  }
});

/** A variant codec of a union that tells which variant converted the wire value. */
function variantCodec(id: string, queryFields?: QueryFieldTable) {
  return registerPassThroughCodec(id, {
    fromWireFormat: (wire) => ({ variant: id, wire }),
    ...(queryFields ? { queryFields } : {}),
  });
}

test('a union binding resolves its variant codecs on first use, so a variant that registers after the controller class still converts', () => {
  // protects: T-511 a union token decorated before its variant codecs register is not left unbound
  const klass = inputController('LateUnion', Body, undefined, Object);
  nestModelUnion('kind', [[['a'], 'LateUnionA_11111111'], [['b'], 'LateUnionB_22222222']])(klass.prototype, 'handle', 0);
  variantCodec('LateUnionA_11111111');
  const type = (Reflect.getMetadata('design:paramtypes', klass.prototype, 'handle') as unknown[])[0];
  const request = { body: { kind: 'b' }, query: {} };
  const context = httpContext(klass, klass.prototype.handle, request);
  assert.equal(nestUnionFromMetatype(type), undefined);
  assert.throws(() => new NestModelInterceptor().intercept(context, { handle: () => of(undefined) }), new TypeError(
    'golem fault: NestModelInterceptor found no registered codec "LateUnionB_22222222" for the union "LateUnionA_11111111 | LateUnionB_22222222" for @Body() parameter 0 of LateUnion.handle. The rewrite loads the generated module of the model, and that module did not load. Run golem generate and rewrite the file again.',
  ));
  variantCodec('LateUnionB_22222222');
  const resolved = nestUnionFromMetatype(type);
  assert.ok(resolved);
  assert.equal(resolved, (type as { [key: symbol]: unknown })[Symbol.for('@exprtlabs/golem:nestModelCodec.union')], 'the interceptor converts with this object');
  new NestModelInterceptor().intercept(context, { handle: () => of(undefined) });
  assert.deepEqual(request.body, { variant: 'LateUnionB_22222222', wire: { kind: 'b' } });
});

test('a custom interceptor converts a union @Body() and @Query() with nestUnionFromMetatype; a model token and a non-model give undefined', async () => {
  // protects: T-511 a custom interceptor reads a union binding through a public function
  variantCodec('Circle_33333333', { radius: { types: ['number'] } });
  variantCodec('Rect_44444444', { width: { types: ['number'] } });
  const union = (decorator: typeof Body | typeof Query, name: string) => {
    const klass = inputController(name, decorator, undefined, Object, (input) => ({ received: input }));
    nestModelUnion('kind', [[['circle'], 'Circle_33333333'], [['rect'], 'Rect_44444444']])(klass.prototype, 'handle', 0);
    return klass;
  };
  const bodyController = union(Body, 'UnionBody');
  const queryController = union(Query, 'UnionQuery');
  const types = (klass: Function) => Reflect.getMetadata('design:paramtypes', klass.prototype, 'handle') as unknown[];
  const metatype = types(bodyController)[0];
  assert.equal(nestUnionFromMetatype(nestModelCodec('Circle_33333333')), undefined);
  assert.equal(nestUnionFromMetatype(Object), undefined);
  assert.throws(() => nestUnionFromMetatype(metatype)!.fromWireFormat({ kind: 'triangle' }), (error) => error instanceof LibError && error.causedByInput);
  // The interceptor answers with what it converted; the handler runs on the raw input.
  const custom: NestInterceptor = {
    intercept: (context, next) => {
      const klass = context.getClass();
      const request = context.switchToHttp().getRequest<{ body?: unknown; query?: unknown }>();
      const union = nestUnionFromMetatype(types(klass)[0])!;
      const picked = klass === bodyController ? union.fromWireFormat(request.body) : union.fromWireFormat(union.decodeQuery(request.query));
      return next.handle().pipe(map(() => ({ picked })));
    },
  };
  const application = await startNestApp([bodyController, queryController], { interceptor: custom });
  try {
    const base = await application.getUrl();
    const post = await fetch(`${base}/UnionBody`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'rect', width: 3 }) });
    assert.deepEqual(await post.json(), { picked: { variant: 'Rect_44444444', wire: { kind: 'rect', width: 3 } } });
    const query = await fetch(`${base}/UnionQuery?kind=circle&radius=2.5`, { method: 'POST' });
    assert.deepEqual(await query.json(), { picked: { variant: 'Circle_33333333', wire: { kind: 'circle', radius: 2.5 } } }, 'decodeQuery turns the query text into the number the variant declares');
  } finally {
    await application.close();
  }
});

const LEVEL_MODEL = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { MaxLength } from '@exprtlabs/golem/tags';\nexport type TInput = IModel<{ name: string & MaxLength<3>; qty: number }>;\n";

/** The status of a POST of `body` to an app whose interceptor has `options`, for a model built in a project at `validation`. */
async function postStatuses(t: TestContext, validation: true | 'sanity', cases: readonly (readonly [NestModelInterceptorOptions, unknown])[]): Promise<number[]> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-nest-level-', name: 'nest-level', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'input.model.ts'), LEVEL_MODEL);
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  await import(pathToFileURL(path.join(root, 'build/input.model.generated.js')).href);
  const id = generatedCodecIdFromRoot(root, 'TInput');
  const statuses: number[] = [];
  for (const [options, body] of cases) {
    class LevelController { create(input: unknown) { return input; } }
    decorateCreate(LevelController, id);
    const application = await startNestApp([LevelController], { interceptor: new NestModelInterceptor(options), errors: [] });
    try {
      const response = await fetch(`${await application.getUrl()}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      statuses.push(response.status);
    } finally {
      await application.close();
    }
  }
  return statuses;
}

test('NestModelInterceptor validates at the level of its option in a full project and answers 400 for a shape error at every level', async (t) => {
  // protects: F-39 request input the model rejects answers 400; R-76 a call may choose any level up to the project's
  const overLimit = { name: 'abcd', qty: 1 };
  const wrongType = { name: 5, qty: 1 };
  const statuses = await postStatuses(t, true, [
    [{}, overLimit], [{}, wrongType],
    [{ validate: 'sanity' }, overLimit], [{ validate: 'sanity' }, wrongType],
    [{ validate: true }, overLimit], [{ validate: true }, { name: 'abc', qty: 1 }],
  ]);
  assert.deepEqual(statuses, [400, 400, 201, 400, 400, 201]);
});

test('NestModelInterceptor refuses a level above the project and validates at sanity by default in a sanity project', async (t) => {
  // protects: R-72 a call may lower the level, never raise it above the project's
  const overLimit = { name: 'abcd', qty: 1 };
  const statuses = await postStatuses(t, 'sanity', [
    [{}, overLimit], [{ validate: 'sanity' }, overLimit], [{ validate: 'sanity' }, { name: 5, qty: 1 }], [{ validate: true }, overLimit],
  ]);
  assert.deepEqual(statuses, [201, 201, 400, 500], 'a level above the project is a server fault, not a bad request');
});

for (const validate of [false, null, 0, '', 'full', 1]) {
  test(`NestModelInterceptor refuses validate ${JSON.stringify(validate)}, so a JavaScript false never turns request validation off`, () => {
    // protects: F-176 default settings stay safe for input validation
    assert.throws(() => new NestModelInterceptor({ validate: validate as never }), TypeError);
  });
}
