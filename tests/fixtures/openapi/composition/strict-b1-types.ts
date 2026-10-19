import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { x: 'q' } });
const n: undefined = visit.m.n;

void n;
