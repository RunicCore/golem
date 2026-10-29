import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { LibError } from '@exprtlabs/golem/errors';
import type { GeneratedModelConstructor } from '@exprtlabs/golem/model';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './helpers.js';
import { modelCodec } from '../support/model-codec.js';

function isGeneratedModelConstructor(value: unknown): value is GeneratedModelConstructor {
  return typeof value === 'function';
}

function scalarOrTupleDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'ScalarOrTuple', version: '1' },
    paths: {
      '/schedules': {
        get: {
          operationId: 'getSchedule',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Schedule' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Schedule: {
          type: 'object',
          additionalProperties: false,
          required: ['when'],
          properties: {
            when: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'array',
                  prefixItems: [{ type: 'string', format: 'date-time' }],
                  items: false,
                },
              ],
            },
          },
        },
      },
    },
  };
}

test('a oneOf of a string and a tuple converts the tuple by item and keeps the string', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-scalar-or-tuple-'), 'sdk');
  await generateMaterializedSdk(scalarOrTupleDocument(), {
    output,
    name: 'ScalarOrTuple',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated schedule models',
  );
  const ScheduleModel = models.ScheduleModel;
  assert.ok(isGeneratedModelConstructor(ScheduleModel));

  const plain = modelCodec(ScheduleModel).fromWireFormat({ when: 'plain' });
  assert.deepEqual(modelCodec(plain).toWireFormat(plain), { when: 'plain' });
  const dated = modelCodec(ScheduleModel).fromWireFormat({ when: ['2024-05-06T07:08:09.000Z'] });
  assert.deepEqual(Reflect.get(dated, 'when'), [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(modelCodec(dated).toWireFormat(dated), { when: ['2024-05-06T07:08:09.000Z'] });

  assert.throws(
    () => modelCodec(ScheduleModel).fromWireFormat({ when: ['not a date'] }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.deepEqual(error.issues[0]?.path, ['when', 0]);
      return true;
    },
  );
});
