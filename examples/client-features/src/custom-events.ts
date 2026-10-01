// #region custom-events
import { PaymentsClient } from '../sdk/index.js';

// This API sends one integer per line: "7\n8\n" → { id: 7 }, { id: 8 }.
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
      for (const line of lines) yield { id: Number(line) };
    }
    if (pending) yield { id: Number(pending) };
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export function paymentsClient(baseUrl: string) {
  return new PaymentsClient({
    baseUrl,
    streamDecoders: { 'application/vnd.example.events': decodeEventIds },
  });
}

export async function firstEventId(baseUrl: string) {
  const response = await paymentsClient(baseUrl).readEventIds().execute({});
  for await (const event of response.body) {
    return event.id; // First line "7" returns 7 and closes the stream.
  }
}
// #endregion custom-events
