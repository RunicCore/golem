import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { x: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } });
const x: Date | undefined = visit.m.x;
const b: Date | undefined = visit.m.b;

void x; void b;
