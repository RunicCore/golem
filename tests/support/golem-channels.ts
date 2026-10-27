import diagnostics from 'node:diagnostics_channel';
import type { TestContext } from 'node:test';

/** Subscribes to a `golem:` diagnostics channel until the test ends; the returned function unsubscribes sooner. */
export function subscribe<Message>(t: TestContext, name: string, onMessage: (message: Message) => void): () => void {
  const listener = (message: unknown): void => onMessage(message as Message);
  diagnostics.subscribe(name, listener);
  const unsubscribe = (): void => { diagnostics.unsubscribe(name, listener); };
  t.after(unsubscribe);
  return unsubscribe;
}
