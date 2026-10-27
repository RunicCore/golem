import { parse } from '@exprtlabs/golem/serde';
import { ProviderClient } from './sdk/index.js';
import { PaymentCaptured } from '../src/events/payment-events.model.js';

// #region read-events
export async function readEvents(client: ProviderClient): Promise<number[]> {
  // Provider response: {"id":1} followed by a newline, then {"id":2}.
  const response = await client.readEvents().execute({});
  const ids: number[] = [];
  for await (const event of response.body) {
    ids.push(event.id); // 1, then 2 as those items arrive.
  }
  return ids;
}
// #endregion read-events

// #region first-event
export async function firstEvent(client: ProviderClient): Promise<number | undefined> {
  const response = await client.readEvents().execute({});
  for await (const event of response.body) {
    return event.id; // Returning closes the iterator and cancels its reader.
  }
}
// #endregion first-event

// #region cancel-events
export async function readUntilClosed(client: ProviderClient, controller: AbortController): Promise<number[]> {
  const response = await client.readEvents().execute({}, { signal: controller.signal });
  const ids: number[] = [];
  try {
    for await (const event of response.body) ids.push(event.id);
  } catch (error) {
    if (!controller.signal.aborted) throw error; // controller.abort() ends the read, for example when the feed closes.
  }
  return ids;
}
// #endregion cancel-events

// #region custom-events
// This provider sends one integer per line: "7\n8\n" → { id: 7 }, { id: 8 }.
function eventOf(line: string) {
  const id = Number(line);
  if (!Number.isInteger(id)) throw new TypeError(`Expected an integer event id, got "${line}"`);
  return { id };
}

async function* decodeEventIds(response: Response) {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += chunk.value; // A line may span several network chunks.
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line !== '') yield eventOf(line);
    }
    if (pending !== '') yield eventOf(pending);
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export function createEventLinesClient(baseUrl: string, token: string) {
  return new ProviderClient({
    baseUrl,
    auth: { bearerAuth: token },
    streamDecoders: { 'application/vnd.provider.events': decodeEventIds },
  });
}

export async function firstEventId(client: ReturnType<typeof createEventLinesClient>) {
  const response = await client.readEventIds().execute({});
  for await (const event of response.body) {
    return event.id; // First line "7" returns 7 and closes the stream.
  }
}
// #endregion custom-events

// #region read-event
export function readCaptured(text: string): PaymentCaptured {
  return parse<PaymentCaptured>(text); // a PaymentCaptured instance from the generated declaration
}
// #endregion read-event
