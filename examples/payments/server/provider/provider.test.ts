import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthorizedClient, createClientWithIdempotencyKey, createMoneyTextClient, createRefreshingClient } from './client.js';
import { createChargeWithAmount, fetchCharge, readCharge, readTwoCharges } from './charges.js';
import { createEventLinesClient, firstEvent, firstEventId, readCaptured, readEvents, readUntilClosed } from './events.js';
import { describeCharge, readSettlementDate } from './settlement.js';
import { PaymentCaptured } from '../src/events/payment-events.model.js';

type Handler = (request: Request) => Response | Promise<Response>;
const base = 'https://provider.test';
const charge = { id: 'charge-1', status: 'pending', money: { amount: '25.00', currency: 'USD' }, createdAt: '2025-01-02T03:04:05Z', settlesOn: '2025-02-01' };

async function withFetch<T>(handler: Handler, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
const ndjson = (text: string) => new Response(text, { headers: { 'content-type': 'application/x-ndjson' } });

test('a bearer token string and a token callback are sent as Authorization', async () => {
  const seen: (string | null)[] = [];
  let token = 'first';
  await withFetch(request => { seen.push(request.headers.get('authorization')); return Response.json([]); }, async () => {
    await createAuthorizedClient(base, 'token-1').listCharges().execute({});
    const operation = createRefreshingClient(base, () => token).listCharges();
    await operation.execute({});
    token = 'refreshed';
    await operation.execute({});
  });
  assert.deepEqual(seen, ['Bearer token-1', 'Bearer first', 'Bearer refreshed']);
});

test('the idempotency key goes on every request from the client', async () => {
  const keys: (string | null)[] = [];
  await withFetch(request => { keys.push(request.headers.get('idempotency-key')); return Response.json([]); }, async () => {
    const client = createClientWithIdempotencyKey(base, 'token-1', 'key-1');
    await client.listCharges().execute({});
    await client.listCharges().execute({});
  });
  assert.deepEqual(keys, ['key-1', 'key-1']);
});

test('a charge reads its settlement date as a Temporal value and writes it back as ISO text', async () => {
  const date = await withFetch(() => Response.json(charge), () => readSettlementDate(createAuthorizedClient(base, 't'), 'charge-1'));
  assert.ok(date instanceof Temporal.PlainDate);
  assert.equal(date.toString(), '2025-02-01');
  assert.deepEqual(describeCharge(), { ...charge, settlesOn: '2025-02-03' });
});

test('a declared 404 is data, an invalid amount is a validation issue, an undeclared status is undefined', async () => {
  await withFetch(() => Response.json({ message: 'No such charge' }, { status: 404 }), async () => {
    assert.equal(await readCharge(createAuthorizedClient(base, 't'), 'x'), 'No such charge');
  });
  await withFetch(() => { throw new Error('the invalid request must not be sent'); }, async () => {
    const issues = await createChargeWithAmount(createAuthorizedClient(base, 't'), '12,50');
    assert.ok(Array.isArray(issues) && issues.some(([, path]) => (path as readonly unknown[]).includes('amount')));
  });
  const log = console.error;
  console.error = () => undefined;
  try {
    await withFetch(() => new Response('boom', { status: 500 }), async () => {
      assert.equal(await fetchCharge(createAuthorizedClient(base, 't'), 'x'), undefined);
    });
  } finally {
    console.error = log;
  }
});

test('one operation serves two requests', async () => {
  const paths: string[] = [];
  await withFetch(request => { paths.push(new URL(request.url).pathname); return Response.json(charge); }, async () => {
    await readTwoCharges(createAuthorizedClient(base, 't'), 'a', 'b');
  });
  assert.deepEqual(paths, ['/charges/a', '/charges/b']);
});

test('the money text codecs write and read the provider format', async () => {
  let sent = '';
  const body = await withFetch(async request => {
    sent = await request.text();
    return new Response('USD 25.00', { status: 201, headers: { 'content-type': 'application/vnd.provider.money' } });
  }, async () => (await createMoneyTextClient(base, 't').createChargeText().execute({ body: { amount: '25.00', currency: 'USD' } })).body);
  assert.equal(sent, 'USD 25.00');
  assert.deepEqual(body, { currency: 'USD', amount: '25.00' });
});

test('NDJSON events arrive one by one and can stop early', async () => {
  await withFetch(() => ndjson('{"id":1}\n{"id":2}\n'), async () => {
    const client = createAuthorizedClient(base, 't');
    assert.deepEqual(await readEvents(client), [1, 2]);
    assert.equal(await firstEvent(client), 1);
  });
});

test('aborting while events are read ends the read', async () => {
  const controller = new AbortController();
  const events = (signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"id":1}\n'));
      signal.addEventListener('abort', () => stream.error(signal.reason));
    },
  }), { headers: { 'content-type': 'application/x-ndjson' } });
  let timer: NodeJS.Timeout | undefined;
  const hardTimeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('the read did not end after abort')), 3000); });
  try {
    // The stub takes the signal that reaches fetch, so the abort ends the stream as a real fetch would.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => events(init?.signal as AbortSignal)) as typeof fetch;
    const read = readUntilClosed(createAuthorizedClient(base, 't'), controller).finally(() => { globalThis.fetch = original; });
    setTimeout(() => controller.abort(), 20);
    assert.deepEqual(await Promise.race([read, hardTimeout]), [1]);
  } finally {
    clearTimeout(timer);
  }
});

test('a custom stream decoder reads integer lines, and event models parse JSON', async () => {
  const lines = () => new Response('7\n8\n', { headers: { 'content-type': 'application/vnd.provider.events' } });
  assert.equal(await withFetch(lines, () => firstEventId(createEventLinesClient(base, 't'))), 7);
  const captured = readCaptured('{"paymentId":"p-1","amount":"25.00"}');
  assert.ok(captured instanceof PaymentCaptured);
  assert.equal(captured.amount, '25.00');
});
