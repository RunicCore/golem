import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelRuntimeValidator } from '@exprtlabs/codegen/model';
import { runValidation } from '@exprtlabs/codegen/validation';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, message: string, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validatorWithErrors(
  run: (value: unknown) => boolean | Promise<boolean>,
  state: { errors: readonly unknown[] | null },
): ModelRuntimeValidator {
  const validator = run as ModelRuntimeValidator;
  Object.defineProperty(validator, 'errors', {
    enumerable: true,
    get: () => state.errors,
  });
  return validator;
}

test('runValidation keeps its asynchronous public contract for synchronous validators', async () => {
  const validator = validatorWithErrors(() => true, { errors: null });
  const result = runValidation(validator, 'value');

  assert.equal(result instanceof Promise, true);
  assert.deepEqual(await result, { valid: true, errors: [] });

  const cause = new Error('synchronous public failure');
  const throwing = (() => { throw cause; }) as ModelRuntimeValidator;
  const rejected = runValidation(throwing, 'value');
  assert.equal(rejected instanceof Promise, true);
  await assert.rejects(rejected, (error: unknown) => error === cause);
});

test('runValidation captures mutable synchronous errors and returns independent snapshots', async () => {
  const state: { errors: readonly unknown[] | null } = { errors: null };
  const validator = validatorWithErrors((value) => {
    if (value === 'invalid') {
      state.errors = [{ keyword: 'type', instancePath: '/name', message: 'Expected string' }];
      return false;
    }
    state.errors = null;
    return true;
  }, state);

  const invalid = await runValidation(validator, 'invalid');
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors, [{ keyword: 'type', instancePath: '/name', message: 'Expected string' }]);
  assert.notEqual(invalid.errors, state.errors);

  const valid = await runValidation(validator, 'valid');
  assert.deepEqual(valid, { valid: true, errors: [] });
});

test('runValidation serializes calls for one async validator and keeps each error result stable', async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const state: { errors: readonly unknown[] | null } = { errors: null };
  const calls: string[] = [];
  const validator = validatorWithErrors((value) => {
    const label = String(value);
    calls.push(`start:${label}`);
    (label === 'first' ? firstStarted : secondStarted).resolve();
    return (label === 'first' ? firstGate : secondGate).promise.then(() => {
      calls.push(`finish:${label}`);
      state.errors = [{ keyword: 'custom', instancePath: `/${label}`, message: label }];
      return false;
    });
  }, state);

  const firstPromise = runValidation(validator, 'first');
  await firstStarted.promise;
  const secondPromise = runValidation(validator, 'second');
  await Promise.resolve();
  assert.deepEqual(calls, ['start:first']);

  firstGate.resolve();
  const first = await firstPromise;
  assert.deepEqual(first.errors, [{ keyword: 'custom', instancePath: '/first', message: 'first' }]);

  await secondStarted.promise;
  assert.deepEqual(calls, ['start:first', 'finish:first', 'start:second']);
  secondGate.resolve();
  const second = await secondPromise;
  assert.deepEqual(second.errors, [{ keyword: 'custom', instancePath: '/second', message: 'second' }]);
  assert.deepEqual(first.errors, [{ keyword: 'custom', instancePath: '/first', message: 'first' }]);
  assert.deepEqual(calls, ['start:first', 'finish:first', 'start:second', 'finish:second']);
});

test('independent validators are not globally serialized', async () => {
  const aStarted = deferred<void>();
  const aGate = deferred<void>();
  const events: string[] = [];
  const aState: { errors: readonly unknown[] | null } = { errors: null };
  const bState: { errors: readonly unknown[] | null } = { errors: null };
  const a = validatorWithErrors(() => {
    events.push('a:start');
    aStarted.resolve();
    return aGate.promise.then(() => {
      events.push('a:finish');
      aState.errors = [{ keyword: 'type', message: 'a' }];
      return false;
    });
  }, aState);
  const b = validatorWithErrors(() => {
    events.push('b:run');
    bState.errors = [{ keyword: 'type', message: 'b' }];
    return false;
  }, bState);

  const aPromise = runValidation(a, 'a');
  await aStarted.promise;
  const bResult = await runValidation(b, 'b');
  assert.deepEqual(bResult.errors, [{ keyword: 'type', message: 'b' }]);
  assert.deepEqual(events, ['a:start', 'b:run']);

  aGate.resolve();
  const aResult = await aPromise;
  assert.deepEqual(aResult.errors, [{ keyword: 'type', message: 'a' }]);
  assert.deepEqual(events, ['a:start', 'b:run', 'a:finish']);
});

test('a non-boolean validator result is an error', async () => {
  const invalidReturn = (() => 1 as unknown as boolean) as ModelRuntimeValidator;
  await assert.rejects(
    runValidation(invalidReturn, {}),
    /validation engine must return a boolean result/,
  );
});

test('runValidation recovers its queue after an exact synchronous throw', async () => {
  const cause = new Error('exact synchronous failure');
  const calls: string[] = [];
  let first = true;
  const validator = validatorWithErrors((value) => {
    calls.push(String(value));
    if (first) {
      first = false;
      throw cause;
    }
    return true;
  }, { errors: null });

  const firstPromise = runValidation(validator, 'first');
  const secondPromise = runValidation(validator, 'second');

  await assert.rejects(
    bounded(firstPromise, 'synchronous failure did not settle'),
    (error: unknown) => error === cause,
  );
  assert.deepEqual(
    await bounded(secondPromise, 'queue did not recover after a synchronous failure'),
    { valid: true, errors: [] },
  );
  assert.deepEqual(calls, ['first', 'second']);
});

test('runValidation recovers its queue after an async rejection', async () => {
  const firstStarted = deferred<void>();
  const firstGate = deferred<void>();
  const cause = new Error('exact async failure');
  const calls: string[] = [];
  const validator = validatorWithErrors((value) => {
    const label = String(value);
    calls.push(`start:${label}`);
    if (label === 'first') {
      firstStarted.resolve();
      return firstGate.promise.then(() => {
        throw cause;
      });
    }
    return true;
  }, { errors: null });

  const firstPromise = runValidation(validator, 'first');
  await bounded(firstStarted.promise, 'first async invocation did not start');
  const secondPromise = runValidation(validator, 'second');
  firstGate.resolve();

  await assert.rejects(
    bounded(firstPromise, 'async failure did not settle'),
    (error: unknown) => error === cause,
  );
  assert.deepEqual(
    await bounded(secondPromise, 'queue did not recover after an async failure'),
    { valid: true, errors: [] },
  );
  assert.deepEqual(calls, ['start:first', 'start:second']);
});
