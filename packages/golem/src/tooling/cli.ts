import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { GeneratorSessionResources, runPipeline } from './pipeline.js';
import type { PipelineState } from './pipeline.js';
import { requestTypeScriptRoot } from './typescript-selection.js';
import { baselineBeforeRun, summarizeRun, watchPipeline } from './watch.js';
export { providersFor, runPipeline } from './pipeline.js';
export { watchPipeline } from './watch.js';
export type { PipelineState } from './pipeline.js';

export type Arguments =
  | { action: 'help' }
  | { action: 'build'; project?: string; watch: boolean; config?: string; compilerBuild?: true; tscArguments?: readonly string[] }
  | { action: 'generate' | 'check' | 'watch' | 'exec'; config: string; watch: boolean; command: string[] };

/** The arguments `golem build` sets itself in its check and emit programs, by lowercase name, with why and what to do instead. */
const BUILD_OWNED_ARGUMENTS: Readonly<Record<string, { readonly why: string; readonly workaround: string }>> = {
  '--nocheck': { why: 'the emit program skips the type check and the check program reports the errors', workaround: 'a build emits JavaScript when the check fails unless noEmitOnError is set' },
  '--noemit': { why: 'the check program writes no JavaScript and the emit program writes it', workaround: 'set noEmit in the tsconfig to check without emitting' },
  '--emitdeclarationonly': { why: 'the check program writes the declarations from your sources and the emit program writes the JavaScript', workaround: 'set emitDeclarationOnly in the tsconfig for a declarations-only build' },
  '--tsbuildinfofile': { why: 'golem keeps no TypeScript build state: it compares each output with the file on disk', workaround: 'leave it out; a build with nothing changed writes no file' },
  '--incremental': { why: 'golem keeps no TypeScript build state: it compares each output with the file on disk', workaround: 'leave it out; a build with nothing changed writes no file' },
  '--outdir': { why: 'the emit program writes into the outDir of the tsconfig', workaround: 'set outDir in the tsconfig, or pass -p a tsconfig that extends it and sets another outDir' },
  '--outfile': { why: 'TypeScript 7 removed outFile and TypeScript 6 deprecates it, so one build cannot write the same files on both', workaround: 'emit one file for each source, then bundle with esbuild or Vite and the golem plugin' },
  '--listemittedfiles': { why: 'golem writes the outputs itself and prints no list of them', workaround: 'list the files in outDir after the build' },
  ...Object.fromEntries(([
    ['--baseUrl', 'golem reads the baseUrl and paths of the tsconfig to give each import the path Node loads'],
    ['--composite', 'the emit program is not a composite build, and the check program must report what it reports'],
    ['--declarationDir', 'the check program writes the declarations from your sources into the directory of the tsconfig'],
  ] as const).map(([flag, why]) => [flag.toLowerCase(), { why, workaround: 'set it in tsconfig.json' }])),
};

/** `golem build` takes `--config`, `-p/--project` and `--watch` (`-w` too, so the compiler's own watcher never starts); every other argument goes to the check program and the emit program unchanged. */
function parseBuildArguments(args: readonly string[]): Arguments {
  let project: string | undefined;
  let watch = false;
  let config: string | undefined;
  let compilerBuild = false;
  const tscArguments: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-b' || args[i] === '--build') compilerBuild = true;
    else if (args[i] === '-p' || args[i] === '--project') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${args[i]} requires a tsconfig path.`);
      project = args[++i];
    } else if (args[i] === '--config') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--config requires a filename.');
      config = args[++i];
    } else if (args[i] === '--watch' || args[i] === '-w') watch = true;
    else {
      const key = args[i].toLowerCase();
      const owned = Object.hasOwn(BUILD_OWNED_ARGUMENTS, key) ? BUILD_OWNED_ARGUMENTS[key] : undefined;
      if (owned) throw new Error(`golem build sets ${args[i]} itself (${owned.why}); ${owned.workaround}`);
      tscArguments.push(args[i]);
    }
  }
  return { action: 'build', watch, ...(compilerBuild ? { compilerBuild: true as const } : {}), ...(project === undefined ? {} : { project }), ...(config === undefined ? {} : { config }), ...(tscArguments.length === 0 ? {} : { tscArguments }) };
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

/** The directory of the tsconfig the golem.yaml names. A golem.yaml that cannot be read is reported by the command itself, which reads it again. */
async function tsconfigDirectory(configFile: string): Promise<string> {
  try {
    return path.dirname((await resolveConfig(configFile)).tsconfig);
  } catch {
    return path.dirname(path.resolve(configFile));
  }
}

/** The line a watch run ends with. */
const printRun = (line: string): void => { process.stdout.write(`${line}\n`); };

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.action === 'help') {
    process.stdout.write('Usage: golem <generate|check|watch|exec> [--config golem.yaml]\n       golem exec [--watch] -- <command> [args...]\n       golem build [--config golem.yaml] [-p tsconfig.build.json] [--watch] [tsc arguments...]\n');
    return;
  }
  // The project's TypeScript is the one beside its tsconfig, wherever the command runs from; the seam reads this when it first loads.
  requestTypeScriptRoot(await tsconfigDirectory(options.config ?? 'golem.yaml'), { lazy: true });
  if (options.action === 'build') {
    const controller = new AbortController();
    let signalled: number | undefined;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { signalled = signal === 'SIGINT' ? 130 : 143; controller.abort(); });
    // `golem build` loads its compiler seam only when it runs: no other command needs TypeScript to start.
    const { runBuild } = await import('./build.js');
    const onBuilt = ({ label, exitCode }: { readonly label: string; readonly exitCode: number }): void => {
      if (exitCode === 0) process.stdout.write(`Built ${label}.\n`);
      else if (options.watch) process.stdout.write('Build failed.\n');
    };
    const { exitCode } = await runBuild({ watch: options.watch, signal: controller.signal, onBuilt, ...(options.compilerBuild ? { compilerBuild: true } : {}), ...(options.project === undefined ? {} : { project: options.project }), ...(options.config === undefined ? {} : { config: options.config }), ...(options.tscArguments === undefined ? {} : { tscArguments: options.tscArguments }) });
    process.exitCode = signalled ?? exitCode;
    return;
  }
  if (options.action === 'watch') {
    // With no folder to watch the watch ends by itself, and the exit code says it failed.
    const stop = watchPipeline(options.config, undefined, { onUnwatchable: () => { process.exitCode = 1; }, onRun: printRun });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stop(); process.exitCode = signal === 'SIGINT' ? 130 : 143; });
    return;
  }
  // A watching command keeps one session from its first run on, so the compilers of the first run stay warm for the watch.
  const watchSession = options.watch ? new GeneratorSessionResources() : undefined;
  let state: PipelineState;
  // What the first run reads first, so a source added during it starts the watch's first run.
  const firstRun = watchSession === undefined ? undefined : baselineBeforeRun(options.config);
  const started = performance.now();
  try {
    state = await runPipeline(options.config, { check: options.action === 'check', ...(watchSession === undefined ? {} : { session: watchSession }), ...(firstRun === undefined ? {} : { onInput: firstRun.onInput }) });
  } catch (error) {
    watchSession?.[Symbol.dispose]();
    throw error;
  }
  // A watching command prints the line every run of its watch prints; the other commands name what they did.
  process.stdout.write(watchSession === undefined ? `${options.action === 'check' ? 'Checked' : 'Generated'} configured outputs.\n` : `${summarizeRun(state, Math.round(performance.now() - started))}\n`);
  const stop = watchSession === undefined ? () => {} : watchPipeline(state, undefined, { session: watchSession, ...(firstRun === undefined ? {} : { firstBaseline: firstRun.baseline }), onRun: printRun });
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

