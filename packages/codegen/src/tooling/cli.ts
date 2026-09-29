import { spawn } from 'node:child_process';
import { runPipeline } from './pipeline.js';
import { watchPipeline } from './watch.js';
export { providersFor, runPipeline } from './pipeline.js';
export { watchPipeline } from './watch.js';
export type { PipelineOptions, PipelineState } from './pipeline.js';
export type Arguments = { action: 'help' } | { action: 'generate' | 'check' | 'watch' | 'exec'; config: string; watch: boolean; command: string[] };

export function parseArguments(argv: readonly string[]): Arguments {
  const args = [...argv];
  const action = args.shift();
  if (!action || action === '--help' || action === '-h') return { action: 'help' };
  if (action !== 'generate' && action !== 'check' && action !== 'watch' && action !== 'exec') throw new Error(`Unknown command: ${action}`);
  let config = 'runic-codegen.yaml';
  let watch = false;
  let command: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires a filename.');
      config = args[++i];
    } else if (args[i] === '--watch' && action === 'exec') watch = true;
    else if (args[i] === '--' && action === 'exec') { command = args.slice(i + 1); break; }
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (action === 'exec' && !command.length) throw new Error('exec requires -- <command> [args...].');
  return { action, config, watch, command };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.action === 'help') {
    process.stdout.write('Usage: runic-codegen <generate|check|watch|exec> [--config runic-codegen.yaml]\n       runic-codegen exec [--watch] -- <command> [args...]\n');
    return;
  }
  if (options.action === 'watch') {
    const stop = watchPipeline(options.config);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stop(); process.exitCode = signal === 'SIGINT' ? 130 : 143; });
    return;
  }
  const state = await runPipeline(options.config, { check: options.action === 'check' });
  process.stdout.write(`${options.action === 'check' ? 'Checked' : 'Generated'} configured outputs.\n`);
  const stop = options.watch ? watchPipeline(state) : () => {};
  if (options.action === 'exec') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.command[0], options.command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
      const handlers = new Map<NodeJS.Signals, () => void>();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handler = () => { stop(); child.kill(signal); };
        handlers.set(signal, handler);
        process.once(signal, handler);
      }
      const cleanup = () => { stop(); for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('exit', (code, signal) => {
        cleanup();
        if (signal) process.kill(process.pid, signal);
        else process.exitCode = code || 0;
        resolve();
      });
    });
  }
}

