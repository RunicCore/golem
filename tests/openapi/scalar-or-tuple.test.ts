import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LibError } from '@exprtlabs/golem/errors';
import { compileGeneratedSdk, generateMaterializedSdk, sdkBodyCodec, withRootOperations } from './helpers.js';

function scalarOrTupleDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'ScalarOrTuple', version: '1' },
    paths: {},
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
  await generateMaterializedSdk(withRootOperations(scalarOrTupleDocument(), 'Schedule'), {
    output,
    name: 'ScalarOrTuple',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });

  const schedule = await sdkBodyCodec(output, 'ScalarOrTuple', 'Schedule');
  assert.deepEqual(await schedule.decode({ when: 'plain' }), { when: 'plain' });
  assert.deepEqual(await schedule.encode({ when: 'plain' }), { when: 'plain' });
  const dated = await schedule.decode({ when: ['2024-05-06T07:08:09.000Z'] });
  assert.deepEqual(dated, { when: [new Date('2024-05-06T07:08:09.000Z')] });
  assert.deepEqual(await schedule.encode(dated), { when: ['2024-05-06T07:08:09.000Z'] });

  await assert.rejects(
    () => schedule.decode({ when: ['not a date'] }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.deepEqual(error.issues[0]?.path, ['when', 0]);
      return true;
    },
  );
});
