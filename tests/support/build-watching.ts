import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { type TestContext } from 'node:test';
import { golem } from './process.js';

/** How long a watching build gets to exit after SIGINT before the test fails with what it printed. */
const STOP_TIMEOUT_MS = 15_000;

export interface Watching { readonly pid: number; readonly output: () => string; readonly stop: () => Promise<number | null> }

export function watching(t: TestContext, root: string): Watching {
  const child: ChildProcess = spawn(process.execPath, [golem, 'build', '--watch', '-p', 'tsconfig.json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk; });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => { child.kill('SIGKILL'); });
  const stop = async (): Promise<number | null> => {
    child.kill('SIGINT');
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`golem build --watch did not exit ${STOP_TIMEOUT_MS} ms after SIGINT. Output:\n${output}`)); }, STOP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([exited, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  assert.ok(child.pid, 'the watching build started');
  return { pid: child.pid, output: () => output, stop };
}

export const count = (output: string, pattern: RegExp): number => output.split('\n').filter((line) => pattern.test(line)).length;
