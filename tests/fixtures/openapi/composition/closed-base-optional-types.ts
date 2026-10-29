import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ a: 'x' });
const b: undefined = derived.b;

void b;
