import type { ChildProcess } from 'node:child_process';

/** What an observer sees of one scanned file: the edits the rewrite will apply, each with the text it expects at its place. */
export interface ScannedFile {
  readonly edits: readonly { readonly expect: string }[];
}

/**
 * What a test can watch or fault in the compiler sessions and the scanner of its own process. It is internal, like the `files`
 * option of `watchPipeline`: no user API names it and no document describes it. Every method is optional, and a process with no
 * observer pays one empty-set check at each place that reports.
 */
export interface ToolingObserver {
  /** A compiler session opened a program. `session` is the same object for every program of one session. */
  programOpened?(session: object, options: { readonly configFile?: string | undefined }): void;
  /** A compiler session was told which inputs changed on disk. */
  inputsChanged?(session: object, filenames: readonly string[]): void;
  /** A compiler session was disposed. */
  sessionDisposed?(session: object): void;
  /** The TypeScript 7 lane started a compiler process; undefined when this TypeScript build keeps the process out of reach. */
  compilerStarted?(compiler: ChildProcess | undefined): void;
  /** A session is about to send a snapshot request. The function it returns, if any, runs when the request ends, also by an exception. */
  snapshotRequested?(request: unknown): (() => void) | void;
  /** The compiler process was killed and its API closed. An exception thrown here is the close's own failure. */
  compilerClosed?(compiler: ChildProcess | undefined): void;
  /** The scanner scanned one file; the result returned, if any, replaces the scanner's own. */
  fileScanned?(result: ScannedFile): ScannedFile | void;
}

const observers = new Set<ToolingObserver>();

/** Registers `observer` until the returned handle is disposed. */
export function observeTooling(observer: ToolingObserver): Disposable {
  observers.add(observer);
  return { [Symbol.dispose]: () => { observers.delete(observer); } };
}

/** The calls the tooling makes to the registered observers. */
export const observed = {
  programOpened(session: object, options: { readonly configFile?: string | undefined }): void {
    for (const observer of observers) observer.programOpened?.(session, options);
  },
  inputsChanged(session: object, filenames: readonly string[]): void {
    for (const observer of observers) observer.inputsChanged?.(session, filenames);
  },
  sessionDisposed(session: object): void {
    for (const observer of observers) observer.sessionDisposed?.(session);
  },
  compilerStarted(compiler: ChildProcess | undefined): void {
    for (const observer of observers) observer.compilerStarted?.(compiler);
  },
  /** Runs `send` between the observers' `snapshotRequested` and the end functions they returned. */
  snapshotRequest<T>(request: unknown, send: () => T): T {
    const ends: (() => void)[] = [];
    for (const observer of observers) {
      const end = observer.snapshotRequested?.(request);
      if (end) ends.push(end);
    }
    try {
      return send();
    } finally {
      for (const end of ends) end();
    }
  },
  compilerClosed(compiler: ChildProcess | undefined): void {
    for (const observer of observers) observer.compilerClosed?.(compiler);
  },
  /** An observer's replacement has the shape of the result it replaces. */
  fileScanned<Result extends ScannedFile>(result: Result): Result {
    let current = result;
    for (const observer of observers) current = (observer.fileScanned?.(current) ?? current) as Result;
    return current;
  },
};
