/**
 * The names of the `node:diagnostics_channel` channels the compiler sessions publish to. They are internal, for golem's own tests,
 * and carry no promise of stability. A message is an object; `session` is the same object for every program of one session.
 */
export const GOLEM_CHANNELS = {
  /** `{ session, configFile }`: a session is about to open a program. */
  programOpened: 'golem:program-opened',
  /** `{ session, filenames }`: a host told a session which inputs changed on disk. */
  inputsChanged: 'golem:inputs-changed',
  /** `{ session }`: a session is disposed. */
  sessionDisposed: 'golem:session-disposed',
  /** `{ compiler }`: the TypeScript 7 lane started a compiler process (undefined when that build keeps it out of reach). */
  compilerStarted: 'golem:compiler-started',
  /** `{ compiler }`: the compiler process was killed and its API closed, also when closing the API threw. */
  compilerClosed: 'golem:compiler-closed',
  /** `{ request }`: the TypeScript 7 checker is about to ask the compiler `typeToString` or `isTypeAssignableTo`, because its memo holds no answer. The TypeScript 6 lane has no memo and publishes nothing. */
  checkerRequested: 'golem:checker-requested',
  /** `{ request }`: the TypeScript 7 lane is about to send a snapshot request. */
  snapshotRequested: 'golem:snapshot-requested',
  /** `{ request }`: that request has ended, also by an exception. */
  snapshotSettled: 'golem:snapshot-settled',
} as const;
