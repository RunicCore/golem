import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ kind: 'cat', at: '2024-05-06T07:08:09.000Z' });
const kind: 'cat' = derived.kind;
const at: Date | undefined = derived.at;

void kind; void at;
