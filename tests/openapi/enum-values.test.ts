import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { generatedCodecIdFromRoot } from '../support/consumer.js';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import {
  compileGeneratedSdk,
  documentBase,
  generateMaterializedSdk,
  importGeneratedModule,
} from './helpers.js';

test('a model field limited by enum, with or without type, rejects a value outside the list', async t => {
  // protects: T-644 an enum with no type, or with a type, limits a model field to its listed values
  const output = path.join(createFixtureProject(t, 'golem-openapi-enum-values-'), 'sdk');
  const document = documentBase('3.1.0', {
    components: { schemas: {
      Ticket: {
        type: 'object',
        required: ['rank', 'mark', 'level', 'label'],
        properties: {
          rank: { enum: [1, 2, 3] },
          mark: { enum: ['low', 'high'] },
          level: { type: 'integer', enum: [1, 2, 3] },
          label: { type: 'string', enum: ['a', 'b'] },
        },
      },
    } },
    paths: { '/tickets': { post: {
      operationId: 'echo',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } } },
    } } },
  });
  await generateMaterializedSdk(document, { output, name: 'Enums', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const models = await importGeneratedModule(output, 'enum models');
  const TicketModel = models.TicketModel as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const construct = TicketModel as unknown as abstract new (values?: never) => object;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Ticket'));
  const body = { rank: 2, mark: 'high', level: 3, label: 'b' };
  assert.equal(await getValidator(new TicketModel(body)).validate(), true);
  assert.deepEqual({ ...(codec.fromWireFormat(body, { construct }) as object) }, body);
  for (const [field, value] of [['rank', 4], ['rank', '2'], ['mark', 'mid'], ['level', 4], ['label', 'c']] as const) {
    const bad = { ...body, [field]: value };
    assert.equal(await getValidator(new TicketModel(bad)).validate(), false, `validate ${field} = ${String(value)}`);
    assert.throws(
      () => codec.fromWireFormat(bad, { construct }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
      `decode ${field} = ${String(value)}`,
    );
  }
});
