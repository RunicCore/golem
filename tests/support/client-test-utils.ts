import type { TestContext } from 'node:test';
import { configure } from 'mobx';

type Warn = typeof console.warn;

/** Records what `console.warn` receives, each call as one joined string, until the test ends. */
export function captureWarnings(t: TestContext): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  }) as Warn;
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

/** Makes MobX reject state changes outside actions until the test ends. */
export function enforceActions(t: TestContext): void {
  configure({ enforceActions: 'always' });
  t.after(() => configure({ enforceActions: 'observed' }));
}

/** One pass of a `[false, true]` MobX loop: clears the warnings of the earlier pass and, for the MobX pass, enforces actions. */
export function beginMobxPass(t: TestContext, mobx: boolean, warnings: string[]): void {
  warnings.length = 0;
  if (mobx) enforceActions(t);
}

export function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A promise that settles when `resolve` is called, for holding a request open. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Rejects with `aborted` when `signal` aborts, at once if it already did. A missing signal fails the test. */
export async function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<never> {
  if (!signal) throw new Error('missing signal');
  return new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('aborted'));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}
