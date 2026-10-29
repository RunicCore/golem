import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { n: 'a' } });
const n: string | undefined = visit.m.n;

void n;
