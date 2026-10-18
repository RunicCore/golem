import { EventEmitter } from 'node:events';
import path from 'node:path';

// Spec, TAP and this reporter put 11 `end` listeners on the run's event stream, and node warns above 10.
// This module loads only in the runner parent, before the third reporter attaches.
EventEmitter.defaultMaxListeners = 20;

interface TestEvent {
  readonly type: string;
  readonly data: { readonly nesting?: number; readonly name?: string; readonly file?: string; readonly details?: { readonly duration_ms?: number } };
}

/** `.build/tests/x.test.js` is the compiled form of `tests/x.test.ts`. */
export function sourcePath(file: string, cwd: string): string {
  return path.relative(cwd, file).split(path.sep).join('/').replace(/^\.build\//, '').replace(/\.js$/, '.ts');
}

/**
 * node:test reporter that writes one JSON line, `{"file":"tests/x.test.ts","seconds":1.2}`, when a test file ends.
 * Use it with `--test-reporter-destination=<file>`: lines of finished files stay on disk when the run is killed.
 *
 * The runner holds the events of a file until the files before it have reported, so the arrival time of an event
 * is not the file's time. The `test:complete` event of the file itself (nesting 0, named by the path that the run was given) is emitted
 * when the file's process ends and carries that process's wall time.
 */
export default async function* testFileTimings(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const { type, data } of source) {
    if (type !== 'test:complete' || data.nesting !== 0 || data.file === undefined || data.name === undefined || path.resolve(data.name) !== data.file) continue;
    const durationMs = data.details?.duration_ms;
    // Deliberate: the image pins Node 22.15.0 (assertContainer), so a changed event contract cannot pass unnoticed.
    if (durationMs === undefined) throw new Error(`The test file ${data.file} ended with no duration_ms; the node:test event contract changed.`);
    yield `${JSON.stringify({ file: sourcePath(data.file, process.cwd()), seconds: Math.round(durationMs / 100) / 10 })}\n`;
  }
}
