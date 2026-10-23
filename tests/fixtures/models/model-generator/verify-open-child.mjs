import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/parent.model.generated.js';

const parent = requireObjectCodec(process.argv[2]);
// The opt-in model validates its own fields.
assert.equal(parent.validate({ name: 'ab', child: { count: 2 } }), false);
assert.equal(parent.validate({ name: 'abc', child: { count: 2 } }), true);
// The nested default model stays open: its odd count breaks the TValidation function, which nothing runs.
assert.equal(parent.validate({ name: 'abc', child: { count: 3 } }), true);

// The nested default model parses without checks, refuses validate (as an option too), and still publishes its schemas (Nest reads them for query shapes).
const child = requireObjectCodec(process.argv[3]);
const unavailable = (error) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable;
assert.deepEqual(child.parse('{"count":3}'), { count: 3 });
assert.throws(() => child.parse('{"count":3}', { validate: true }), unavailable);
assert.throws(() => child.validate({ count: 3 }), unavailable);
assert.equal(typeof child.schema, 'object');
assert.equal(typeof child.wireSchema, 'object');
