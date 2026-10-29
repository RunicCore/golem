import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ a: 'x', b: '2024-05-07T08:09:10.000Z' });
const a: string | undefined = derived.a;
const b: Date | undefined = derived.b;

void a; void b;
