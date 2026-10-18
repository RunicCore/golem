import { EventEmitter } from 'node:events';
import fs from 'node:fs';
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

/** Both events carry the file's own test: nesting 0, named by the path that the run was given. */
function isFileTest(data: TestEvent['data']): data is TestEvent['data'] & { readonly file: string; readonly name: string } {
  return data.nesting === 0 && data.file !== undefined && data.name !== undefined && path.resolve(data.name) === data.file;
}

/**
 * node:test reporter that writes one JSON line when a test file starts, `{"file":"tests/x.test.ts"}`, and one when it
 * ends, `{"file":"tests/x.test.ts","seconds":1.2}`. Use it with `--test-reporter-destination=<file>`: the lines stay
 * on disk when the run is killed, so `unfinishedFiles` can name the files that were running.
 *
 * The runner holds the events of a file until the files before it have reported, so the arrival time of an event
 * is not the file's time. The `test:dequeue` event of the file itself is emitted when the runner starts the file's
 * process. The `test:complete` event of the file is emitted when that process ends and carries its wall time.
 */
export default async function* testFileTimings(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const { type, data } of source) {
    if (!isFileTest(data)) continue;
    if (type === 'test:dequeue') yield `${JSON.stringify({ file: sourcePath(data.file, process.cwd()) })}\n`;
    if (type !== 'test:complete') continue;
    const durationMs = data.details?.duration_ms;
    // Deliberate: the image pins Node 22.15.0 (assertContainer), so a changed event contract cannot pass unnoticed.
    if (durationMs === undefined) throw new Error(`The test file ${data.file} ended with no duration_ms; the node:test event contract changed.`);
    yield `${JSON.stringify({ file: sourcePath(data.file, process.cwd()), seconds: Math.round(durationMs / 100) / 10 })}\n`;
  }
}

/**
 * The message that the entrypoint prints when the tier ceiling stops a run: each step that was running (`running` in
 * `<tier>-timings.json`) and the files of that step that started and did not end (its `.files.jsonl`).
 * A missing results file is part of the message. A results file that cannot be read throws, and the entrypoint prints that.
 */
export function ceilingReport(resultsDir: string, tier: string): string {
  const timingsFile = path.join(resultsDir, `${tier}-timings.json`);
  if (!fs.existsSync(timingsFile)) return `No ${tier}-timings.json: the run ended before its first step.`;
  const { running } = JSON.parse(fs.readFileSync(timingsFile, 'utf8')) as { running?: readonly string[] };
  if (running === undefined || running.length === 0) return 'No step was running.';
  return running.map(label => stepReport(resultsDir, label)).join('\n');
}

function stepReport(resultsDir: string, running: string): string {
  const stepFile = path.join(resultsDir, `${running}.files.jsonl`);
  if (!fs.existsSync(stepFile)) return `The ${running} step was running; it runs no test files.`;
  const started = new Set<string>();
  const ended = new Set<string>();
  let unreadable = 0;
  for (const line of fs.readFileSync(stepFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      const { file, seconds } = JSON.parse(line) as { file: string; seconds?: number };
      (seconds === undefined ? started : ended).add(file);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      unreadable++;
    }
  }
  const unfinished = [...started].filter(file => !ended.has(file));
  const note = unreadable ? ` (${unreadable} unreadable line${unreadable === 1 ? '' : 's'} in ${stepFile})` : '';
  const names = unfinished.length ? `Started and not finished:\n${unfinished.map(file => `  ${file}`).join('\n')}` : 'Every file that started had finished.';
  return `The ${running} step was running; ${ended.size} of ${started.size} started files finished. ${names}${note}`;
}
