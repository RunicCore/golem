import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { o: { b: 'x' } } });
const at: Date | undefined = visit.m.o?.at;
const b: string | undefined = visit.m.o?.b;
const when: Date | undefined = visit.m.o?.when;

void at; void b; void when;
