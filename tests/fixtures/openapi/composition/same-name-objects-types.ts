import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { o: { b: 'x' } } });
const at: Date | undefined = visit.m.o?.at;
const b: string | undefined = visit.m.o?.b;
const when: Date | undefined = visit.m.o?.when;

void at; void b; void when;
