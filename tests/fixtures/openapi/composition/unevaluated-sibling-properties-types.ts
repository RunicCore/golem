import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ a: 'x', b: 'y', c: 'z' });
const a: string | undefined = derived.a;
const b: string | undefined = derived.b;
const c: string | undefined = derived.c;

void a; void b; void c;
