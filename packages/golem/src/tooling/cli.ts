import { spawn } from 'node:child_process';
import { BUILD_REFERENCES_REJECTION, runBuild } from './build.js';
import { runPipeline } from './pipeline.js';
import { watchPipeline } from './watch.js';
export { providersFor, runPipeline } from './pipeline.js';
export { watchPipeline } from './watch.js';
export { runBuild } from './build.js';
export type { PipelineOptions, PipelineState } from './pipeline.js';
export type Arguments =
  | { action: 'help' }
  | { action: 'build'; project: string; watch: boolean; config?: string }
  | { action: 'generate' | 'check' | 'watch' | 'exec'; config: string; watch: boolean; command: string[] };

function parseBuildArguments(args: readonly string[]): Arguments {
  let project = 'tsconfig.json';
  let watch = false;
  let config: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-b' || args[i] === '--build') throw new Error(BUILD_REFERENCES_REJECTION);
    if (args[i] === '-p' || args[i] === '--project') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${args[i]} requires a tsconfig path.`);
      project = args[++i];
    } else if (args[i] === '--config') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--config requires a filename.');
      config = args[++i];
    } else if (args[i] === '--watch') watch = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return { action: 'build', project, watch, ...(config === undefined ? {} : { config }) };
}

export function parseArguments(argv: readonly string[]): Arguments {
  const args = [...argv];
  const action = args.shift();
  if (!action || action === '--help' || action === '-h') return { action: 'help' };
  if (action === 'build') return parseBuildArguments(args);
  if (action !== 'generate' && action !== 'check' && action !== 'watch' && action !== 'exec') throw new Error(`Unknown command: ${action}`);
  let config = 'golem.yaml';
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
    process.stdout.write('Usage: golem <generate|check|watch|exec> [--config golem.yaml]\n       golem exec [--watch] -- <command> [args...]\n       golem build [-p tsconfig.json] [--config golem.yaml] [--watch]\n');
    return;
  }
  if (options.action === 'build') {
    const controller = new AbortController();
    let signalled: number | undefined;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { signalled = signal === 'SIGINT' ? 130 : 143; controller.abort(); });
    const { exitCode } = await runBuild({ project: options.project, watch: options.watch, signal: controller.signal, ...(options.config === undefined ? {} : { config: options.config }) });
    process.exitCode = signalled ?? exitCode;
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

