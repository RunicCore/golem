import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { a: 'x' } });
const a: string | undefined = visit.m.a;
const b: string | undefined = visit.m.b;

void a; void b;
