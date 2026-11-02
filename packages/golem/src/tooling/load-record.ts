import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isInsideDirectory } from './generator-core.js';

/** The URL of every file this process has loaded since `recordLoadedFiles` ran. A module that is loaded again fires no second load, so the set is process-wide. */
const loaded = new Set<string>();
let recording = false;

/**
 * Starts recording the files the process loads, by a `load` hook (`module.registerHooks`, Node 22.15 and later) that passes every load on unchanged.
 * Call it before the first import of provider or extension code: a file loaded earlier is not recorded. Once per process; a second call does nothing.
 * The hook stays for the life of the process, because a lazy import after one run ends is code that a later run needs to know about.
 */
export function recordLoadedFiles(): void {
  if (recording) return;
  recording = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) loaded.add(url);
      return nextLoad(url, context);
    },
  });
}

/** The files under `folder` that this process has loaded, as absolute paths, in path order. Another job's files in the same folder are included: a larger set can only add a rerun. */
export function loadedFilesUnder(folder: string): string[] {
  const files = new Set<string>();
  for (const url of loaded) {
    const filename = fileURLToPath(url);
    if (isInsideDirectory(folder, filename)) files.add(filename);
  }
  return [...files].sort();
}
