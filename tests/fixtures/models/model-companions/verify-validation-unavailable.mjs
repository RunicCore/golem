import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/a.model.generated.js';

const codec = requireObjectCodec(process.argv[2]);
assert.deepEqual(codec.parse('{"title":""}'), { title: '' });
assert.throws(
  () => codec.parse('{"title":"x"}', { validate: true }),
  (error) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
);
