import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, hasErrorCode, isInsideDirectory } from './generator-api.js';

/**
 * The stat, listing and folder-watch calls a watch makes between two runs. A watch uses the real ones; a test passes its own to fault a
 * folder watch (ENOSPC, EMFILE) or to count the reads of an idle watch. An error from a call is the error the real call would raise.
 */
export interface InputFiles {
  /** The stat of a path, or undefined when it does not exist. */
  readonly stat: (filename: string) => fs.Stats | undefined;
  readonly list: (directory: string) => fs.Dirent[];
  readonly watch: (folder: string, listener: (event: string, name: string | null) => void) => fs.FSWatcher;
}

export const realInputFiles: InputFiles = {
  stat: filename => fs.statSync(filename, { throwIfNoEntry: false }),
  list: directory => fs.readdirSync(directory, { withFileTypes: true }),
  watch: (folder, listener) => fs.watch(folder, listener),
};

/** The signature of a path that does not exist. */
const MISSING = 'missing';
const NODE_MODULES = 'node_modules';
/** The folder golem keeps its own state in, which is never an input folder. */
const GOLEM_DIRECTORY = '.golem';

/** Content signature of a watched path: `missing`, `directory` (a directory's mtime also moves on output writes), or mtime, ctime and size. */
function signature(filename: string, files: InputFiles): string {
  try {
    // Most watched paths are failed module-resolution probes; avoid an exception per missing path.
    const stat = files.stat(filename);
    if (!stat) return MISSING;
    // Source discovery scans model names. Directory mtimes also change on output writes.
    return stat.isDirectory() ? 'directory' : `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return MISSING;
    throw error;
  }
}

/** What a scan sees: each input file's signature and the names in each scanned folder. */
export interface InputSnapshot {
  readonly files: ReadonlyMap<string, string>;
  /** The sorted names in each folder; a folder that does not exist has no entry. */
  readonly folders: ReadonlyMap<string, readonly string[]>;
}

/** Which folders a scan lists besides the folders of the inputs and the folders of the inputs outside the root. */
export interface ScanScope {
  /** Where the walk up from an input ends: a file added beside an input inside it changes one of the folders on the way. */
  readonly root: string;
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
  return name.startsWith('.') || name === NODE_MODULES;
}

/** The names in a folder and its subfolders, or undefined when the folder does not exist. Any other failure (a permission, too many open files) is the loop's to report. */
function readFolder(directory: string, files: InputFiles): { readonly names: string[]; readonly directories: string[] } | undefined {
  let entries: fs.Dirent[];
  try {
    entries = files.list(directory);
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
    if (first === GOLEM_DIRECTORY || [first, ...rest].includes(NODE_MODULES)) break;
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

/** Whether a path lies in an installed package's folder. */
function inNodeModules(filename: string): boolean {
  return filename.split(path.sep).includes(NODE_MODULES);
}

/**
 * The folder of an input outside the root, which a file added beside it joins; undefined for an input inside the root or under
 * `node_modules`. A path that does not exist counts too, as a file that may be created, unless its folder holds the root: the
 * probes for a `package.json` in every folder above the project would watch a whole monorepo, or the temporary folder.
 */
export function outsideFolder(root: string, input: string): string | undefined {
  if (isInsideDirectory(root, input) || inNodeModules(input)) return undefined;
  const folder = path.dirname(input);
  return fs.existsSync(input) || !isInsideDirectory(folder, root) ? folder : undefined;
}

/**
 * The inputs of a run that a watch reads, and the folders around them. An installed package's file is no input: a new install
 * is told by its marker. A file reached through a link is an input when the link leads out of every `node_modules`, as a
 * workspace package does under `preserveSymlinks`. Between two runs the inputs do not change, so the loop builds a scan when a run
 * ends and scans with it until the next run; the real paths are read once, then.
 */
export class InputScan {
  /** The inputs it stats: those outside `node_modules`, and linked workspace files. */
  readonly files: readonly string[];
  /** The folders of the linked files, where a change to one of them happens; they are watched and not listed. */
  readonly linkedFolders: ReadonlySet<string>;
  private readonly fileSet: ReadonlySet<string>;
  private readonly directories: ReadonlySet<string>;

  constructor(inputs: Iterable<string>, private readonly scope: ScanScope, private readonly reader: InputFiles) {
    const files: string[] = [];
    const linked = new Set<string>();
    const realFolders = new Map<string, string | undefined>();
    const realFolder = (folder: string): string | undefined => {
      if (!realFolders.has(folder)) realFolders.set(folder, realPath(folder));
      return realFolders.get(folder);
    };
    for (const input of new Set(inputs)) {
      if (!inNodeModules(input)) {
        files.push(input);
        continue;
      }
      const folder = realFolder(path.dirname(input));
      if (folder === undefined || inNodeModules(folder)) continue;
      files.push(input);
      linked.add(folder);
    }
    this.files = files;
    this.fileSet = new Set(files);
    this.linkedFolders = linked;
    const outside = new Set<string>();
    for (const file of files) {
      const folder = outsideFolder(scope.root, file);
      if (folder !== undefined) outside.add(folder);
    }
    this.directories = new Set([...watchedDirectories(scope.root, files, outside), ...scope.descend ?? []]);
  }

  /** Whether the file is one of the inputs it stats. */
  has(file: string): boolean {
    return this.fileSet.has(file);
  }

  snapshot(): InputSnapshot {
    const files = new Map<string, string>();
    for (const file of this.files) files.set(file, signature(file, this.reader));
    const folders = new Map<string, readonly string[]>();
    const visit = (directory: string): void => {
      if (folders.has(directory)) return;
      const listed = readFolder(directory, this.reader);
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

/** The real path of a folder, or undefined when it does not exist or cannot be followed: a probe that missed, or a link that leads nowhere. */
function realPath(folder: string): string | undefined {
  try {
    return fs.realpathSync.native(folder);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR') || hasErrorCode(error, 'ELOOP') || hasErrorCode(error, 'EACCES')) return undefined;
    throw error;
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
 * What the next scan compares with after a run. An edit or a new file made during the run must start the next run, so the
 * baseline of an input is what it was before the run; else what it was when the run first read it; else `missing`, which the next
 * scan reports. A file the run wrote itself takes the signature it has now. A folder's names follow the same order without the
 * last step: a folder neither saw reports all its names.
 */
export class RunBaseline {
  private readonly firstFiles = new Map<string, string>();
  private readonly firstFolders = new Map<string, readonly string[]>();

  constructor(private readonly before: InputSnapshot, private readonly root: string, private readonly reader: InputFiles) {}

  /** Records an input the run reads, and the folders on the way up to the root, unless the scan before the run already holds them. */
  observe(filename: string): void {
    if (!this.before.files.has(filename) && !this.firstFiles.has(filename)) this.firstFiles.set(filename, signature(filename, this.reader));
    for (const directory of foldersAbove(this.root, filename)) {
      if (this.firstFolders.has(directory)) break;
      this.observeFolder(directory);
    }
  }

  /** Records the folder of a source outside the root. */
  observeFolder(directory: string): void {
    if (!this.before.folders.has(directory) && !this.firstFolders.has(directory)) this.recordFolder(directory);
  }

  /** The snapshot to scan against after the run: `current` is the scan taken when the run ended, and `owned` says which files the run wrote. */
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
    this.firstFolders.set(directory, readFolder(directory, this.reader)?.names ?? []);
  }
}

/** How long events settle before a tick looks at the files: an editor's save is a few events, and a tool's write is many. */
const DEBOUNCE_MS = 50;
/** The files a package manager rewrites when it installs. Their change is the only sign of a new install, since no installed file is watched. */
const INSTALL_MARKERS: ReadonlySet<string> = new Set(['.package-lock.json', '.modules.yaml', '.yarn-state.yml', '.yarn-integrity']);
/** The most times `snapshotWatching` scans again after it opens a watcher on a folder it just found. */
const SETTLE_ROUNDS = 4;

export interface InputWatcherOptions {
  /** The folder of the tsconfig, which can change when a run reads a new configuration: the `node_modules` folders from here up are watched for an install. */
  readonly root: () => string;
  /**
   * Looks at the files once a burst of events has settled, and again when events came in during it. `installed` says that a package
   * manager finished an install since the last tick. The loop reports its own failures; a failure that escapes goes to `onError`.
   */
  readonly tick: (installed: boolean) => Promise<void>;
  /** Called with a failure to watch (the error names its fix) or a tick that threw. */
  readonly onError: (error: Error) => void;
  /** Called once when not one folder can be watched: nothing will wake the loop, so it must end. */
  readonly onUnwatchable: () => void;
  /** The folder watches; a test passes a fault here. */
  readonly files?: Pick<InputFiles, 'watch'>;
}

/**
 * Turns file-system events into ticks. It watches folders, each on its own and not recursively: the folders a scan lists, the folders of
 * linked files, and the `node_modules` folders for the install markers. A recursive watch is no choice here: on Linux Node opens one
 * inotify watch for each file and folder under the root, `node_modules` included, which takes seconds and runs out of watches.
 * Events carry no meaning of their own: one marks the loop dirty, and a tick works out from the scan what changed. Ticks never overlap.
 */
export class InputWatcher {
  private readonly folders = new Map<string, fs.FSWatcher>();
  private readonly reported = new Set<string>();
  private installed = false;
  private dirty = false;
  private running = false;
  private closed = false;
  private unwatchable = false;
  private failures = 0;
  /** What the last scan reads, so that an event for an input with a hidden name still counts. */
  private reads: { readonly scan: InputScan; readonly also: ReadonlySet<string> } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: InputWatcherOptions) {}

  /**
   * Watches exactly `folders` besides the install markers, and returns whether it opened a watcher. A change that happens before a
   * watcher opens is not seen, so call it before the scan whose result the next tick compares with.
   */
  sync(folders: Iterable<string>): boolean {
    if (this.closed) return false;
    const wanted = new Map<string, boolean>();
    for (const folder of folders) wanted.set(folder, false);
    for (let directory = this.options.root(); ; directory = path.dirname(directory)) {
      wanted.set(path.join(directory, NODE_MODULES), true);
      if (path.dirname(directory) === directory) break;
    }
    for (const folder of [...this.folders.keys()]) if (!wanted.has(folder)) this.drop(folder);
    let opened = false;
    for (const [folder, markers] of wanted) {
      if (this.folders.has(folder) || !fs.existsSync(folder)) continue;
      const watcher = this.open(folder, markers);
      if (watcher === undefined) continue;
      this.folders.set(folder, watcher);
      opened = true;
    }
    this.checkWatchable();
    return opened;
  }

  /** Scans, watching every folder the scan lists first (and the `also` folders), so that nothing changes unseen between the scan and its watchers. */
  snapshotWatching(scan: InputScan, also: Iterable<string> = []): InputSnapshot {
    const extra = [this.options.root(), ...scan.linkedFolders, ...also];
    this.reads = { scan, also: new Set(extra) };
    let snapshot = scan.snapshot();
    for (let round = 0; round < SETTLE_ROUNDS && this.sync([...extra, ...snapshot.folders.keys()]); round += 1) snapshot = scan.snapshot();
    return snapshot;
  }

  /** Runs a tick now. */
  start(): void {
    this.fire();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const folder of [...this.folders.keys()]) this.drop(folder);
  }

  private drop(folder: string): void {
    this.folders.get(folder)?.close();
    this.folders.delete(folder);
  }

  private open(folder: string, markers: boolean): fs.FSWatcher | undefined {
    try {
      const watcher = (this.options.files ?? realInputFiles).watch(folder, (event, name) => { this.seen(folder, markers, event, name === null ? undefined : String(name)); });
      watcher.on('error', (error) => {
        this.drop(folder);
        // Windows reports a deleted folder as an error of its watcher: the folder is gone, and the next sync finds out whether it came back.
        if ((hasErrorCode(error, 'EPERM') || hasErrorCode(error, 'ENOENT')) && !fs.existsSync(folder)) this.request(false);
        else {
          this.cannotWatch(folder, error);
          this.checkWatchable();
        }
      });
      return watcher;
    } catch (error) {
      // A folder that vanished since the stat is the next sync's to find.
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
      this.cannotWatch(folder, error);
      return undefined;
    }
  }

  /** The file system could not watch a folder (no watches left, too many open files, a file system without events): say so once for each kind, with the fix. */
  private cannotWatch(folder: string, error: unknown): void {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    this.failures += 1;
    if (this.reported.has(code)) return;
    this.reported.add(code);
    const fix = code === 'ENOSPC'
      ? 'raise fs.inotify.max_user_watches (Linux) or watch fewer folders'
      : code === 'EMFILE' ? 'raise the open-file limit (ulimit -n)' : 'run golem on a file system that reports file events';
    this.options.onError(new Error(`golem cannot watch ${folder} (${code}): ${errorMessage(error)}\nChanges there are not seen until it can; to fix: ${fix}.`, { cause: error }));
  }

  /** Not one folder is watched although some failed to open: the loop would sleep forever, so it is told to end. */
  private checkWatchable(): void {
    if (this.unwatchable || this.closed || this.failures === 0 || this.folders.size > 0) return;
    this.unwatchable = true;
    this.options.onError(new Error('golem cannot watch any folder, so it stops.'));
    this.options.onUnwatchable();
  }

  /** An event in a watched folder. A hidden file or an editor's temporary file is no input, and the markers are the only names that count in a `node_modules` folder. */
  private seen(folder: string, markers: boolean, event: string, name: string | undefined): void {
    if (markers) {
      if (name !== undefined && INSTALL_MARKERS.has(name)) this.request(true);
      return;
    }
    if (name === undefined) {
      this.request(false);
      return;
    }
    // A folder deleted and created again is a new folder, and the watcher of the old one no longer sees it: the next sync opens another.
    // The folder says so itself, by its own name, and so does the folder above it.
    const child = path.join(folder, name);
    const gone = event === 'rename' ? [child, ...name === path.basename(folder) ? [folder] : []].filter((candidate) => this.folders.has(candidate)) : [];
    for (const candidate of gone) this.drop(candidate);
    if (gone.length > 0 || !isIgnoredName(name) || this.reads?.scan.has(child) || this.reads?.also.has(child)) this.request(false);
  }

  /** Asks for a tick after the debounce, or after the tick that runs. */
  request(installed = false): void {
    if (this.closed) return;
    this.installed ||= installed;
    if (this.running) this.dirty = true;
    else this.timer ??= setTimeout(() => { this.timer = undefined; this.fire(); }, DEBOUNCE_MS);
  }

  private fire(): void {
    if (this.closed || this.running) return;
    this.running = true;
    this.dirty = false;
    const installed = this.installed;
    this.installed = false;
    this.options.tick(installed).catch((error: unknown) => { this.options.onError(error instanceof Error ? error : new Error(errorMessage(error))); }).finally(() => {
      this.running = false;
      if (this.dirty) this.request(false);
    });
  }
}
