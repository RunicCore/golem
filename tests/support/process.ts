import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface CommandOptions { readonly env?: NodeJS.ProcessEnv; readonly allowFailure?: boolean }
export interface NpmOptions { readonly includeOptional?: boolean; readonly env?: NodeJS.ProcessEnv }
export interface CommandResult { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }

export const workspace = fileURLToPath(new URL('../../../', import.meta.url));
/** The workspace's `golem` CLI, for a project that does not link it into its own node_modules. */
export const golem = path.join(workspace, 'packages/golem/dist/bin/golem.js');

// Children run in their own process groups so that they end with the test process. A test process that is
// stopped (the tier ceiling, Ctrl-C) would leave those groups running, so it ends them on the way out.
// A command has no time limit here: the tier ceiling is the one hang catcher.
const liveGroups = new Set<number>();
let exitCleanupInstalled = false;

function endLiveGroups(): void {
  for (const pid of liveGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  liveGroups.clear();
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once('exit', endLiveGroups);
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => { endLiveGroups(); process.kill(process.pid, name); });
  }
}

export function command(cwd: string, executable: string, args: readonly string[] = [], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: '', ...options.env };
    // A Node test worker's private context marker makes a nested `node --test`
    // skip its requested files. Child consumer commands run independently.
    delete env.NODE_TEST_CONTEXT;
    const group = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    if (group && child.pid) { installExitCleanup(); liveGroups.add(child.pid); }
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { if (child.pid) liveGroups.delete(child.pid); reject(error); });
    child.once('close', (code, exitSignal) => {
      if (child.pid) liveGroups.delete(child.pid);
      const result = { code, signal: exitSignal, stdout, stderr };
      if ((code !== 0 || exitSignal !== null) && !options.allowFailure) reject(new Error(`${executable} ${args.join(' ')} failed (${code}):\n${stdout.slice(-6000)}\n${stderr.slice(-6000)}`));
      else resolve(result);
    });
  });
}

/**
 * Offline tiers run with `--network none`, which is what keeps tests offline.
 * npm's own offline mode would also refuse the local fixture registry, whose
 * port changes every run, so consumer npm commands prefer the cache instead.
 * With no network, npm's fetch retries only delay a cache miss (70 s instead
 * of 1 s), so they are off.
 */
export const consumerNpmEnv = { npm_config_offline: 'false', npm_config_prefer_offline: 'true', npm_config_fetch_retries: '0' } as const;

/** Name `test:prepare` when npm could not get a package from the cache or from the unreachable public registry. */
export function explainCacheMiss(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message;
  const cacheMiss = /ENOTCACHED/.test(message)
    || (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH)\b/.test(message) && /registry\.npmjs\.org/.test(message));
  return cacheMiss
    ? new Error(`The npm cache is missing a package this test installs. Run: npm run test:prepare\n${message}`, { cause: error })
    : error;
}

export async function npm(root: string, args: readonly string[], options: NpmOptions = {}): Promise<CommandResult> {
  try {
    return await command(root, 'npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund',
      options.includeOptional === false ? '--omit=optional' : '--include=optional'], { env: { ...consumerNpmEnv, ...options.env } });
  } catch (error) {
    throw explainCacheMiss(error);
  }
}

export const cli = (root: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> => command(root, path.join(root, 'node_modules/.bin/golem'), args, options);
