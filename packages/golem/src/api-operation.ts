import type { ApiOperation, ApiOperationRun } from './client.js';

function warnOverlappingExecute(operationName: string): void {
  try {
    globalThis.console?.warn?.(`Concurrent execute() invocation for ${operationName}`);
  } catch {
    // Logging must not prevent the request.
  }
}

function notifyPending(listener: ((pending: number) => void) | undefined, pending: number): void {
  if (listener === undefined) return;
  try {
    listener(pending);
  } catch {
    // Pending notification must not prevent the request.
  }
}

export function createTrackedApiOperation<Input, Result, Options = unknown>(
  name: string,
  run: ApiOperationRun<Input, Result, Options>,
  onPendingChange?: (pending: number) => void,
): ApiOperation<Input, Result, Options> {
  let pending = 0;
  const operation: ApiOperation<Input, Result, Options> = {
    async execute(input: Input, options?: Options): Promise<Result> {
      if (pending > 0) warnOverlappingExecute(name);
      pending += 1;
      notifyPending(onPendingChange, pending);
      try {
        return await run(input, options);
      } finally {
        pending -= 1;
        notifyPending(onPendingChange, pending);
      }
    },
  };
  return operation;
}
