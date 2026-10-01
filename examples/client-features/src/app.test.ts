import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PaymentsClient } from '../sdk/index.js';
import { describePayment, readDueDate } from './payment-dates.js';

type Responder = (request: Request) => Response | Promise<Response>;

/** Replaces `fetch` for the body of a test, so the page examples run against a mocked API. */
async function withFetch(responder: Responder, run: (requests: Request[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return responder(request);
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

async function withLog(run: (calls: () => unknown[][]) => Promise<void>): Promise<void> {
  const log = mock.method(console, 'log', () => undefined);
  try {
    await run(() => log.mock.calls.map(call => call.arguments));
  } finally {
    log.mock.restore();
  }
}

function textStream(contentType: string, chunks: readonly string[], signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!signal) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

const money = Response.json({ amount: 25, currency: 'USD' }, { status: 201 });

test('a bearer token string is sent as the Authorization header', async () => {
  await withFetch(() => money.clone(), async requests => {
    await import('./send-payment.js');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.get('authorization'), 'Bearer access-token');
  });
});

test('a token callback is read again for each execute call', async () => {
  await withFetch(() => money.clone(), async requests => {
    await import('./current-token.js');
    assert.deepEqual(requests.map(request => request.headers.get('authorization')), [
      'Bearer first-token',
      'Bearer refreshed-token',
    ]);
  });
});

test('a call without credentials rejects before fetch', async () => {
  await withFetch(() => money.clone(), async requests => {
    const client = new PaymentsClient({ baseUrl: 'https://api.example.com' });
    await assert.rejects(
      client.createPayment().execute({ body: { amount: 25, currency: 'USD' } }),
      /No configured credentials satisfy/,
    );
    assert.equal(requests.length, 0);
  });
});

test('custom body codecs write and read the money text format', async () => {
  const response = () => new Response('USD 25', { status: 201, headers: { 'content-type': 'application/vnd.example.money' } });
  await withFetch(response, async requests => {
    await withLog(async calls => {
      await import('./money-client.js');
      assert.equal(await requests[0].text(), 'USD 25');
      assert.equal(requests[0].headers.get('content-type'), 'application/vnd.example.money');
      assert.deepEqual(calls(), [[{ currency: 'USD', amount: 25 }]]);
    });
  });
});

test('response.body yields each NDJSON item as it is decoded', async () => {
  await withFetch(() => textStream('application/x-ndjson', ['{"id":1}\n', '{"id":2}\n']), async () => {
    await withLog(async calls => {
      await import('./read-events.js');
      assert.deepEqual(calls(), [[1], [2]]);
    });
  });
});

test('breaking out of the loop stops after the first item', async () => {
  await withFetch(() => textStream('application/x-ndjson', ['{"id":1}\n', '{"id":2}\n']), async () => {
    await withLog(async calls => {
      await import('./first-event.js');
      assert.deepEqual(calls(), [[1]]);
    });
  });
});

test('aborting from outside the loop ends reading without a thrown error', async () => {
  await withFetch(request => textStream('application/x-ndjson', [], request.signal), async () => {
    await withLog(async calls => {
      await import('./cancel-events.js');
      assert.deepEqual(calls(), []);
    });
  });
});

test('a custom stream decoder turns integer lines into items', async () => {
  const { firstEventId } = await import('./custom-events.js');
  await withFetch(() => textStream('application/vnd.example.events', ['7\n', '8\n']), async () => {
    assert.equal(await firstEventId('https://api.example.com'), 7);
  });
});

test('dates: temporal reads date fields as Temporal values and writes them back as ISO strings', async () => {
  const client = new PaymentsClient({
    baseUrl: 'https://api.example.com',
    fetchImpl: async () => Response.json({
      id: 'payment-1',
      amount: 25,
      currency: 'USD',
      createdAt: '2025-01-02T03:04:05Z',
      dueOn: '2025-02-01',
    }),
  });
  const due = await readDueDate(client, 'payment-1');
  assert.ok(due instanceof Temporal.PlainDate);
  assert.equal(due.toString(), '2025-02-01');
  assert.deepEqual(describePayment(), {
    id: 'payment-1',
    amount: 25,
    currency: 'USD',
    createdAt: '2025-01-02T03:04:05Z',
    dueOn: '2025-02-01',
  });
});
