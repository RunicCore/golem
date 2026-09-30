import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { collectLocalReferenceInputs, generate, readLimitedBody } from '#openapi/generator';
import { writeOpenApiDocument } from './helpers.js';

const remoteSchema = '{"type":"object","required":["currency"],"properties":{"currency":{"type":"string","description":"€"}}}';

function remoteDocument(reference = 'https://schemas.example/money.json'): Record<string, unknown> {
  return {
    openapi: '3.2.0',
    info: { title: 'Remote', version: '1' },
    components: {
      schemas: {
        RemoteAmount: { $ref: reference },
      },
    },
  };
}

async function generateDocument(
  directory: string,
  document: Record<string, unknown>,
  options: {
    allowRemoteRefs?: boolean;
    remoteHosts?: readonly string[];
    maxRefBytes?: number;
    maxRefDocuments?: number;
    refTimeoutMs?: number;
  } = {},
): Promise<void> {
  await generate({
    input: writeOpenApiDocument(directory, document),
    output: path.join(directory, 'sdk'),
    profile: { mobx: false, validation: false },
    allowRemoteRefs: options.allowRemoteRefs ?? true,
    remoteHosts: options.remoteHosts ?? ['schemas.example'],
    maxRefBytes: options.maxRefBytes,
    maxRefDocuments: options.maxRefDocuments,
    refTimeoutMs: options.refTimeoutMs,
  });
}

function mockFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

function streamResponse(
  chunks: readonly Uint8Array[],
  headers: HeadersInit,
  onCancel?: () => void,
  status = 200,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status, headers });
}

function openStreamResponse(
  chunks: readonly Uint8Array[],
  headers: HeadersInit,
  onCancel: () => void,
  status = 200,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, { status, headers });
}

async function generateRemote(t: TestContext, options: {
  maxRefBytes?: number;
  maxRefDocuments?: number;
  refTimeoutMs?: number;
}): Promise<void> {
  const directory = createFixtureProject(t, 'runic-openapi-remote-bytes-');
  await generateDocument(directory, remoteDocument(), options);
}

test('maxRefBytes accepts an exact-limit streamed body and counts UTF-8 bytes, not characters', async (t) => {
  const body = new TextEncoder().encode(remoteSchema);
  assert.ok(body.byteLength > [...remoteSchema].length);
  const restore = mockFetch(async () => streamResponse(
    [body.slice(0, 12), body.slice(12)],
    { 'content-type': 'application/json' },
  ));
  try {
    await generateRemote(t, { maxRefBytes: body.byteLength });
  } finally {
    restore();
  }
  assert.ok([...remoteSchema].length < body.byteLength - 1, 'fixture has multi-byte characters');
  const restoreSmall = mockFetch(async () => streamResponse(
    [body.slice(0, 12), body.slice(12)],
    { 'content-type': 'application/json' },
  ));
  try {
    await assert.rejects(
      generateRemote(t, { maxRefBytes: body.byteLength - 1 }),
      /remote reference exceeds \d+ bytes/,
    );
  } finally {
    restoreSmall();
  }
});

test('maxRefBytes ignores understated Content-Length and cancels on the first exceeding chunk', async (t) => {
  const encoder = new TextEncoder();
  const first = encoder.encode('{"currency":"USD"}');
  const extra = encoder.encode('xxxxxxxx');
  let cancelled = false;
  const restore = mockFetch(async () => openStreamResponse(
    [first, extra],
    { 'content-type': 'application/json', 'content-length': '4' },
    () => {
      cancelled = true;
    },
  ));
  try {
    await assert.rejects(
      () => generateRemote(t, { maxRefBytes: first.byteLength }),
      /exceeds/,
    );
    assert.equal(cancelled, true);
  } finally {
    restore();
  }
});

test('maxRefBytes Content-Length precheck cancels without buffering the body', async (t) => {
  let cancelled = false;
  const restore = mockFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(remoteSchema));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
    });
  });
  try {
    await assert.rejects(
      () => generateRemote(t, { maxRefBytes: 16 }),
      /exceeds/,
    );
    assert.equal(cancelled, true);
  } finally {
    restore();
  }
});

test('HTTP errors cancel the remote response body before rejecting', async (t) => {
  let cancelled = false;
  const restore = mockFetch(async () => openStreamResponse(
    [new TextEncoder().encode('error')],
    { 'content-type': 'application/json' },
    () => {
      cancelled = true;
    },
    503,
  ));
  try {
    await assert.rejects(
      () => generateRemote(t, { maxRefBytes: 1024 }),
      /HTTP 503/,
    );
    assert.equal(cancelled, true);
  } finally {
    restore();
  }
});

test('an enabled remote resolver rejects a disallowed host before making a request', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-remote-host-');
  let requests = 0;
  const restore = mockFetch(async () => {
    requests += 1;
    throw new Error('network must not be reached for a disallowed host');
  });
  try {
    await assert.rejects(
      () => generateDocument(directory, remoteDocument('https://blocked.example/money.json')),
      /remote reference host is not allowed: blocked\.example/,
    );
    assert.equal(requests, 0);
  } finally {
    restore();
  }
});

test('remote reference documents are bounded across a chained reference graph', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-remote-documents-');
  const requests: string[] = [];
  const restore = mockFetch(async (input) => {
    const url = String(input);
    requests.push(url);
    const body = url.endsWith('/one.json')
      ? JSON.stringify({ $ref: 'https://schemas.example/two.json' })
      : remoteSchema;
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    await assert.rejects(
      () => generateDocument(
        directory,
        remoteDocument('https://schemas.example/one.json'),
        { maxRefDocuments: 1 },
      ),
      /reference document limit exceeded \(1\)/,
    );
    assert.deepEqual(requests, ['https://schemas.example/one.json']);
  } finally {
    restore();
  }
});

test('remote redirects are rejected and the resolver requests redirect errors', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-remote-redirect-');
  let requestInit: RequestInit | undefined;
  const restore = mockFetch(async (_input, init) => {
    requestInit = init;
    return new Response('redirected', {
      status: 302,
      headers: { location: 'https://schemas.example/other.json' },
    });
  });
  try {
    await assert.rejects(
      () => generateDocument(directory, remoteDocument()),
      /remote reference returned HTTP 302/,
    );
    assert.equal(requestInit?.redirect, 'error');
  } finally {
    restore();
  }
});

test('local file references cannot escape the input directory by file URL, ../ or symlink', async (t) => {
  const escapes: Record<string, (directory: string, input: string) => Promise<void>> = {
    'a file:// URL during input collection': async (directory, input) => {
      const outside = path.join(directory, 'outside.json');
      writeFileSync(outside, 'not a document');
      const document = {
        openapi: '3.2.0',
        info: { title: 'File escape', version: '1' },
        components: { schemas: { Escaped: { $ref: `file://${outside}` } } },
      };
      const documentPath = path.join(input, 'api.json');
      writeFileSync(documentPath, JSON.stringify(document));
      await collectLocalReferenceInputs(documentPath, document);
    },
    'a ../ parent reference': async (directory, input) => {
      writeFileSync(path.join(directory, 'outside.json'), remoteSchema);
      await generateDocument(input, {
        openapi: '3.2.0',
        info: { title: 'Local parent', version: '1' },
        components: { schemas: { Escaped: { $ref: '../outside.json' } } },
      }, { allowRemoteRefs: false, remoteHosts: [] });
    },
    'a symlink to a file outside': async (directory, input) => {
      const outside = path.join(directory, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'schema.json'), remoteSchema);
      symlinkSync(path.join(outside, 'schema.json'), path.join(input, 'linked.json'));
      await generateDocument(input, {
        openapi: '3.2.0',
        info: { title: 'Local symlink', version: '1' },
        components: { schemas: { Escaped: { $ref: './linked.json' } } },
      }, { allowRemoteRefs: false, remoteHosts: [] });
    },
  };
  for (const [spelling, escape] of Object.entries(escapes)) {
    const directory = createFixtureProject(t, 'runic-openapi-file-escape-');
    const input = path.join(directory, 'input');
    mkdirSync(input);
    await assert.rejects(() => escape(directory, input), /local reference escapes the input directory/, spelling);
  }
});

test('streamed native bodies never fall back to response.text() and past the cap are rejected and cancelled', async () => {
  const body = new TextEncoder().encode(remoteSchema);
  const response = streamResponse([body], { 'content-type': 'application/json' });
  Object.defineProperty(response, 'text', {
    value: () => {
      throw new Error('response.text() must not be used for a streamed body');
    },
  });
  assert.equal(await readLimitedBody(response, body.byteLength, 'https://schemas.example/money.json'), remoteSchema);

  const cap = 8;
  let cancelled = false;
  const overCap = openStreamResponse(
    [new Uint8Array(cap), new Uint8Array(32)],
    { 'content-type': 'application/json' },
    () => {
      cancelled = true;
    },
  );
  await assert.rejects(
    () => readLimitedBody(overCap, cap, 'https://schemas.example/money.json'),
    /exceeds/,
  );
  assert.equal(cancelled, true);
});

test('maxRefBytes timeout is preserved through body read and cancels the reader', { timeout: 2_000 }, async (t) => {
  let cancelled = false;
  // Node's AbortSignal.timeout timer is unref'ed. Keep this deliberately
  // pending mock reader alive until the timeout callback can run.
  const keepAlive = setInterval(() => undefined, 1_000);
  const restore = mockFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    await assert.rejects(
      () => generateRemote(t, { maxRefBytes: 1024, refTimeoutMs: 40 }),
      /timed out|TimeoutError|aborted/i,
    );
    assert.equal(cancelled, true);
  } finally {
    clearInterval(keepAlive);
    restore();
  }
});
