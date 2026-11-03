// Runs the API, the stand-in provider and the Vite dev server until one of them stops.
import { spawn } from 'node:child_process';

const commands = [
  [process.execPath, ['.build/server/src/main.js']],
  [process.execPath, ['.build/dev/provider.js']],
  ['npx', ['vite', '--host', '127.0.0.1']],
];
const children = commands.map(([command, args]) => spawn(command, args, { stdio: 'inherit' }));
const stop = (code) => {
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
};
for (const child of children) child.once('exit', (code) => stop(code ?? 1));
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
