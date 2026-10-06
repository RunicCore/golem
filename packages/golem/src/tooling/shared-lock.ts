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

type LockRead = { readonly kind: 'owner'; readonly owner: LockOwner; readonly text: string } | { readonly kind: 'empty' } | { readonly kind: 'gone' };

/** How long a lock file that has no owner in it yet is waited for: its creator is between creating the file and writing it. */
const EMPTY_LOCK_WAIT_MS = 1000;
const EMPTY_LOCK_POLL_MS = 20;

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** The owner a lock file names. */
function readLock(file: string): LockRead {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'gone' };
    throw error;
  }
  if (text === '') return { kind: 'empty' };
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
    const file = lockFileOf(resolved);
    if (this.held.has(resolved)) {
      if (this.names(file)) return 'held';
      // Another process removed this lock as stale and took the folder: it is not held now.
      this.held.delete(resolved);
    }
    // A stale lock is removed once; a lock that changes again belongs to a process that runs.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.create(file)) {
        this.held.add(resolved);
        return 'held';
      }
      let read = readLock(file);
      if (read.kind === 'empty') read = this.waitForOwner(file);
      if (read.kind === 'gone') continue;
      if (read.kind === 'empty') {
        // Its creator ended between creating the file and writing it.
        this.removeIfUnchanged(file, read);
        continue;
      }
      // This process holds no lock here, so a lock with its id is left by an earlier process that had the same id.
      if (read.owner.pid !== this.owner.pid && isLive(read.owner.pid)) return { holder: read.owner };
      this.removeIfUnchanged(file, read);
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

  /** Whether the lock file names this owner. */
  private names(file: string): boolean {
    const read = readLock(file);
    return read.kind === 'owner' && read.owner.pid === this.owner.pid && read.owner.config === this.owner.config;
  }

  /** Read a lock file whose creator has not written it yet, until it has an owner or the wait ends. */
  private waitForOwner(file: string): LockRead {
    let read: LockRead = { kind: 'empty' };
    for (let waited = 0; read.kind === 'empty' && waited < EMPTY_LOCK_WAIT_MS; waited += EMPTY_LOCK_POLL_MS) {
      pause(EMPTY_LOCK_POLL_MS);
      read = readLock(file);
    }
    return read;
  }

  /** Remove a stale lock, unless another process has taken it since `seen` was read. */
  private removeIfUnchanged(file: string, seen: LockRead): void {
    const read = readLock(file);
    if ((read.kind === 'owner' && seen.kind === 'owner' && read.text === seen.text) || (read.kind === 'empty' && seen.kind === 'empty')) fs.rmSync(file, { force: true });
  }

  private release(): void {
    const errors: unknown[] = [];
    for (const folder of this.held) {
      const file = lockFileOf(folder);
      try {
        // A lock that another process has taken is no longer this process's.
        if (this.names(file)) fs.rmSync(file, { force: true });
      } catch (error) { errors.push(error); }
    }
    this.held.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Releasing shared folder locks failed.');
  }
}
