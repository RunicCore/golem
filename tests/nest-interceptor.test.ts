import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  Query,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { defaultIfEmpty, firstValueFrom, of, type Observable } from 'rxjs';
import {
  nestModelCodec,
  nestModelReturn,
  NestModelInterceptor,
  nestModelStringifyInterceptor,
  objectCodecFromMetatype,
} from '@exprtlabs/golem/nest';
import { decodeGeneratedModel, deserializeDate, unknownDiscriminatorValue } from '@exprtlabs/golem/conversion';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { schemaForDescriptor } from '@exprtlabs/golem/schema';
import {
  assertModelValue,
  createObjectCodec,
  getObjectCodec,
  isValidModelValue,
  IssueRepresentation,
  IssueSource,
} from '@exprtlabs/golem/serde';
import { compileSchema } from './support/compiled-validators.js';

function markerCodec(id: string) {
  return createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: () => ({ converted: true }),
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

async function runInterceptor(
  interceptor: NestInterceptor,
  response: object,
  value: unknown,
): Promise<unknown> {
  const context = {
    getHandler: () => AdapterWriterController.prototype.write,
    getClass: () => AdapterWriterController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => response }),
  } as unknown as ExecutionContext;
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
  const context = {
    getHandler: () => target.handler,
    getClass: () => target.klass,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => response }),
  } as unknown as ExecutionContext;
  const next: CallHandler<unknown> = { handle: () => of(...values) };
  const result = interceptor.intercept(context, next);
  if (result instanceof Promise) throw new Error('Nest model interceptors return their response Observable synchronously.');
  return result;
}

class AdapterWriterController {
  write(): unknown { return undefined; }
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
  const descriptor = Object.getOwnPropertyDescriptor(AdapterWriterController.prototype, 'write');
  assert.ok(descriptor);
  nestModelReturn(id)(AdapterWriterController.prototype, 'write', descriptor);

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
  const descriptor = Object.getOwnPropertyDescriptor(AdapterWriterController.prototype, 'write');
  assert.ok(descriptor);
  nestModelReturn(id)(AdapterWriterController.prototype, 'write', descriptor);
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
  const descriptor = Object.getOwnPropertyDescriptor(AdapterWriterController.prototype, 'write');
  assert.ok(descriptor);
  nestModelReturn(id)(AdapterWriterController.prototype, 'write', descriptor);

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
  const throwingCodec = createObjectCodec(id, {
    stringify: () => { throw new Error('codec stringify failed'); },
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: () => ({} as never),
  });
  const descriptor = Object.getOwnPropertyDescriptor(AdapterWriterController.prototype, 'write');
  assert.ok(descriptor);
  nestModelReturn(id)(AdapterWriterController.prototype, 'write', descriptor);
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
  nestModelReturn('WriterThrow_ffffffff')(AdapterWriterController.prototype, 'write', descriptor);
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
  createObjectCodec(firstId, {
    stringify: (value) => JSON.stringify({ first: value }),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: () => ({} as never),
  });
  createObjectCodec(secondId, {
    stringify: (value) => JSON.stringify({ second: value }),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: () => ({} as never),
  });
  createObjectCodec(otherControllerId, {
    stringify: (value) => JSON.stringify({ other: value }),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: () => ({} as never),
  });
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
  const lateDescriptor = Object.getOwnPropertyDescriptor(LateController.prototype, 'write');
  assert.ok(lateDescriptor);
  nestModelReturn(lateId)(LateController.prototype, 'write', lateDescriptor);
  const lateProbe: ResponseProbe = { headers: new Map(), body: undefined };
  const lateResponse = adapterResponse('express', lateProbe);
  const lateInterceptor = new NestModelInterceptor();
  const unregistered = { id: 'late' };
  assert.equal(await firstValueFrom(interceptResponse(
    lateInterceptor,
    lateResponse,
    [unregistered],
    { klass: LateController, handler: lateHandler },
  )), unregistered);
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
  class AppModule {}
  Module({ controllers: [LateController] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`${await application.getUrl()}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'raw' }),
    });
    assert.equal(response.status, 500);
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
    const klass = inputController(name, decorator, field, metatype);
    const context = {
      getHandler: () => klass.prototype.handle,
      getClass: () => klass,
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ body: { note: 'raw' }, query: {} }), getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
    assert.throws(
      () => new NestModelInterceptor().intercept(context, { handle: () => of(undefined) }),
      new TypeError(`NestModelInterceptor needs an IModel or IObject type for ${namedParameter[name]} parameter 0 of ${name}.handle. Declare the input as an IModel or IObject, or write your own interceptor.`),
    );
  });
}

test('NestModelInterceptor answers 500 for an input that is not a model, still converts a model, and a handler without the interceptor does not change', async () => {
  const id = 'InputModel_12121212';
  markerCodec(id);
  const modelController = inputController('ModelBody', Body, undefined, Object);
  nestModelCodec(id)(modelController.prototype, 'handle', 0);
  const plainController = inputController('PlainBody', Body, undefined, Object);
  const fieldController = inputController('FieldQuery', Query, 'page', Number);
  class AppModule {}
  Module({ controllers: [modelController, plainController, fieldController] as never[] })(AppModule);
  const post = (base: string, path: string) => fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'raw' }),
  });
  const guarded = await NestFactory.create(AppModule, { logger: false });
  guarded.useGlobalInterceptors(new NestModelInterceptor());
  await guarded.listen(0, '127.0.0.1');
  try {
    const base = await guarded.getUrl();
    const model = await post(base, 'ModelBody');
    assert.equal(model.status, 201);
    assert.deepEqual(await model.json(), { converted: true });
    assert.equal((await post(base, 'PlainBody')).status, 500);
    assert.equal((await post(base, 'FieldQuery?page=2')).status, 500);
  } finally {
    await guarded.close();
  }
  const open = await NestFactory.create(AppModule, { logger: false });
  await open.listen(0, '127.0.0.1');
  try {
    const plain = await post(await open.getUrl(), 'PlainBody');
    assert.equal(plain.status, 201);
    assert.deepEqual(await plain.json(), { note: 'raw' });
  } finally {
    await open.close();
  }
});

test('NestModelInterceptor converts a model-typed one-field @Body() and @Query() and answers 400 for an invalid field', async () => {
  const id = 'FieldModel_34343434';
  createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (wire) => ({ at: deserializeDate((wire as { at?: unknown } | undefined)?.at, ['at']) }) as never,
  });
  const received = (input: unknown) => ({ atIsDate: (input as { at?: unknown }).at instanceof Date });
  const bodyController = inputController('FieldModelBody', Body, 'addr', Object, received);
  nestModelCodec(id)(bodyController.prototype, 'handle', 0);
  const queryController = inputController('FieldModelQuery', Query, 'addr', Object, received);
  nestModelCodec(id)(queryController.prototype, 'handle', 0);
  class AppModule {}
  Module({ controllers: [bodyController, queryController] as never[] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  // Express 5 reads `addr[at]=x` as one flat key unless the app opts in to nested query keys.
  application.getHttpAdapter().getInstance().set('query parser', 'extended');
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
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
  const assembled = schemaForDescriptor(descriptor, { representation: 'model' });
  assert.ok(typeof assembled === 'object');
  const schema = { $id: id, ...assembled };
  const validate = await compileSchema(schema);
  createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: (value) => isValidModelValue(value, undefined, validate, id),
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (wire) => {
      assertModelValue(wire, undefined, validate, id, IssueRepresentation.Wire, IssueSource.OpenAPI);
      return { ...(wire as object), converted: true } as never;
    },
    schema,
  });
  const received = (input: unknown) => input;
  const wholeController = inputController('ArrayWhole', Body, undefined, Object, received);
  nestModelCodec(id, true)(wholeController.prototype, 'handle', 0);
  const fieldController = inputController('ArrayField', Body, 'items', Object, received);
  nestModelCodec(id, true)(fieldController.prototype, 'handle', 0);
  class AppModule {}
  Module({ controllers: [wholeController, fieldController] as never[] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
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
  const context = {
    getHandler: () => MixedController.prototype.handle,
    getClass: () => MixedController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ body: { addr: {} } }), getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  assert.throws(
    () => new NestModelInterceptor().intercept(context, { handle: () => of(undefined) }),
    new TypeError('NestModelInterceptor cannot convert a whole and a one-field @Body() of MixedController.handle together. Declare the whole input as one model, or use one-field parameters only.'),
  );
});

test('NestModelInterceptor sends a declared null return as an empty body', async () => {
  const id = 'Returned_cccccccc';
  createObjectCodec(id, {
    stringify: (value) => JSON.stringify({ wire: value }),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (value) => value,
  });
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
  class AppModule {}
  Module({ controllers: [ReturnController] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
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
  const assembled = schemaForDescriptor(filter, { representation: 'model' });
  assert.ok(typeof assembled === 'object');
  const schema = { $id: id, ...assembled };
  const validate = await compileSchema(schema);
  createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: (value) => isValidModelValue(value, undefined, validate, id),
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (wire) => {
      assertModelValue(wire, undefined, validate, id, IssueRepresentation.Wire, IssueSource.OpenAPI);
      return wire as never;
    },
    schema,
  });
  class QueryController {
    list(query: unknown) {
      return { query };
    }
  }
  Controller('query')(QueryController);
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
  const register = (id: string, properties: Record<string, unknown>) => createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (wire) => {
      received.push(wire);
      return wire as never;
    },
    schema: { type: 'object', properties },
  });
  register('QueryStrings_ffffffff', {
    q: { type: 'string' },
    either: { type: ['string', 'array'], items: { type: 'string' } },
  });
  register('QueryMixed_ffffffff', {
    name: { type: 'string' },
    limit: { type: 'integer' },
    ['__proto__']: { type: 'number' },
  });
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
    const context = {
      getHandler: () => QueryController.prototype.list,
      getClass: () => QueryController,
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
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
  class UnregisteredModel {}
  const decoders: Record<string, (wire: Record<string, unknown>) => unknown> = {
    unknownTag: (wire) => unknownDiscriminatorValue('kind', wire.kind, 'deserialize'),
    invalidDate: (wire) => ({ at: deserializeDate(wire.at) }),
    // Missing conversion metadata is a program fault, not bad input.
    serverFault: (wire) => decodeGeneratedModel(UnregisteredModel, wire),
    // A validator that cannot report a result is a program fault too.
    brokenValidator: (wire) => isValidModelValue(wire, undefined, (() => ({
      get then(): never { throw new Error('validator failure'); },
    })) as never, 'InputFaultbrokenValidator'),
  };
  const controllers: Function[] = [];
  for (const [name, decode] of Object.entries(decoders)) {
    const id = `InputFault${name}_eeeeeeee`;
    createObjectCodec(id, {
      stringify: (value) => JSON.stringify(value),
      parse: (text) => JSON.parse(text) as never,
      validate: () => true,
      assert: (value) => value as never,
      toWireFormat: (value) => value,
      fromWireFormat: (wire) => decode(wire as Record<string, unknown>) as never,
    });
    class InputController {
      create(input: unknown) {
        return input;
      }
    }
    decorateCreate(InputController, id);
    Controller(name)(InputController);
    controllers.push(InputController);
  }
  class AppModule {}
  Module({ controllers: controllers as never[] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
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
  createObjectCodec(objectId, {
    stringify: (value) => JSON.stringify({ object: value }),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (value) => value,
  });
  createObjectCodec(modelId, {
    stringify: (value) => {
      if (!(value instanceof AccountModel)) throw new Error('model codec received a non-model value');
      return JSON.stringify({ model: value.id });
    },
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (value) => value,
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
  class AppModule {}
  Module({ controllers: [LoggedController] })(AppModule);
  const errors: string[] = [];
  const logger = {
    log() {},
    warn() {},
    debug() {},
    verbose() {},
    error(message: unknown, ...rest: unknown[]) {
      errors.push([message, ...rest].map((part) => part instanceof Error ? `${part.name}: ${part.message}` : String(part)).join(' '));
    },
  };
  const application = await NestFactory.create(AppModule, { logger });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
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
