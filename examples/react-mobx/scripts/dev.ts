import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const children: ChildProcess[] = [
  spawn(process.execPath, [path.join(directory, '.build/server/server.js')], {
    cwd: directory,
    env: process.env,
    stdio: 'inherit',
  }),
  spawn('vite', ['--host', '127.0.0.1'], {
    cwd: directory,
    env: process.env,
    stdio: 'inherit',
  }),
];

let stopping = false;
let exitCode = 0;
let exited = 0;

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 1500).unref();
}

for (const child of children) {
  child.once('error', error => {
    console.error(`Could not start the demo process: ${error.message}`);
    stop(1);
  });
  child.once('close', code => {
    exited += 1;
    // code is null when the child exited from a signal; treat that as a failure.
    if (!stopping) stop(code ?? 1);
    if (stopping && exited === children.length) process.exit(exitCode);
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
