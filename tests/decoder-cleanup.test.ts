import { LibError, LibErrorKind, IssueSource } from '@exprtlabs/golem/errors';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  compileStrictUnusedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
} from './openapi/helpers.js';

interface OpenResponseCase {
  readonly name: string;
  readonly operation: string;
  readonly declaredContentType: string;
  readonly wireContentType: string;
  readonly content: Record<string, unknown>;
  readonly decoderOption?: 'responseDecoders' | 'streamDecoders';
  readonly decoderContentType?: string;
  readonly decoderFailure?: 'sync' | 'async' | 'validation';
  readonly validationProfiles?: readonly boolean[];
  readonly cancelFailure?: boolean;
}

const decoderCases: readonly OpenResponseCase[] = [
  {
    name: 'ResponseDecoder',
    operation: 'readValue',
    declaredContentType: 'application/json',
    wireContentType: 'application/json',
    content: { schema: { type: 'object' } },
    decoderOption: 'responseDecoders',
    decoderFailure: 'async',
    cancelFailure: true,
  },
  {
    name: 'StreamDecoder',
    operation: 'readEvents',
    declaredContentType: 'application/x-ndjson',
    wireContentType: 'application/x-ndjson',
    content: { itemSchema: { type: 'object' } },
    decoderOption: 'streamDecoders',
    decoderFailure: 'sync',
  },
  {
    name: 'ProtocolMismatch',
    operation: 'readMismatchedValue',
    declaredContentType: 'application/json',
    wireContentType: 'text/plain',
    content: { schema: { type: 'object' } },
  },
  {
    name: 'ActualMediaStreamDecoder',
    operation: 'readActualMediaEvents',
    declaredContentType: '*/*',
    wireContentType: 'application/x-events',
    content: { itemSchema: { type: 'object' } },
    decoderOption: 'streamDecoders',
    decoderContentType: 'application/x-events',
    decoderFailure: 'sync',
  },
  {
    name: 'ValidationFailure',
    operation: 'readValidatedValue',
    declaredContentType: 'application/json',
    wireContentType: 'application/json',
    content: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
    decoderOption: 'responseDecoders',
    decoderFailure: 'validation',
    validationProfiles: [true],
  },
];

test('decoder failures cancel an unconsumed generated response body', async t => {
  const name = 'DecoderCleanup';
  for (const validation of [false, true]) {
    const root = mkdtempSync(path.join(tmpdir(), `runic-decoder-cleanup-${validation ? 'validated' : 'unvalidated'}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, 'sdk');
    await generateMaterializedSdk({
      openapi: '3.2.0',
      info: { title: name, version: '1' },
      paths: Object.fromEntries(decoderCases.map(decoderCase => [`/${decoderCase.name}`, {
        get: {
          operationId: decoderCase.operation,
          responses: {
            200: {
              description: 'response',
              content: { [decoderCase.declaredContentType]: decoderCase.content },
            },
          },
        },
      }])),
    }, {
      output,
      name,
      profile: { mobx: false, validation },
    });
    compileStrictUnusedSdk(output);

    const generated = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist', 'client.js')).href),
      `${name} client`,
    );
    const Client = generated[`${name}Client`];
    assert.ok(isGeneratedClientClass(Client));
    if (!isGeneratedClientClass(Client)) throw new TypeError(`${name}Client`);

    for (const decoderCase of decoderCases) {
      if (decoderCase.validationProfiles && !decoderCase.validationProfiles.includes(validation)) continue;

      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            decoderCase.declaredContentType === 'application/json' ? '{}' : '{"id":1}\n',
          ));
        },
        cancel() {
          cancelled = true;
          if (decoderCase.cancelFailure) throw new Error('cleanup failure');
        },
      });
      t.after(async () => {
        if (!cancelled) await body.cancel().catch(() => undefined);
      });

      const failure = new Error(`${decoderCase.name} failure`);
      const clientOptions: Record<string, unknown> = {
        baseUrl: 'https://example.test',
        fetchImpl: async () => new Response(body, {
          status: 200,
          headers: { 'content-type': decoderCase.wireContentType },
        }),
      };
      if (decoderCase.decoderOption) {
        const decoder = decoderCase.decoderFailure === 'async'
          ? async () => {
            await Promise.resolve();
            throw failure;
          }
          : decoderCase.decoderFailure === 'validation'
            ? () => ({})
            : () => {
              throw failure;
            };
        clientOptions[decoderCase.decoderOption] = {
          [decoderCase.decoderContentType ?? decoderCase.declaredContentType]: decoder,
        };
      }
      const client = new Client(clientOptions);

      await assert.rejects(
        () => client[decoderCase.operation]().execute({}),
        decoderCase.decoderFailure === 'validation'
          ? (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.issues.some(issue => issue.source === IssueSource.OpenAPI)
          : decoderCase.decoderOption
            ? (error: unknown) => error === failure
            : /Undeclared OpenAPI response/,
      );
      assert.equal(cancelled, true, `${decoderCase.name} failure must cancel its response body (validation ${validation})`);
    }
  }
});
