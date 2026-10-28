import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientRuntime, type RuntimeResponseContract } from '@exprtlabs/golem/client';
import { responseCheck } from '@exprtlabs/golem/validation';

const RS = '\u001e';
const NO_VALIDATORS = undefined;
const runtime = new ClientRuntime('Streams', { baseUrl: 'https://api.test' });

type StreamFraming = 'json-seq' | 'sse' | 'ndjson';

interface DecodedStream {
  body: AsyncIterable<unknown>;
}

interface ObservedResponse {
  readonly response: Response;
  readonly cancelled: () => boolean;
  readonly locked: () => boolean;
}

// A source stream that records whether the runtime cancelled it or still holds its reader.
// A `hanging` source never closes, so only an explicit cancel ends it.
function observed(contentType: string, chunks: readonly Uint8Array[], mode: 'closed' | 'hanging'): ObservedResponse {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (mode === 'closed') controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(source, { status: 200, headers: { 'content-type': contentType } }),
    cancelled: () => cancelled,
    locked: () => source.locked,
  };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const streamContract = (contentType: string, framing: StreamFraming): RuntimeResponseContract => ({
  status: '200', content: [{ contentType, framing }], headers: [],
});

async function readBody(response: Response, contentType: string, framing: StreamFraming): Promise<AsyncIterable<unknown>> {
  const result = await runtime.readResponse<DecodedStream>(
    'readStream', response, [streamContract(contentType, framing)], NO_VALIDATORS);
  return result.body;
}

async function collect(body: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of body) items.push(item);
  return items;
}

async function drainExpectingNoItems(body: AsyncIterable<unknown>): Promise<void> {
  for await (const item of body) assert.equal(item, undefined);
}

test('JSON-seq reads RS-framed multiline records across chunks and ignores consecutive RS', async () => {
  const bytes = encode(`${RS}{\n  "id": 1\n}\n${RS}${RS}{"id":2}\n`);
  const source = observed('application/json-seq', [bytes.slice(0, 8), bytes.slice(8)], 'closed');
  const body = await readBody(source.response, 'application/json-seq', 'json-seq');
  assert.deepEqual(await collect(body), [{ id: 1 }, { id: 2 }]);
  assert.equal(source.locked(), false, 'reader lock is released after EOF');
});

test('JSON-seq rejects truncated primitives at EOF and malformed records, cancelling the reader', async () => {
  const truncated = observed('application/json-seq', [encode(`${RS}1`)], 'closed');
  await assert.rejects(
    async () => drainExpectingNoItems(await readBody(truncated.response, 'application/json-seq', 'json-seq')),
    /Malformed JSON text sequence|truncated/,
  );
  assert.equal(truncated.cancelled(), false, 'EOF on a closed source does not cancel the underlying stream');
  assert.equal(truncated.locked(), false, 'reader lock is released after malformed EOF');

  const malformed = observed('application/json-seq', [encode(`${RS}{not-json}\n${RS}`)], 'hanging');
  await assert.rejects(
    async () => drainExpectingNoItems(await readBody(malformed.response, 'application/json-seq', 'json-seq')),
    /Malformed JSON text sequence/,
  );
  assert.equal(malformed.cancelled(), true);
  assert.equal(malformed.locked(), false, 'reader lock is released after malformed JSON');

  const missingRs = observed('application/json-seq', [encode(`{"id":1}\n${RS}`)], 'hanging');
  await assert.rejects(
    async () => drainExpectingNoItems(await readBody(missingRs.response, 'application/json-seq', 'json-seq')),
    /RS|JSON text sequence/,
  );
  assert.equal(missingRs.cancelled(), true);
  assert.equal(missingRs.locked(), false, 'reader lock is released after missing RS');

  const invalidUtf8 = observed('application/json-seq', [Uint8Array.from([0x1e, 0x22, 0xc3, 0x22, 0x1e])], 'hanging');
  await assert.rejects(
    async () => drainExpectingNoItems(await readBody(invalidUtf8.response, 'application/json-seq', 'json-seq')),
    /The encoded data was not valid for encoding utf-8/,
  );
  assert.equal(invalidUtf8.cancelled(), true);
  assert.equal(invalidUtf8.locked(), false, 'reader lock is released after invalid UTF-8');

  const noRs = observed('application/json-seq', [encode('{}\n')], 'closed');
  await assert.rejects(
    async () => drainExpectingNoItems(await readBody(noRs.response, 'application/json-seq', 'json-seq')),
    /requires an RS before the first record/,
  );
  assert.equal(noRs.locked(), false, 'reader lock is released after a body with no RS at all');
});

test('JSON-seq reads single-byte chunks, buffering a split multi-byte UTF-8 character', async () => {
  const bytes = encode(`${RS}{\n  "label": "café"\n}\n`);
  const source = observed('application/json-seq', Array.from(bytes, (byte) => Uint8Array.of(byte)), 'closed');
  const body = await readBody(source.response, 'application/json-seq', 'json-seq');
  assert.deepEqual(await collect(body), [{ label: 'café' }]);
});

test('JSON-seq yields delimited numbers, booleans and null, and an empty stream yields nothing', async () => {
  const values = await readBody(
    observed('application/json-seq', [encode(`${RS}1\n${RS}true\n${RS}null\n`)], 'closed').response,
    'application/json-seq',
    'json-seq',
  );
  assert.deepEqual(await collect(values), [1, true, null]);

  const empty = await readBody(observed('application/json-seq', [], 'closed').response, 'application/json-seq', 'json-seq');
  assert.deepEqual(await collect(empty), []);
});

test('breaking a live stream cancels the source and releases the reader, with and without item validators', async () => {
  const pass = (): readonly [] => [];
  const validators = { input: pass, responses: new Map([['200:application/x-ndjson', pass]]) };
  for (const [label, check] of [['no validators', NO_VALIDATORS], ['item validators', responseCheck(validators)]] as const) {
    const source = observed('application/x-ndjson', [encode('{"id":1}\n')], 'hanging');
    const result = await runtime.readResponse<DecodedStream>(
      'readStream', source.response, [streamContract('application/x-ndjson', 'ndjson')], check);
    const iterator = result.body[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: { id: 1 }, done: false });
    await iterator.return?.();
    assert.equal(source.cancelled(), true, `${label}: the source is cancelled on early return`);
    assert.equal(source.locked(), false, `${label}: the reader lock is released on early return`);
  }
});

test('aborting the signal while an NDJSON stream is read surfaces the abort and releases the source', async () => {
  const controller = new AbortController();
  let locked = () => false;
  const source = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(encode('{"id":1}\n'));
      // A fetch response body errors with the signal's reason when the request is aborted.
      controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason));
    },
  });
  locked = () => source.locked;
  const response = new Response(source, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  const iterator = (await readBody(response, 'application/x-ndjson', 'ndjson'))[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: { id: 1 }, done: false });
  controller.abort(new DOMException('Activity feed closed', 'AbortError'));
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(locked(), false, 'the reader lock is released after the abort');
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

const readEvents = async (chunks: readonly (string | Uint8Array)[]): Promise<unknown[]> => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk);
      controller.close();
    },
  });
  const response = new Response(source, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return collect(await readBody(response, 'text/event-stream', 'sse'));
};

test('SSE: a CRLF split across chunks does not dispatch early, and a partial event at EOF is dropped', async () => {
  assert.deepEqual(await readEvents(['data: a\r', '\ndata: b\r\n\r\n', 'data: partial']), [{ data: 'a\nb' }]);
});

test('SSE: a data-less event discards its type and the next event does not inherit it', async () => {
  assert.deepEqual(await readEvents(['event: ping\n\n', 'data: x\n\n']), [{ data: 'x' }]);
});

test('SSE: a multi-byte UTF-8 character split across chunks decodes intact inside a data line and before a line boundary', async () => {
  const splitAt = (text: string, marker: string, offset: number): Uint8Array[] => {
    const bytes = encode(text);
    const cut = encode(text.slice(0, text.indexOf(marker))).length + offset;
    return [bytes.slice(0, cut), bytes.slice(cut)];
  };
  assert.deepEqual(await readEvents(splitAt('data: 1€2\n\n', '€', 1)), [{ data: '1€2' }]);
  assert.deepEqual(await readEvents(splitAt('data: 😀\r\n\r\n', '😀', 3)), [{ data: '😀' }]);
  assert.deepEqual(await readEvents([...splitAt('data: €', '€', 2), '\n\n']), [{ data: '€' }]);
});

test('SSE: a CR at the end of the stream still ends the blank line that dispatches', async () => {
  assert.deepEqual(await readEvents(['data: a\n', '\r']), [{ data: 'a' }]);
});

test('SSE: each event is a new plain object with its fields in dispatch order, and a retry beyond a double reads as null', async () => {
  const events = await readEvents([
    'id: 7\nevent: settled\nretry: 1500\ndata: one\n\n',
    'data: two\n\n',
    `retry: ${'9'.repeat(400)}\ndata: three\n\n`,
  ]) as Record<string, unknown>[];
  assert.deepEqual(events, [
    { data: 'one', event: 'settled', id: '7', retry: 1500 },
    // The last event id carries over; the retry belonged to the first event.
    { data: 'two', id: '7' },
    { data: 'three', id: '7', retry: null },
  ]);
  assert.deepEqual(Object.keys(events[0]), ['data', 'event', 'id', 'retry']);
  assert.equal(Object.getPrototypeOf(events[0]), Object.prototype);
  assert.notEqual(events[0], events[1]);
});

test('NDJSON and SSE records split into single-byte chunks decode whole, with CRLF line ends and a multi-byte character', async () => {
  // protects: bug the framing re-split the whole buffer on every chunk, quadratic for one long record
  const bytewise = (text: string): Uint8Array[] => [...encode(text)].map((byte) => Uint8Array.of(byte));
  const long = 'x'.repeat(3000);
  const ndjson = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytewise(`{"v":"${long}€"}\r\n\r\n{"v":2}\r\n{"v":3}`)) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  assert.deepEqual(await collect(await readBody(ndjson, 'application/x-ndjson', 'ndjson')), [{ v: `${long}€` }, { v: 2 }, { v: 3 }]);
  assert.deepEqual(
    await readEvents(bytewise(`data: ${long}€\r\ndata: tail\r\n\r\nevent: e\r\ndata: 2\r\n\r\n`)),
    [{ data: `${long}€\ntail` }, { event: 'e', data: '2' }],
  );
  assert.deepEqual(await collect(await readBody(
    observed('application/json-seq', bytewise(`${RS}{"a":"${long}"}\n${RS}[1]\n`), 'closed').response, 'application/json-seq', 'json-seq')), [{ a: long }, [1]]);
});
