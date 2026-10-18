import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/node.model.generated.js';
import './build/link.model.generated.js';

const codec = requireObjectCodec(process.argv[2]);
assert.equal(codec.validate({ next: { node: {} } }), true);
assert.equal(codec.validate({ next: { node: { next: 1 } } }), false);
