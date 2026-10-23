import fs from 'node:fs';
import type { TestContext } from 'node:test';

/** Polls `check` until it holds. A message that reports state is a function: it runs when the wait times out, not when the wait starts. */
export async function until(check: () => boolean, message: string | (() => string), timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${typeof message === 'function' ? message() : message}`);
}

/** Waits `ms` for something that must not happen: an absence has no event to wait for, so this is the one place a watch test sleeps. */
export function quietly(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Counts the folder watches the code under test opens with `fs.watch`, and how many of them it has not closed. */
export function trackWatchers(t: TestContext): { readonly opened: () => number; readonly open: () => number } {
  const watchers: { closed: boolean }[] = [];
  const watch = fs.watch.bind(fs) as (...args: unknown[]) => fs.FSWatcher;
  t.mock.method(fs, 'watch', (...args: unknown[]) => {
    const watcher = watch(...args);
    const record = { closed: false };
    const close = watcher.close.bind(watcher);
    watcher.close = () => { record.closed = true; close(); };
    watchers.push(record);
    return watcher;
  });
  return { opened: () => watchers.length, open: () => watchers.filter((watcher) => !watcher.closed).length };
}
