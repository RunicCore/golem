import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface CommandOptions { readonly env?: NodeJS.ProcessEnv; readonly timeout?: number; readonly allowFailure?: boolean }
export interface NpmOptions { readonly includeOptional?: boolean; readonly env?: NodeJS.ProcessEnv }
export interface CommandResult { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }

export const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export const ttsc = path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js');
export const ttscEnv = { NODE_PATH: path.join(workspace, 'node_modules') };
/** Time a timed-out command's process group gets to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5000;

// Children run in their own process groups so a timeout can end their whole
// tree. A test process that is itself stopped (a file timeout, Ctrl-C) would
// leave those groups running, so it ends them on the way out.
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
    if (
      executable === process.execPath
      && typeof args[0] === 'string'
      && args[0].includes(`${path.sep}ttsc${path.sep}`)
    ) {
      if (!options.env?.NODE_PATH) env.NODE_PATH = path.join(workspace, 'node_modules');
      // Temporary projects still build their own plugin binaries. Reuse Go's
      // content-addressed dependency cache instead of rebuilding the compiler
      // dependencies for every isolated fixture.
      if (args[1] !== 'clean' && !env.TTSC_GO_CACHE_DIR && !env.GOCACHE) {
        env.TTSC_GO_CACHE_DIR = path.join(workspace, 'node_modules/.cache/ttsc/go-build');
      }
    }
    // A Node test worker's private context marker makes a nested `node --test`
    // skip its requested files. Child consumer commands run independently.
    delete env.NODE_TEST_CONTEXT;
    const group = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    if (group && child.pid) { installExitCleanup(); liveGroups.add(child.pid); }
    let stdout = '', stderr = '', timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals): void => {
      try { if (group && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
    };
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const limit = options.timeout ?? 120_000;
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    }, limit);
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); if (child.pid) liveGroups.delete(child.pid); reject(error); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(escalation);
      if (child.pid) liveGroups.delete(child.pid);
      // A timed-out child's descendants may still hold the group; end them too.
      if (timedOut) { signal('SIGKILL'); reject(new Error(`Timed out after ${limit} ms: ${executable} ${args.join(' ')}\n${stderr.slice(-4000)}`)); return; }
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
