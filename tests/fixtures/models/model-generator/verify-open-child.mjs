import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/parent.model.generated.js';

const parent = requireObjectCodec(process.argv[2]);
// The opt-in model validates its own fields.
// The child's model schema holds a Date where its wire schema holds a string, and the parent validates the model form.
assert.equal(parent.validate({ name: 'ab', child: { count: 2, at: new Date(0) } }), false);
assert.equal(parent.validate({ name: 'abc', child: { count: 2, at: new Date(0) } }), true);
// The nested default model stays open: its odd count breaks the TValidation function, which nothing runs.
assert.equal(parent.validate({ name: 'abc', child: { count: 3, at: new Date(0) } }), true);

// The nested default model parses without checks, refuses validate (as an option too), and still publishes its schemas (Nest reads them for query shapes).
const child = requireObjectCodec(process.argv[3]);
const unavailable = (error) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable;
const wire = '{"count":3,"at":"1970-01-01T00:00:00.000Z"}';
assert.deepEqual(child.parse(wire), { count: 3, at: new Date(0) });
assert.throws(() => child.parse(wire, { validate: true }), unavailable);
assert.throws(() => child.validate({ count: 3, at: new Date(0) }), unavailable);
assert.equal(typeof child.schema, 'object');
assert.equal(typeof child.wireSchema, 'object');
