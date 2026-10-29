import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { reaction } from 'mobx';
import type { ApiOperation } from '@exprtlabs/golem/client';
import { createApiOperation } from '@exprtlabs/golem/internal/client-runtime';
import { createObservableApiOperation } from '@exprtlabs/golem/internal/mobx-runtime';
import type { ObservableApiOperation } from '@exprtlabs/golem/mobx';
import { captureWarnings, delay, deferred, enforceActions, rejectOnAbort } from './support/client-test-utils.js';

type Warn = typeof console.warn;

type AssertPlainHasNoLoading = 'loading' extends keyof ApiOperation<unknown, unknown> ? never : true;
type AssertObservableHasLoading = 'loading' extends keyof ObservableApiOperation<unknown, unknown> ? true : never;
type AssertPublicFactoryArity = Parameters<typeof createApiOperation> extends [string, infer _Run] ? true : never;
const plainHasNoLoading: AssertPlainHasNoLoading = true;
const observableHasLoading: AssertObservableHasLoading = true;
const publicFactoryArity: AssertPublicFactoryArity = true;
void plainHasNoLoading;
void observableHasLoading;
void publicFactoryArity;

test('createApiOperation is a synchronous inert non-thenable factory', async () => {
  let runs = 0;
  const operation = createApiOperation('listItems', async (input: { secret: string }) => {
    runs += 1;
    return input.secret;
  });
  assert.equal(operation instanceof Promise, false);
  assert.equal('then' in operation, false);
  assert.equal('loading' in operation, false);
  assert.equal(typeof operation.execute, 'function');
  const awaited = await Promise.resolve(operation);
  assert.equal(awaited, operation);
  assert.equal(runs, 0);
  assert.equal(await operation.execute({ secret: 'token-1' }), 'token-1');
  assert.equal(runs, 1);
});

test('execute reuses the same object without caching results', async () => {
  let runs = 0;
  const operation = createApiOperation('listItems', async (input: number) => {
    runs += 1;
    return input + runs;
  });
  assert.equal(await operation.execute(10), 11);
  assert.equal(await operation.execute(20), 22);
  assert.equal(runs, 2);
});

test('auth values are read when execute runs, not when the factory returns', async () => {
  let token = 'first';
  const operation = createApiOperation('secure', async () => token);
  const created = operation;
  token = 'second';
  assert.equal(await created.execute(undefined), 'second');
  token = 'third';
  assert.equal(await created.execute(undefined), 'third');
});

test('overlapping execute calls warn once per additional invocation on that object', async (t) => {
  const warnings = captureWarnings(t);
  const { promise: gate, resolve: release } = deferred();
  const operation = createApiOperation('listItems', async (input: { password: string }) => {
    await gate;
    return input.password;
  });
  const first = operation.execute({ password: 'super-secret' });
  const second = operation.execute({ password: 'super-secret' });
  const third = operation.execute({ password: 'super-secret' });
  assert.equal(warnings.length, 2);
  for (const warning of warnings) {
    assert.match(warning, /listItems/);
    assert.doesNotMatch(warning, /super-secret/);
    assert.doesNotMatch(warning, /password/);
  }
  release();
  assert.deepEqual(await Promise.all([first, second, third]), ['super-secret', 'super-secret', 'super-secret']);
});

test('overlap warnings start again for a later episode on the same object', async (t) => {
  const warnings = captureWarnings(t);
  const { promise: firstGate, resolve: release } = deferred();
  const operation = createApiOperation('listItems', async (input: number) => {
    await firstGate;
    return input;
  });

  const first = operation.execute(1);
  const second = operation.execute(2);
  assert.equal(warnings.length, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);

  const { promise: nextGate, resolve: releaseNext } = deferred();
  const laterFirst = operation.execute(3);
  const laterSecond = operation.execute(4);
  assert.equal(warnings.length, 2);
  releaseNext();
  assert.deepEqual(await Promise.all([laterFirst, laterSecond]), [3, 4]);
});

test('independent operations do not share pending state or warnings', async (t) => {
  const warnings = captureWarnings(t);
  const { promise: gate, resolve: release } = deferred();
  const left = createApiOperation('left', async () => {
    await gate;
    return 'left';
  });
  const right = createApiOperation('right', async () => {
    await gate;
    return 'right';
  });
  const first = left.execute(undefined);
  const second = right.execute(undefined);
  assert.equal(warnings.length, 0);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['left', 'right']);
});

test('same-named factory objects keep independent pending counters', async (t) => {
  const warnings = captureWarnings(t);
  enforceActions(t);
  const { promise: gate, resolve: release } = deferred();
  const run = async (): Promise<string> => {
    await gate;
    return 'ok';
  };
  const left = createObservableApiOperation('listItems', run);
  const right = createObservableApiOperation('listItems', run);
  const first = left.execute(undefined);
  const second = right.execute(undefined);
  assert.equal(warnings.length, 0);
  assert.equal(left.loading, true);
  assert.equal(right.loading, true);
  const extra = left.execute(undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /listItems/);
  assert.equal(left.loading, true);
  assert.equal(right.loading, true);
  release();
  await Promise.all([first, second, extra]);
  assert.equal(left.loading, false);
  assert.equal(right.loading, false);
});

test('overlapping invocations can finish out of order', async (t) => {
  const warnings = captureWarnings(t);
  enforceActions(t);
  const { promise: slow, resolve: releaseSlow } = deferred();
  const operation = createObservableApiOperation('items', async (input: 'slow' | 'fast') => {
    if (input === 'slow') await slow;
    await delay();
    return input;
  });
  const slowResult = operation.execute('slow');
  assert.equal(operation.loading, true);
  const fastResult = operation.execute('fast');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /items/);
  assert.equal(await fastResult, 'fast');
  assert.equal(operation.loading, true);
  releaseSlow();
  assert.equal(await slowResult, 'slow');
  assert.equal(operation.loading, false);
});

test('console.warn failures do not prevent execute', async (t) => {
  const original = console.warn;
  console.warn = (() => {
    throw new Error('logger unavailable');
  }) as Warn;
  t.after(() => {
    console.warn = original;
  });
  const { promise: gate, resolve: release } = deferred();
  const operation = createApiOperation('listItems', async () => {
    await gate;
    return 1;
  });
  const first = operation.execute(undefined);
  const second = operation.execute(undefined);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
});

test('failed execute leaves loading true while another call is still pending', async (t) => {
  enforceActions(t);
  const { promise: gate, resolve: release } = deferred();
  const operation = createObservableApiOperation('items', async (input: 'ok' | 'fail') => {
    if (input === 'fail') throw new Error('boom');
    await gate;
    return 'ok';
  });
  const success = operation.execute('ok');
  assert.equal(operation.loading, true);
  await assert.rejects(operation.execute('fail'), /boom/);
  assert.equal(operation.loading, true);
  release();
  assert.equal(await success, 'ok');
  assert.equal(operation.loading, false);
});

test('pending decrements after validation, network, and abort failures', async (t) => {
  enforceActions(t);
  const validation = createObservableApiOperation('validate', async () => {
    throw new Error('invalid input');
  });
  await assert.rejects(validation.execute(undefined), /invalid input/);
  assert.equal(validation.loading, false);

  const network = createObservableApiOperation('network', async () => {
    await delay();
    throw new Error('network');
  });
  await assert.rejects(network.execute(undefined), /network/);
  assert.equal(network.loading, false);

  const controller = new AbortController();
  const aborted = createObservableApiOperation(
    'abort',
    async (_input: undefined, options?: { signal?: AbortSignal }) => {
      await rejectOnAbort(options?.signal);
    },
  );
  const pending = aborted.execute(undefined, { signal: controller.signal });
  assert.equal(aborted.loading, true);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(aborted.loading, false);
});

test('MobX loading tracks pending with action-safe reactions', async (t) => {
  const warnings = captureWarnings(t);
  enforceActions(t);
  const loadings: boolean[] = [];
  const { promise: gate, resolve: release } = deferred();
  const observableOperation = createObservableApiOperation('listItems', async () => {
    await gate;
    return 'ok';
  });
  const stop = reaction(
    () => observableOperation.loading,
    (loading) => {
      loadings.push(loading);
    },
    { fireImmediately: true },
  );
  t.after(stop);
  assert.deepEqual(loadings, [false]);
  const first = observableOperation.execute(undefined);
  const second = observableOperation.execute(undefined);
  const third = observableOperation.execute(undefined);
  assert.equal(warnings.length, 2);
  assert.equal(observableOperation.loading, true);
  release();
  await Promise.all([first, second, third]);
  assert.equal(observableOperation.loading, false);
  assert.deepEqual(loadings, [false, true, false]);
});

test('stream execute loading ends when the response wrapper is available', async (t) => {
  enforceActions(t);
  async function* items(): AsyncIterable<number> {
    yield 1;
    await delay(20);
    yield 2;
  }
  const operation = createObservableApiOperation('readStream', async () => ({ body: items() }));
  const result = await operation.execute(undefined);
  assert.equal(operation.loading, false);
  const collected: number[] = [];
  for await (const item of result.body) {
    assert.equal(operation.loading, false);
    collected.push(item);
  }
  assert.deepEqual(collected, [1, 2]);
});

test('golem client runtime stays dependency-free of MobX and HTTP types', async () => {
  const clientUrl = import.meta.resolve('@exprtlabs/golem/client');
  const mobxUrl = import.meta.resolve('@exprtlabs/golem/mobx');
  const trackedUrl = new URL('./api-operation.js', clientUrl);
  const clientSource = readFileSync(fileURLToPath(clientUrl), 'utf8');
  const clientTypes = readFileSync(fileURLToPath(new URL('./client.d.ts', clientUrl)), 'utf8');
  const mobxSource = readFileSync(fileURLToPath(mobxUrl), 'utf8');
  const trackedSource = readFileSync(fileURLToPath(trackedUrl), 'utf8');
  assert.doesNotMatch(clientSource, /mobx/i);
  assert.doesNotMatch(clientSource, /AbortSignal|RequestInit|LibError|Headers/);
  assert.doesNotMatch(clientSource, /onPendingChange|Concurrent execute/);
  assert.doesNotMatch(clientTypes, /onPendingChange/);
  assert.match(clientSource, /createApiOperation/);
  assert.equal(createApiOperation.length, 2);
  assert.doesNotMatch(mobxSource, /Concurrent execute|pending \+= 1/);
  assert.match(mobxSource, /api-operation\.js/);
  assert.doesNotMatch(trackedSource, /mobx/i);
  assert.match(trackedSource, /Concurrent execute\(\) invocation/);
  const unpublished = '@exprtlabs/golem/api-operation';
  await assert.rejects(
    () => import(unpublished),
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
  );
  let forwarded = 0;
  const ignored = Reflect.apply(createApiOperation, undefined, [
    'listItems',
    async () => 1,
    () => {
      forwarded += 1;
    },
  ]) as ApiOperation<undefined, number>;
  assert.equal(await ignored.execute(undefined), 1);
  assert.equal(forwarded, 0);
});
