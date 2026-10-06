import fs from 'node:fs';
import path from 'node:path';
import { hasErrorCode, isRecord } from './generator-api.js';

// The CLI loads this module at start, with no compiler: it imports only node modules and the generator API.

/** A process that holds a lock: its id and the `golem.yaml` it generates for. */
export interface LockOwner { readonly pid: number; readonly config: string }

/** The lock file of a shared folder. */
export function lockFileOf(folder: string): string {
  return path.join(folder, '.golem.lock');
}

/** Whether a process with this id runs. A process of another user is alive even when this one may not signal it. */
function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false;
    if (hasErrorCode(error, 'EPERM')) return true;
    throw error;
  }
}

type LockRead = { readonly kind: 'owner'; readonly owner: LockOwner; readonly text: string } | { readonly kind: 'gone' };

/** The owner a lock file names; a file that another process is just creating or removing is read again by the caller. */
function readLock(file: string): LockRead {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'gone' };
    throw error;
  }
  // The creator has made the file and not written it yet.
  if (text === '') return { kind: 'gone' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!isRecord(parsed) || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.config !== 'string') {
    throw new Error(`${file} is not a golem lock. If no golem process runs, delete it.`);
  }
  return { kind: 'owner', owner: { pid: parsed.pid, config: parsed.config }, text };
}

/**
 * The locks of the shared folders one process writes. At most one live process holds the lock of a folder, and only it writes
 * the shared companions there. A `process` lock stays until `dispose`: a watching process holds it while it runs. A `run` lock
 * ends with the write step of a one-shot run.
 */
export class SharedFolderLocks implements Disposable {
  private readonly held = new Set<string>();

  constructor(private readonly owner: LockOwner, private readonly lifetime: 'process' | 'run') {}

  /** `'held'` when this process holds the lock of `folder`, else the process that holds it. */
  hold(folder: string): 'held' | { readonly holder: LockOwner } {
    const resolved = path.resolve(folder);
    if (this.held.has(resolved)) return 'held';
    const file = lockFileOf(resolved);
    // A lock of a process that does not run is removed once; a lock that changes again belongs to a process that runs.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.create(file)) {
        this.held.add(resolved);
        return 'held';
      }
      const read = readLock(file);
      if (read.kind === 'gone') continue;
      if (isLive(read.owner.pid)) return { holder: read.owner };
      this.removeIfUnchanged(file, read.text);
    }
    throw new Error(`Could not take the lock ${file}: it keeps changing. If no golem process runs, delete it.`);
  }

  /** The end of the write step of a run: a `run` lock ends here, a `process` lock stays. */
  endRun(): void {
    if (this.lifetime === 'run') this.release();
  }

  [Symbol.dispose](): void {
    this.release();
  }

  /** Create the lock file with the owner in it; false when another process has it. */
  private create(file: string): boolean {
    let descriptor: number;
    try { descriptor = fs.openSync(file, 'wx'); }
    catch (error) {
      if (hasErrorCode(error, 'EEXIST')) return false;
      throw error;
    }
    try {
      fs.writeSync(descriptor, JSON.stringify({ pid: this.owner.pid, config: this.owner.config }));
    } catch (error) {
      // A lock with no owner in it would hold the folder for good.
      fs.rmSync(file, { force: true });
      throw error;
    } finally {
      fs.closeSync(descriptor);
    }
    return true;
  }

  /** Remove a lock whose process does not run, unless another process has taken it since it was read. */
  private removeIfUnchanged(file: string, text: string): void {
    const read = readLock(file);
    if (read.kind === 'owner' && read.text === text) fs.rmSync(file, { force: true });
  }

  private release(): void {
    const errors: unknown[] = [];
    for (const folder of this.held) {
      const file = lockFileOf(folder);
      try {
        const read = readLock(file);
        // A lock that another process has taken is no longer this process's.
        if (read.kind === 'owner' && read.owner.pid === this.owner.pid && read.owner.config === this.owner.config) fs.rmSync(file, { force: true });
      } catch (error) { errors.push(error); }
    }
    this.held.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Releasing shared folder locks failed.');
  }
}
