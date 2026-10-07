import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/parent.model.generated.js';

const parent = requireObjectCodec(process.argv[2]);
// The opt-in model validates its own fields.
assert.equal(parent.validate({ name: 'ab', child: { count: 2 } }), false);
assert.equal(parent.validate({ name: 'abc', child: { count: 2 } }), true);
// The nested default model stays open: its odd count breaks the TValidation function, which nothing runs.
assert.equal(parent.validate({ name: 'abc', child: { count: 3 } }), true);
