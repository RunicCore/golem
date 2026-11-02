import { realInputFiles } from '#golem/input-watcher';
import type { InputFiles } from '#golem/input-watcher';

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

/**
 * Makes a change to a folder that a watch has just opened, and makes it again until `check` holds. fs.watch returns before FSEvents (macOS)
 * starts its stream and the stream has no ready event, so a change made in that first moment is lost; the same change made again is seen.
 * `edit` writes the same content each time, so a repeat changes nothing the first write did not.
 */
export async function editUntil(edit: () => void, check: () => boolean, message: string | (() => string), timeout = 25_000, repeatAfter = 1_000): Promise<void> {
  let editedAt = Number.NEGATIVE_INFINITY;
  await until(() => {
    if (!check() && Date.now() - editedAt >= repeatAfter) { edit(); editedAt = Date.now(); }
    return check();
  }, message, timeout);
}

/**
 * Counts the reads a watch makes (`stat`, `list`) and the folder watches it opens and has not closed, through the `InputFiles` seam.
 */
export function countingInputFiles(): { readonly files: InputFiles; readonly reads: () => number; readonly openWatches: () => number } {
  let reads = 0;
  const watches: { closed: boolean }[] = [];
  const files: InputFiles = {
    stat: (filename) => { reads += 1; return realInputFiles.stat(filename); },
    list: (directory) => { reads += 1; return realInputFiles.list(directory); },
    watch: (folder, listener) => {
      const watcher = realInputFiles.watch(folder, listener);
      const record = { closed: false };
      const close = watcher.close.bind(watcher);
      watcher.close = () => { record.closed = true; close(); };
      watches.push(record);
      return watcher;
    },
  };
  return { files, reads: () => reads, openWatches: () => watches.filter((record) => !record.closed).length };
}
