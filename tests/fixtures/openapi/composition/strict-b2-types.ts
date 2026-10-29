import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { a: 'x' } });
const b: undefined = visit.m.b;

void b;
