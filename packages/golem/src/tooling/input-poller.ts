import fs from 'node:fs';
import path from 'node:path';
import { hasErrorCode, isInsideDirectory } from './generator-api.js';

/** The signature of a path that does not exist. */
const MISSING = 'missing';
/** The folder golem keeps its own state in, which is never an input folder. */
const GOLEM_DIRECTORY = '.golem';

/** Content signature of a watched path: `missing`, `directory` (a directory's mtime also moves on output writes), or mtime, ctime and size. */
export function signature(filename: string): string {
  try {
    // Most watched paths are failed module-resolution probes; avoid an exception per missing path.
    const stat = fs.statSync(filename, { throwIfNoEntry: false });
    if (!stat) return MISSING;
    // Source discovery scans model names. Directory mtimes also change on output writes.
    return stat.isDirectory() ? 'directory' : `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return MISSING;
    throw error;
  }
}

/** What a poll sees: each input file's signature and the names in each polled folder. */
export interface InputSnapshot {
  readonly files: ReadonlyMap<string, string>;
  /** The sorted names in each folder; a folder that does not exist has no entry. */
  readonly folders: ReadonlyMap<string, readonly string[]>;
}

/** Which folders a poll lists besides the folders of the inputs. */
export interface PollScope {
  /** Where the walk up from an input ends: a file added beside an input inside it changes one of the folders on the way. */
  readonly root: string;
  /**
   * Folders outside `root` that hold sources: a source added beside one is a change. A source outside the root adds its own
   * folder and no other: what lies above it may be a whole monorepo.
   */
  readonly outsideDirectories: ReadonlySet<string>;
  /** Folders whose subfolders are listed too, so a source added in a folder that holds no input yet is seen. Folder links are not followed. */
  readonly descend?: readonly string[];
  /** A folder the descent does not enter. */
  readonly skipDescent?: (directory: string) => boolean;
}

/** An editor's temporary file or a hidden file: no input, and no reason to run again. */
function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('~');
}

function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** The names in a folder and its subfolders, or undefined when the folder does not exist. Any other failure (a permission, too many open files) is the loop's to report. */
function readFolder(directory: string): { readonly names: string[]; readonly directories: string[] } | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
    throw error;
  }
  const names: string[] = [];
  const directories: string[] = [];
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue;
    names.push(entry.name);
    if (entry.isDirectory() && !isIgnoredDirectory(entry.name)) directories.push(path.join(directory, entry.name));
  }
  return { names: names.sort(), directories };
}

/** The folders from the input's own up to the root, without those under `node_modules` or the root's `.golem`. */
function foldersAbove(root: string, input: string): string[] {
  const found: string[] = [];
  for (let directory = path.dirname(input); isInsideDirectory(root, directory); directory = path.dirname(directory)) {
    const [first, ...rest] = path.relative(root, directory).split(path.sep);
    if (first === GOLEM_DIRECTORY || [first, ...rest].includes('node_modules')) break;
    found.push(directory);
  }
  return found;
}

/** The directories above each input up to the root, and the outside directories. */
function watchedDirectories(root: string, inputs: readonly string[], outsideDirectories: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>(outsideDirectories);
  for (const input of inputs) {
    for (const directory of foldersAbove(root, input)) {
      if (directories.has(directory)) break;
      directories.add(directory);
    }
  }
  return directories;
}

function pathKey(filename: string): string {
  const resolved = path.resolve(filename);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Owned outputs and every directory above them, so an input that is an
 * output or contains one is recognized with one lookup per input.
 */
export class OwnedOutputIndex {
  private readonly covered = new Set<string>();

  constructor(filenames: Iterable<string> = []) {
    for (const filename of filenames) this.add(filename);
  }

  add(filename: string): void {
    let current = pathKey(filename);
    while (!this.covered.has(current)) {
      this.covered.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  /** Whether the input is an owned output or a directory containing one. */
  covers(input: string): boolean {
    return this.covered.has(pathKey(input));
  }
}

/**
 * Polls a fixed set of input files and the folders around them. Between two runs the inputs do not change, so the loop builds a
 * poller when a run ends and polls with it until the next run.
 */
export class InputPoller {
  private readonly files: readonly string[];
  private readonly directories: ReadonlySet<string>;

  constructor(inputs: Iterable<string>, private readonly scope: PollScope) {
    this.files = [...new Set(inputs)];
    this.directories = new Set([...watchedDirectories(scope.root, this.files, scope.outsideDirectories), ...scope.descend ?? []]);
  }

  snapshot(): InputSnapshot {
    const files = new Map<string, string>();
    for (const file of this.files) files.set(file, signature(file));
    const folders = new Map<string, readonly string[]>();
    const visit = (directory: string): void => {
      if (folders.has(directory)) return;
      const listed = readFolder(directory);
      if (listed === undefined) return;
      folders.set(directory, listed.names);
      if (!this.descends(directory)) return;
      for (const subfolder of listed.directories) if (!this.scope.skipDescent?.(subfolder)) visit(subfolder);
    };
    for (const directory of this.directories) visit(directory);
    return { files, folders };
  }

  private descends(directory: string): boolean {
    return (this.scope.descend ?? []).some((root) => isInsideDirectory(root, directory));
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * The paths that differ between two snapshots: each input whose signature changed, and each name added to or removed from a
 * folder, as folder + name. `owns` says which names the loop wrote itself: writing them is no change.
 */
export function changedPaths(previous: InputSnapshot, current: InputSnapshot, owns: (filename: string) => boolean = () => false): string[] {
  const changed = new Set<string>();
  for (const [file, value] of current.files) if (previous.files.get(file) !== value) changed.add(file);
  for (const file of previous.files.keys()) if (!current.files.has(file)) changed.add(file);
  const folderChanges = (directory: string): void => {
    const before = previous.folders.get(directory) ?? [];
    const after = current.folders.get(directory) ?? [];
    if (sameNames(before, after)) return;
    const beforeNames = new Set(before);
    const afterNames = new Set(after);
    for (const name of [...after.filter((candidate) => !beforeNames.has(candidate)), ...before.filter((candidate) => !afterNames.has(candidate))]) {
      const filename = path.join(directory, name);
      if (!owns(filename)) changed.add(filename);
    }
  };
  for (const directory of current.folders.keys()) folderChanges(directory);
  for (const directory of previous.folders.keys()) if (!current.folders.has(directory)) folderChanges(directory);
  return [...changed];
}

/**
 * What the next poll compares with after a run. An edit or a new file made during the run must start the next run, so the
 * baseline of an input is what it was before the run; else what it was when the run first read it; else `missing`, which the next
 * poll reports. A file the run wrote itself takes the signature it has now. A folder's names follow the same order without the
 * last step: a folder neither saw reports all its names.
 */
export class RunBaseline {
  private readonly firstFiles = new Map<string, string>();
  private readonly firstFolders = new Map<string, readonly string[]>();

  constructor(private readonly before: InputSnapshot, private readonly root: string) {}

  /** Records an input the run reads, and the folders on the way up to the root, unless the poll before the run already holds them. */
  observe(filename: string): void {
    if (!this.before.files.has(filename) && !this.firstFiles.has(filename)) this.firstFiles.set(filename, signature(filename));
    for (const directory of foldersAbove(this.root, filename)) {
      if (this.firstFolders.has(directory)) break;
      this.observeFolder(directory);
    }
  }

  /** Records the folder of a source outside the root. */
  observeFolder(directory: string): void {
    if (!this.before.folders.has(directory) && !this.firstFolders.has(directory)) this.recordFolder(directory);
  }

  /** The snapshot to poll against after the run: `current` is the poll taken when the run ended, and `owned` says which files the run wrote. */
  settle(current: InputSnapshot, owned: (filename: string) => boolean = () => false): InputSnapshot {
    const files = new Map<string, string>();
    for (const [file, value] of current.files) {
      files.set(file, owned(file) ? value : this.before.files.get(file) ?? this.firstFiles.get(file) ?? MISSING);
    }
    const folders = new Map<string, readonly string[]>();
    for (const directory of current.folders.keys()) {
      const names = this.before.folders.get(directory) ?? this.firstFolders.get(directory);
      if (names !== undefined) folders.set(directory, names);
    }
    return { files, folders };
  }

  private recordFolder(directory: string): void {
    // A folder that does not exist yet had no names: every name it has later is new.
    this.firstFolders.set(directory, readFolder(directory)?.names ?? []);
  }
}
