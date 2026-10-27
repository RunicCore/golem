import diagnostics from 'node:diagnostics_channel';
import type { TestContext } from 'node:test';
import { GOLEM_CHANNELS } from '#golem/diagnostics-channels';

/** Subscribes to a channel of the compiler sessions, named by its key in `GOLEM_CHANNELS`, until the test ends; the returned function unsubscribes sooner. */
export function subscribe<Message>(t: TestContext, channel: keyof typeof GOLEM_CHANNELS, onMessage: (message: Message) => void): () => void {
  const name = GOLEM_CHANNELS[channel];
  const listener = (message: unknown): void => onMessage(message as Message);
  diagnostics.subscribe(name, listener);
  const unsubscribe = (): void => { diagnostics.unsubscribe(name, listener); };
  t.after(unsubscribe);
  return unsubscribe;
}

/** Counts the questions the TypeScript 7 checker asks the compiler because its memo holds no answer, by method, until the test ends. */
export function countCheckerRequests(t: TestContext): { readonly typeToString: number; readonly isTypeAssignableTo: number } {
  const counts = { typeToString: 0, isTypeAssignableTo: 0 };
  subscribe(t, 'checkerRequested', (message: { readonly request: keyof typeof counts }) => { counts[message.request]++; });
  return counts;
}
